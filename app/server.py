"""Sentinel Eye web server: UI, settings API, connection test, and a WebSocket proxy to go2rtc."""
import asyncio, re
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import quote, urlparse

import websockets
from fastapi import FastAPI, HTTPException, Query, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import coverage
import db
import enhance_ai
import export as exportmod
import hikrelay
import playback_session as psess
import settings as cfg
import thumbnails
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
    await run_in_threadpool(exportmod._sweep_old_jobs)  # exports are downloads, not an archive — sweep stale ones on boot too
    await run_in_threadpool(enhance_ai._sweep_old_jobs)  # same reasoning, same TTL pattern, separate job kind
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
async def timeline_events(channel: list[int] | None = Query(None), start_utc: str = "", end_utc: str = "",
                           kind: str = "", limit: int = 2000):
    """`channel` may repeat (?channel=1&channel=3) to fetch several cameras' events in one call — the
    Playback timeline uses this so all selected cameras' events can be shown together, not just the first
    one picked. `limit` still applies to the combined result, same as the single-channel case."""
    q = "SELECT * FROM events WHERE start_utc <= ? AND end_utc >= ?"
    params = [end_utc or "9999", start_utc or "0000"]
    if channel:
        q += f" AND channel IN ({','.join('?' * len(channel))})"
        params.extend(channel)
    if kind:
        q += " AND kind=?"
        params.append(kind)
    # Newest first, then capped — not the other way round. With ORDER BY start_utc ASC (oldest first), a
    # window with more matching rows than `limit` silently keeps the *oldest* slice and drops everything
    # more recent, including all of today whenever an earlier, busier day alone already fills the cap —
    # confirmed directly as the cause of a real "today's events don't show up" report, not a hypothetical.
    # Both callers (events.js, timeline.js) are unaffected by the order itself: events.js re-sorts
    # client-side regardless, and timeline.js positions each event by its own timestamp, not array order.
    q += " ORDER BY start_utc DESC LIMIT ?"
    params.append(limit)
    rows = await run_in_threadpool(db.query, q, tuple(params))
    return [dict(r) for r in rows]


@app.get("/api/timeline/events/{event_id}/thumbnail")
async def event_thumbnail(event_id: int):
    """One JPEG frame near the event's midpoint (spec: represent a multi-second event by its middle, not its
    first instant), generated on demand and cached — see app/thumbnails.py. Uses a real DVR playback session
    like any other, so it's bounded by the same 4-session pool."""
    row = await run_in_threadpool(db.one, "SELECT * FROM events WHERE id=?", (event_id,))
    if row is None:
        raise HTTPException(404, "Unknown event")
    event = dict(row)
    s = current()
    ch = next((c for c in s.channels if c.channel == event["channel"]), None)
    tz = state["playback"].tz
    tz_offset = int(tz.utcoffset(None).total_seconds() // 60) if tz else 330
    try:
        path = await run_in_threadpool(thumbnails.get_or_generate, event, s.connection.model_dump(),
                                        ch.main_path if ch else "", tz_offset)
    except Exception as e:
        raise HTTPException(503, f"Couldn't generate a thumbnail: {e}")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/timeline/calibration")
async def timeline_calibration():
    rows = await run_in_threadpool(db.query, "SELECT * FROM calibration")
    return {r["channel"]: dict(r) for r in rows}


@app.get("/api/playback/pool")
async def playback_pool():
    """How many of the DVR's 4 playback sessions are in use right now (section 7.3)."""
    return {"busy": psess.pool.busy, "limit": psess.pool.limit}


class BookmarkRequest(BaseModel):
    channels: list[str]  # our channel ids (e.g. "c1"), not DVR channel numbers
    time_utc: str
    title: str = ""
    note: str = ""
    severity: str = "info"  # info | warning | critical


@app.post("/api/bookmarks")
async def create_bookmark(req: BookmarkRequest):
    """Bookmark = (time, channels[], title, note, severity, author, created) — spec section 9. No accounts yet
    (that's the rest of M4), so `author` is a placeholder until real sessions exist. Mirrored into the events
    table per channel (kind='bookmark') so it shows up on the timeline and in search for free."""
    s = current()
    chan_nums = [c.channel for c in s.channels if c.id in req.channels]
    if not chan_nums:
        raise HTTPException(422, "No valid channel")
    author = "Operator"
    bid = await run_in_threadpool(db.create_bookmark, chan_nums, req.time_utc, req.title, req.note, req.severity, author)
    for ch in chan_nums:
        await run_in_threadpool(db.upsert_event, "manual", ch, "bookmark", req.time_utc, req.time_utc,
                                 None, None, {"title": req.title, "severity": req.severity, "bookmark_id": bid}, None)
    return {"id": bid, "channels": chan_nums, "author": author}


@app.get("/api/bookmarks")
async def get_bookmarks(channel: int | None = None, start_utc: str = "", end_utc: str = "", limit: int = 500):
    return await run_in_threadpool(db.list_bookmarks, channel, start_utc or None, end_utc or None, limit)


@app.delete("/api/bookmarks/{bookmark_id}")
async def remove_bookmark(bookmark_id: int):
    await run_in_threadpool(db.delete_bookmark, bookmark_id)
    return {"ok": True}


class ExportRequest(BaseModel):
    channels: list[str]
    start_utc: str
    end_utc: str
    package: Literal["signed", "plain"] = "signed"


@app.post("/api/export")
async def create_export(req: ExportRequest):
    """Starts a background export job (spec section 10). Each channel is exported through a real
    PlaybackReader — the DVR's 4-session playback budget applies to exports exactly like a playback pane,
    and shows up in /api/playback/pool while running."""
    import datetime as _dt
    import secrets as _secrets
    s = current()
    chans = [c for c in s.channels if c.id in req.channels]
    if not chans:
        raise HTTPException(422, "No valid channel")
    try:
        start_dt, end_dt = _dt.datetime.fromisoformat(req.start_utc), _dt.datetime.fromisoformat(req.end_utc)
    except ValueError:
        raise HTTPException(422, "start_utc/end_utc must be ISO 8601")
    if end_dt <= start_dt:
        raise HTTPException(422, "end_utc must be after start_utc")
    if (end_dt - start_dt) > _dt.timedelta(hours=2):
        raise HTTPException(422, "Clips are limited to 2 hours per export for now")
    tz = state["playback"].tz
    tz_offset = int(tz.utcoffset(None).total_seconds() // 60) if tz else 330
    channel_dicts = [{**c.model_dump(), "_tz_offset_min": tz_offset} for c in chans]
    job_id = _secrets.token_hex(8)
    exportmod.start_export(job_id, channel_dicts, req.start_utc, req.end_utc, req.package,
                            "Operator", s.connection.model_dump())
    return {"job_id": job_id}


@app.get("/api/export/{job_id}")
async def export_status(job_id: str):
    job = await run_in_threadpool(exportmod.get_job, job_id)
    if job is None:
        raise HTTPException(404, "Unknown export job")
    return job


@app.get("/api/export/{job_id}/download")
async def export_download(job_id: str):
    job = await run_in_threadpool(exportmod.get_job, job_id)
    if job is None or job.get("state") != "done" or not job.get("download"):
        raise HTTPException(404, "That export isn't ready")
    path = exportmod.EXPORT_DIR / job["download"]
    if not path.exists():
        raise HTTPException(404, "That export has expired")
    return FileResponse(path, filename=path.name)


class EnhanceRequest(BaseModel):
    channel: int
    at_utc: str = ""
    mode: Literal["auto", "face", "plate", "general"] = "auto"
    images: list[str]  # base64 PNG, oldest -> newest, 1-7 frames
    roi: list[float] | None = None  # optional [x, y, w, h] fractions (0-1) — crop before enhancing
    weight: float = 0.5  # GFPGAN fidelity (0=free reconstruction, 1=barely touched) — spec section 2d


@app.post("/api/enhance")
async def create_enhance(req: EnhanceRequest):
    """Starts a background AI frame-enhancement job (docs/enhance-ai-spec.md). Frames come from the
    client's already-decoded playback buffer — no DVR session, doesn't touch the 4-session budget."""
    import secrets as _secrets
    if not req.images or len(req.images) > 7:
        raise HTTPException(422, "1-7 frames expected")
    if req.roi is not None and len(req.roi) != 4:
        raise HTTPException(422, "roi must be [x, y, w, h]")
    if not 0.0 <= req.weight <= 1.0:
        raise HTTPException(422, "weight must be between 0 and 1")
    job_id = _secrets.token_hex(8)
    enhance_ai.start_enhance(job_id, req.images, req.mode, req.channel, req.at_utc, req.roi, req.weight)
    return {"job_id": job_id}


@app.get("/api/enhance/{job_id}")
async def enhance_status(job_id: str):
    job = await run_in_threadpool(enhance_ai.get_job, job_id)
    if job is None:
        raise HTTPException(404, "Unknown enhance job")
    return job


@app.get("/api/enhance/{job_id}/result")
async def enhance_result(job_id: str):
    path = await run_in_threadpool(enhance_ai.result_path, job_id)
    if not path:
        raise HTTPException(404, "That enhancement isn't ready")
    return FileResponse(path, media_type="image/png", filename=f"frame_{job_id}_ENHANCED.png")


@app.get("/api/enhance/{job_id}/source")
async def enhance_source(job_id: str):
    path = await run_in_threadpool(enhance_ai.source_path, job_id)
    if not path:
        raise HTTPException(404, "That enhancement isn't ready")
    return FileResponse(path, media_type="image/png", filename=f"frame_{job_id}_source.png")


class OcrRequest(BaseModel):
    which: Literal["result", "source"] = "result"


@app.post("/api/enhance/{job_id}/ocr")
async def enhance_ocr(job_id: str, req: OcrRequest):
    """Optional, on-demand text read (spec 4a) — Tesseract on an image already produced by this job.
    Synchronous: sub-second for a single image, no job/poll needed."""
    try:
        lines = await run_in_threadpool(enhance_ai.ocr, job_id, req.which)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
    return {"lines": lines}


@app.get("/api/timeline/tz")
async def timeline_tz():
    """The DVR's UTC offset, so the calendar/time picker can show and set DVR-local dates correctly."""
    tz = state["playback"].tz
    if tz is None:
        return {"offset_minutes": 0, "ready": False}
    offset = tz.utcoffset(None)
    return {"offset_minutes": int(offset.total_seconds() // 60), "ready": True}


# ------------------------------------------------------------------ DVR playback (WebCodecs feed)
#
# Binary frame format sent to the browser (one per NAL access unit):
#   byte 0      : 1 = keyframe, 0 = delta
#   bytes 1-8   : absolute UTC time, float64 big-endian, seconds
#   bytes 9+    : Annex-B NAL bytes (start code included), fed straight into WebCodecs VideoDecoder
# Control messages from the browser are JSON text: {"type":"seek","t":"<iso>"} or {"type":"speed","scale":"2"}.

@app.websocket("/api/playback/ws")
async def playback_ws(ws: WebSocket, channel: str, start: str, speed: str = "1"):
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)
        return
    s = current()
    ch = next((c for c in s.channels if c.id == channel and c.enabled), None)
    if ch is None:
        await ws.close(code=4404)
        return
    a_const = psess.calibration_for(ch.channel)
    tz = state["playback"].tz
    if a_const is None or tz is None:
        await ws.close(code=4409)  # not calibrated yet — client should retry shortly
        return
    conn = hikrelay.conn_of({"connection": s.connection.model_dump()})
    path = hikrelay.playback_path(ch.channel, ch.main_path)
    await ws.accept()
    reader = psess.PlaybackReader(conn, ch.channel, path, a_const, start, tz, speed)
    reader.start()
    try:
        async def from_client():
            while True:
                m = await ws.receive()
                if m["type"] == "websocket.disconnect":
                    reader.stop()
                    return
                if m.get("text"):
                    try:
                        import json
                        msg = json.loads(m["text"])
                    except ValueError:
                        continue
                    if msg.get("type") == "seek":
                        reader.seek(msg["t"], msg.get("scale"))
                    elif msg.get("type") == "speed":
                        reader.set_speed(msg["scale"])

        async def to_client():
            import struct
            if reader.waiting_for_slot:
                await ws.send_json({"type": "queued", "busy": psess.pool.busy, "limit": psess.pool.limit})
            first = True
            while True:
                item = await run_in_threadpool(reader.q.get)
                if item is None:
                    return
                if item[0] == "error":
                    await ws.send_json({"type": "error", "message": item[1]})
                    return
                if first:
                    await ws.send_json({"type": "playing"})
                    first = False
                abs_t, is_key, nal = item
                header = bytes([1 if is_key else 0]) + struct.pack(">d", abs_t)
                await ws.send_bytes(header + nal)

        recv_task = asyncio.create_task(from_client())
        send_task = asyncio.create_task(to_client())
        await asyncio.wait([recv_task, send_task], return_when=asyncio.FIRST_COMPLETED)
        recv_task.cancel()
        send_task.cancel()
    finally:
        reader.stop()
        try:
            await ws.close()
        except Exception:
            pass


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
