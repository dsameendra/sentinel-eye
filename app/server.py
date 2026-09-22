"""Sentinel Eye web server: UI, settings API, connection test, and a WebSocket proxy to go2rtc."""
import asyncio, re
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import quote, urlparse

import websockets
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import coverage
import db
import hikrelay
import settings as cfg
import timebase
from go2rtc import API_PORT, Go2rtc, desired_streams
from playback_service import PlaybackService

state = {"settings": cfg.load(), "go2rtc": None, "playback": None}


def current() -> cfg.Settings:
    return state["settings"]


@asynccontextmanager
async def lifespan(app):
    g = Go2rtc(current)
    state["go2rtc"] = g
    await run_in_threadpool(g.start)
    p = PlaybackService(current)
    state["playback"] = p
    await run_in_threadpool(p.start)
    yield
    g.stop()
    p.stop()


app = FastAPI(title="Sentinel Eye", lifespan=lifespan)


class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


# ------------------------------------------------------------------ settings

@app.get("/api/settings")
def get_settings():
    return cfg.public(current())


@app.put("/api/settings")
async def put_settings(new: cfg.Settings):
    old = current()
    new = cfg.merge_secrets(new, old)
    if new.connection.encrypted and not new.connection.key:
        raise HTTPException(422, "Enter the verification code, or turn stream encryption off")
    cfg.normalise_order(new)
    streams_changed = (new.connection != old.connection or new.channels != old.channels)
    cfg.save(new)
    state["settings"] = new
    if streams_changed:
        await run_in_threadpool(state["go2rtc"].sync)
    return cfg.public(new)


@app.put("/api/display")
def put_display(d: cfg.Display):
    """Lightweight update for layout / order / quality: never touches the streams."""
    s = current().model_copy(deep=True)
    s.display = d
    cfg.normalise_order(s)
    cfg.save(s)
    state["settings"] = s
    return s.display


# ------------------------------------------------------------------ connection tools

class TestRequest(BaseModel):
    connection: cfg.Connection
    channel: int = 1
    kind: Literal["main", "sub"] = "sub"
    path: str = ""


def _prepared(conn: cfg.Connection) -> dict:
    conn = cfg.merge_secrets(cfg.Settings(connection=conn), current()).connection
    if not conn.host:
        raise HTTPException(422, "Enter the recorder's IP address first")
    return hikrelay.conn_of({"connection": conn.model_dump()})


@app.post("/api/test")
async def test_connection(req: TestRequest):
    conn = _prepared(req.connection)
    path = hikrelay.stream_path(req.channel, req.kind, req.path)
    return await run_in_threadpool(hikrelay.probe, conn, path)


@app.post("/api/discover")
async def discover(req: TestRequest):
    conn = _prepared(req.connection)
    try:
        return {"channels": await run_in_threadpool(hikrelay.discover, conn)}
    except hikrelay.RelayError as e:
        raise HTTPException(400, str(e))


@app.get("/api/status")
async def status():
    g = state["go2rtc"]
    streams = await run_in_threadpool(g.status)
    p = state["playback"]
    return {"go2rtc": bool(streams) or await run_in_threadpool(g.up), "streams": streams,
            "playback": {**p.status, "alertstream_connected": p.subscriber.connected if p.subscriber else False,
                         "last_live_event_utc": p.subscriber.last_event_utc if p.subscriber else None}}


# ------------------------------------------------------------------ playback (timeline: coverage + events)

@app.get("/api/timeline/coverage")
async def timeline_coverage(channel: int, from_day: str, to_day: str):
    """Cached per-day recorded spans for a channel, DVR-local YYYY-MM-DD range."""
    import datetime
    try:
        d0, d1 = datetime.date.fromisoformat(from_day), datetime.date.fromisoformat(to_day)
    except ValueError:
        raise HTTPException(422, "from_day/to_day must be YYYY-MM-DD")
    return await run_in_threadpool(coverage.cached_range, channel, d0, d1)


@app.get("/api/timeline/events")
async def timeline_events(channel: int | None = None, start_utc: str = "", end_utc: str = "", kind: str = "",
                           limit: int = 2000):
    q = "SELECT * FROM events WHERE start_utc <= ? AND end_utc >= ?"
    params = [end_utc or "9999", start_utc or "0000"]
    if channel is not None:
        q += " AND channel=?"
        params.append(channel)
    if kind:
        q += " AND kind=?"
        params.append(kind)
    q += " ORDER BY start_utc LIMIT ?"
    params.append(limit)
    rows = await run_in_threadpool(db.query, q, tuple(params))
    return [dict(r) for r in rows]


@app.get("/api/timeline/calibration")
async def timeline_calibration():
    rows = await run_in_threadpool(db.query, "SELECT * FROM calibration")
    return {r["channel"]: dict(r) for r in rows}


# ------------------------------------------------------------------ WebSocket proxy to go2rtc

@app.websocket("/ws")
async def ws_proxy(ws: WebSocket, src: str):
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)  # cross-site page trying to watch the cameras
        return
    if not re.fullmatch(r"[A-Za-z0-9_]+", src) or src not in desired_streams(current()):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        async with websockets.connect(f"ws://127.0.0.1:{API_PORT}/api/ws?src={quote(src)}", max_size=None) as up:
            async def c2u():
                while True:
                    m = await ws.receive()
                    if m["type"] == "websocket.disconnect":
                        return
                    if m.get("text") is not None:
                        await up.send(m["text"])
                    elif m.get("bytes") is not None:
                        await up.send(m["bytes"])

            async def u2c():
                async for m in up:
                    if isinstance(m, str):
                        await ws.send_text(m)
                    else:
                        await ws.send_bytes(m)

            tasks = [asyncio.create_task(c2u()), asyncio.create_task(u2c())]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in tasks:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


app.mount("/", NoCacheStatic(directory=str(cfg.ROOT / "web"), html=True), name="web")
