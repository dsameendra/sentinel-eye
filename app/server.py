"""Sentinel Eye web server: UI, settings API, connection test, and a WebSocket proxy to go2rtc."""
import asyncio, datetime, json, re, threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote, urlparse

import websockets
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

import auth
import auth_api
import coverage
import db
import enhance_ai
import enhance_models
import export as exportmod
import hikrelay
import hwaccel
import playback_session as psess
import recorder_guard
import settings as cfg
import thumbnails
import timebase
from go2rtc import API_PORT, Go2rtc, desired_streams
from playback_service import PlaybackService

state = {"settings": cfg.load(), "go2rtc": None, "playback": None}
try:
    auth.bootstrap_from_env()   # SENTINEL_ADMIN_PASSWORD: first admin, only while there are no accounts
except auth.AuthError as e:
    raise SystemExit(f"SENTINEL_ADMIN_PASSWORD / SENTINEL_ADMIN_USER: {e}")


def current() -> cfg.Settings:
    return state["settings"]


TZ_UNKNOWN = "The recorder's clock isn't known yet — try again shortly"


def _dvr_tz():
    """The recorder's UTC offset as a tzinfo, or None until PlaybackService has read it."""
    p = state["playback"]
    return p.tz if p else None


def _tz_offset_min(tz) -> int:
    return int(tz.utcoffset(None).total_seconds() // 60)


def _recorder_blocked() -> bool:
    """True while the recorder is rejecting the saved credentials (recorder_guard): fail fast, don't log in."""
    c = current().connection
    return recorder_guard.tripped(recorder_guard.fingerprint(c.host, c.username, c.password))


def _actor(request: Request) -> str:
    """Who to name in the audit log: the account, or (sign-in off / LAN bypass) the same name stamped on
    bookmarks and exports."""
    p = request.state.principal
    return p.username if p.via == "session" else p.author


def _audit(request: Request, action: str, target: str = "", **detail) -> None:
    auth.audit(_actor(request), action, target, auth_api.ip_of(request), **detail)


@asynccontextmanager
async def lifespan(app):
    engine, device = await run_in_threadpool(hwaccel.current)   # before go2rtc: its config and relays use it
    print(f"hwaccel: H.264 encoder = {engine}" + (f" ({device})" if device else ""), flush=True)
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
app.middleware("http")(auth_api.gate)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """On every response, the sign-in gate's own included (registered after it, so it wraps it): no framing
    by other sites (clickjacking a signed-in admin), no MIME sniffing, no full URLs leaked as Referer."""
    resp = await call_next(request)
    h = resp.headers
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "same-origin")
    return resp
app.add_exception_handler(auth.AuthError, auth_api.auth_error)
app.include_router(auth_api.router)


@app.get("/login")
@app.get("/pair")
def auth_page(request: Request):
    return FileResponse(cfg.ROOT / "web" / f"{request.url.path.strip('/')}.html", headers={"Cache-Control": "no-cache"})


# Open WebSockets per session, so revoking a session (sign-out elsewhere, a removed TV) cuts its streams now
# rather than at the next reconnect. Revocation can happen on any thread; closing is scheduled on the
# socket's own loop. _ws_track/_ws_untrack run on each socket's own event-loop thread, but _close_revoked
# can fire from a FastAPI threadpool thread (sync routes like /logout and the admin user routes) — the dict
# is shared across both, so it needs a real lock, not just goodwill.
_ws_by_session: dict[str, set] = {}
_ws_by_session_lock = threading.Lock()


def _close_revoked(hashes: list[str]) -> None:
    with _ws_by_session_lock:
        entries = [(loop, ws) for h in hashes for loop, ws in _ws_by_session.get(h, ())]
    for loop, ws in entries:
        loop.call_soon_threadsafe(lambda ws=ws: asyncio.ensure_future(_close_quietly(ws, 4401)))


async def _close_quietly(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


auth.on_revoke(_close_revoked)


async def _ws_admit(ws: WebSocket, role: str):
    """Principal for a WebSocket, or None after closing it. Closes after accepting, so the browser actually
    sees 4401 (sign in) / 4403 (not allowed) instead of a bare failed handshake."""
    p = auth_api.principal_for(ws)
    code = 4401 if p.via == "anon" else 4403 if (p.limited or not p.can(role)) else None
    if code:
        await ws.accept()
        await ws.close(code=code)
        return None
    return p


def _ws_track(p, ws: WebSocket) -> tuple | None:
    if not p.session_hash:
        return None
    entry = (asyncio.get_running_loop(), ws)
    with _ws_by_session_lock:
        _ws_by_session.setdefault(p.session_hash, set()).add(entry)
    return entry


def _ws_untrack(p, entry) -> None:
    if entry:
        with _ws_by_session_lock:
            peers = _ws_by_session.get(p.session_hash, set())
            peers.discard(entry)
            if not peers:
                _ws_by_session.pop(p.session_hash, None)


class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


# ------------------------------------------------------------------ settings

@app.get("/api/settings")
def get_settings(request: Request):
    d = cfg.public(current())
    if not request.state.principal.can("admin"):
        # What the live grid needs, and nothing about the recorder itself.
        d["connection"] = {"channel_zero": d["connection"]["channel_zero"], "configured": bool(current().connection.host)}
    return d


@app.put("/api/settings")
async def put_settings(new: cfg.Settings, request: Request):
    old = current()
    new = cfg.merge_secrets(new, old)
    if new.connection.encrypted and not new.connection.key:
        raise HTTPException(422, "Enter the verification code, or turn stream encryption off")
    cfg.normalise_order(new)
    conn_changed = new.connection != old.connection
    streams_changed = conn_changed or new.channels != old.channels
    # A different recorder (not just a new password or port): what was indexed about the old one says nothing.
    recorder_changed = (new.connection.host, new.connection.http_port) != (old.connection.host, old.connection.http_port)
    cfg.save(new)
    state["settings"] = new
    # Saving Settings is how the admin fixes a password the recorder rejected: lift the lockout breaker so
    # everything may log in once more (it trips again on the first rejection).
    was_blocked = recorder_guard.clear()
    p = state["playback"]
    if p and (streams_changed or was_blocked):
        p.reload(connection_changed=recorder_changed)   # new connection / channels apply now, not after a restart
    before, after = old.model_dump(), new.model_dump()
    # Section and field NAMES only — never a value (the connection holds the password and verification code).
    _audit(request, "settings.update", "",
           sections=[k for k in after if after[k] != before.get(k)] or None,
           connection_fields=sorted(k for k in after["connection"] if after["connection"][k] != before["connection"].get(k)) or None)
    if streams_changed:
        await run_in_threadpool(state["go2rtc"].sync)
    return cfg.public(new)


@app.post("/api/recorder/retry")
async def recorder_retry(request: Request):
    """Admin: try the saved credentials again after the recorder rejected them (e.g. the password was fixed
    on the recorder itself, or its lockout has expired). One login goes first — see PlaybackService.reload."""
    was_blocked = recorder_guard.clear()
    p = state["playback"]
    if p:
        p.reload(connection_changed=False)
    _audit(request, "recorder.retry", "", was_blocked=was_blocked)
    return {"ok": True, "was_blocked": was_blocked}


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
async def status(request: Request):
    g = state["go2rtc"]
    principal = request.state.principal
    if principal.via == "anon":   # the Docker healthcheck: up or not, nothing else
        return {"go2rtc": await run_in_threadpool(g.up)}
    streams = await run_in_threadpool(g.status)
    p = state["playback"]
    health = await run_in_threadpool(p.health) if p else None
    out = {"go2rtc": bool(streams) or await run_in_threadpool(g.up), "streams": streams,
           "hwaccel": hwaccel.current()[0],
           # The recorder rejected the saved username/password: nothing logs in until Settings are saved or an
           # admin retries (POST /api/recorder/retry). A yes/no only — no credentials, so fine for any role.
           "recorder_auth_failed": _recorder_blocked()}
    if not principal.can("admin"):
        # Viewers and operators get yes/no answers only: the raw error strings can name the recorder's address
        # (a refused connection, a relay error), and the rest is for whoever administers the recorder.
        out["recorder"] = {"configured": bool(current().connection.host),
                           "reachable": health["reachable"] if health else None,
                           "live_events_connected": bool(health and health["live_events"]["connected"])}
        return out
    sub = p.subscriber if p else None
    out["recorder"] = {"configured": bool(current().connection.host), **(health or {})}
    out["playback"] = {**(p.status if p else {}), "alertstream_connected": sub.connected if sub else False,
                       "last_live_event_utc": sub.last_event_utc if sub else None}
    return out


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


EVENTS_MAX_LIMIT = 5000
CSV_MAX_ROWS = 100_000


def _utc_param(v: str, name: str) -> str:
    """An ISO 8601 query parameter normalised the way stored times are (UTC, +00:00), so string comparison
    against the table agrees with time order; "" stays "" (no bound)."""
    if not v:
        return ""
    dt = psess.parse_utc(v)
    if dt is None:
        raise HTTPException(422, f"{name} must be an ISO 8601 time")
    return dt.isoformat()


def _cursor(v: str, name: str):
    """A keyset cursor "<start_utc>,<id>" (the last row of the previous page), or None."""
    if not v:
        return None
    t, _, i = v.rpartition(",")
    if not t or not i.isdigit():
        raise HTTPException(422, f"{name} must be <start_utc>,<id>")
    return _utc_param(t, name), int(i)


def _events_query(channel, start_utc, end_utc, kind, before=None, after=None, order="desc"):
    """SQL + params for the events search shared by the list and the CSV export. Order is (start_utc, id) —
    stable for keyset paging, since a row's start and id never change (upserts only extend end_utc)."""
    q = "SELECT * FROM events WHERE start_utc <= ? AND end_utc >= ?"
    params = [end_utc or "9999", start_utc or "0000"]
    if channel:
        q += f" AND channel IN ({','.join('?' * len(channel))})"
        params.extend(channel)
    kinds = [k for k in (kind or []) if k]
    if kinds:
        q += f" AND kind IN ({','.join('?' * len(kinds))})"
        params.extend(kinds)
    if before:
        q += " AND (start_utc < ? OR (start_utc = ? AND id < ?))"
        params.extend([before[0], before[0], before[1]])
    if after:
        q += " AND (start_utc > ? OR (start_utc = ? AND id > ?))"
        params.extend([after[0], after[0], after[1]])
    d = "ASC" if order == "asc" else "DESC"
    q += f" ORDER BY start_utc {d}, id {d}"
    return q, params


@app.get("/api/timeline/events")
async def timeline_events(channel: list[int] | None = Query(None), start_utc: str = "", end_utc: str = "",
                           kind: list[str] | None = Query(None), limit: int = 2000, before: str = "", after: str = "",
                           order: Literal["asc", "desc"] = "desc"):
    """Events overlapping [start_utc, end_utc]. `channel` and `kind` may repeat (?channel=1&channel=3&kind=motion
    &kind=line) — the Playback timeline shows every selected camera at once, and Events searches several types
    in one query. `limit` applies to the combined result.

    Newest first by default, then capped — not the other way round. With oldest first, a window with more
    matching rows than `limit` silently kept the *oldest* slice and dropped everything more recent, including
    all of today whenever an earlier, busier day alone filled the cap — confirmed as the cause of a real "today's
    events don't show up" report. order=asc is for looking forward from a time (Playback's next event / skip
    empty), where the nearest rows are the oldest ones.

    Paging (Events): `before` = "<start_utc>,<id>" of the last row seen returns the rows after it in newest-first
    order; `after` the same for order=asc. A page shorter than `limit` is the last one."""
    q, params = _events_query(channel, _utc_param(start_utc, "start_utc"), _utc_param(end_utc, "end_utc"), kind,
                              _cursor(before, "before"), _cursor(after, "after"), order)
    q += " LIMIT ?"
    params.append(max(1, min(limit, EVENTS_MAX_LIMIT)))   # clamped, not refused: bounds one query's cost without a 422
    rows = await run_in_threadpool(db.query, q, tuple(params))
    return [dict(r) for r in rows]


_CSV_DANGER = ("=", "+", "-", "@", "\t", "\r")


def _csv_cell(v) -> str:
    """One CSV cell. Text starting like a formula (= + - @, or a tab/CR) gets a leading apostrophe so a
    spreadsheet shows it rather than running it (CSV formula injection) — a bookmark title is user input."""
    if v is None:
        return ""
    s = str(v)
    if isinstance(v, str) and s.startswith(_CSV_DANGER):
        s = "'" + s
    if any(c in s for c in ',"\r\n'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def _csv_events(channel, start_utc, end_utc, kind, tz, names):
    """Rows of the events CSV, newest first, fetched in keyset batches — each batch its own query, because a
    StreamingResponse pulls this generator from varying threadpool threads and the DB connection is per thread."""
    yield ",".join(["start_local", "end_local", "start_utc", "end_utc", "duration_s", "camera", "channel", "kind",
                    "source", "bookmark_title", "bookmark_severity", "bookmark_note", "bookmark_author"]) + "\r\n"
    bm_cache = {}
    sent, cursor = 0, None
    fmt_local = lambda iso: datetime.datetime.fromisoformat(iso).astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")
    while sent < CSV_MAX_ROWS:
        q, params = _events_query(channel, start_utc, end_utc, kind, before=cursor)
        q += " LIMIT ?"
        params.append(min(1000, CSV_MAX_ROWS - sent))
        rows = db.query(q, tuple(params))
        if not rows:
            return
        out = []
        for r in rows:
            r = dict(r)
            bm = {}
            if r["kind"] == "bookmark" and r.get("attrs_json"):
                try:
                    bid = json.loads(r["attrs_json"]).get("bookmark_id")
                except ValueError:
                    bid = None
                if bid is not None:
                    if bid not in bm_cache:
                        bm_cache[bid] = db.get_bookmark(bid) or {}
                    bm = bm_cache[bid]
            s, e = r["start_utc"], r["end_utc"]
            dur = max(0.0, datetime.datetime.fromisoformat(e).timestamp() - datetime.datetime.fromisoformat(s).timestamp())
            out.append(",".join(_csv_cell(v) for v in [
                fmt_local(s), fmt_local(e), s, e, f"{dur:.1f}", names.get(r["channel"], f"Channel {r['channel']}"),
                r["channel"], r["kind"], r["source"], bm.get("title"), bm.get("severity"), bm.get("note"),
                bm.get("author")]) + "\r\n")
        yield "".join(out)
        sent += len(rows)
        cursor = (rows[-1]["start_utc"], rows[-1]["id"])
        if len(rows) < params[-1]:
            return
    yield _csv_cell(f"# Stopped at {CSV_MAX_ROWS} rows — narrow the range, cameras or types to export the rest.") + "\r\n"


@app.get("/api/timeline/events.csv")
async def timeline_events_csv(request: Request, channel: list[int] | None = Query(None), start_utc: str = "",
                               end_utc: str = "", kind: list[str] | None = Query(None)):
    """Every event matching the Events filters as CSV (not just the rows loaded on screen), newest first, up to
    CSV_MAX_ROWS — a final comment row says so when that cap cuts it short. Times in recorder-local time and
    UTC. Audited (events.export_csv)."""
    tz = _dvr_tz()
    if tz is None:
        raise HTTPException(503, TZ_UNKNOWN)   # the local-time columns would be wrong
    s0, s1 = _utc_param(start_utc, "start_utc"), _utc_param(end_utc, "end_utc")
    names = {c.channel: c.name or f"Camera {c.channel}" for c in current().channels}
    _audit(request, "events.export_csv", "", channels=channel or None, kinds=[k for k in (kind or []) if k] or None,
           start_utc=s0 or None, end_utc=s1 or None)
    stamp = datetime.datetime.now(tz).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(_csv_events(channel, s0, s1, kind, tz, names), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="sentinel-events-{stamp}.csv"',
                                      "Cache-Control": "no-store"})


@app.get("/api/timeline/events/{event_id}/thumbnail")
async def event_thumbnail(event_id: int):
    """One JPEG frame near the event's midpoint (spec: represent a multi-second event by its middle, not its
    first instant), generated on demand and cached — see app/thumbnails.py. Uses a real DVR playback session
    like any other, so it's bounded by the same 4-session pool."""
    row = await run_in_threadpool(db.one, "SELECT * FROM events WHERE id=?", (event_id,))
    if row is None:
        raise HTTPException(404, "Unknown event")
    event = dict(row)
    # Private: a frame of camera footage, behind sign-in — no shared cache may keep a copy.
    cache = {"Cache-Control": "private, max-age=604800"}
    cached = event.get("snapshot_path")
    if cached and Path(cached).exists():
        return FileResponse(cached, media_type="image/jpeg", headers=cache)
    if _recorder_blocked():
        raise HTTPException(503, recorder_guard.MESSAGE)
    tz = _dvr_tz()
    if tz is None:
        # Never guess the offset (this used to assume India's +05:30): the frame would come from the wrong hour.
        raise HTTPException(503, TZ_UNKNOWN)
    s = current()
    ch = next((c for c in s.channels if c.channel == event["channel"]), None)
    try:
        path = await run_in_threadpool(thumbnails.get_or_generate, event, s.connection.model_dump(),
                                        ch.playback_path if ch else "", _tz_offset_min(tz))
    except Exception as e:
        raise HTTPException(503, f"Couldn't generate a thumbnail: {e}")
    return FileResponse(path, media_type="image/jpeg", headers=cache)


@app.get("/api/timeline/calibration")
async def timeline_calibration():
    rows = await run_in_threadpool(db.query, "SELECT * FROM calibration")
    return {r["channel"]: dict(r) for r in rows}


@app.get("/api/timeline/retention")
async def timeline_retention():
    """Per enabled camera, the oldest recording the recorder still has (UTC) and how many days back that is —
    the recorder overwrites its oldest footage as its disk loops. null = unknown: only ever from this process's
    own coverage index with the oldest day established for certain, never estimated."""
    p = state["playback"]
    ret = await run_in_threadpool(p.retention) if p else {}
    return {"channels": {str(ch): v for ch, v in ret.items()}}


@app.get("/api/playback/pool")
async def playback_pool():
    """How many of the DVR's 4 playback sessions are in use right now (section 7.3)."""
    return {"busy": psess.pool.busy, "limit": psess.pool.limit, "units": psess.pool.used_units, "budget": psess.pool.budget}


class BookmarkFields(BaseModel):
    title: str = Field("", max_length=200)
    note: str = Field("", max_length=4000)
    severity: Literal["info", "warning", "critical"] = "info"


class BookmarkRequest(BookmarkFields):
    channels: list[str] = Field(max_length=64)  # our channel ids (e.g. "c1"), not DVR channel numbers
    time_utc: str

    @field_validator("time_utc")
    @classmethod
    def _time(cls, v):
        # Stored normalised (UTC, +00:00) like every other event time, so it sorts and compares with them.
        dt = psess.parse_utc(v)
        if dt is None:
            raise ValueError("time_utc must be an ISO 8601 time")
        return dt.isoformat()


@app.post("/api/bookmarks")
async def create_bookmark(req: BookmarkRequest, request: Request):
    """Bookmark = (time, channels[], title, note, severity, author, created) — spec section 9. `author` is the
    signed-in user ("Operator" while sign-in is off); author_user_id, the account, is what edit/delete rights are
    checked against. Mirrored into the events table per channel (kind='bookmark') so it shows up on the timeline
    and in search for free."""
    s = current()
    chan_nums = [c.channel for c in s.channels if c.id in req.channels]
    if not chan_nums:
        raise HTTPException(422, "No valid channel")
    p = request.state.principal
    author = p.author
    bid = await run_in_threadpool(db.create_bookmark, chan_nums, req.time_utc, req.title, req.note, req.severity,
                                   author, None, p.user_id if p.via == "session" else None)
    _audit(request, "bookmark.create", str(bid), channels=chan_nums, time_utc=req.time_utc, severity=req.severity)
    return {"id": bid, "channels": chan_nums, "author": author}


def _may_change_bookmark(p, b) -> bool:
    """Sign-in off: anyone (as before). Admins: any bookmark. Operators: their own — by account id, never by the
    author name (a display label that can change or collide). An operator coming in over a trusted network
    without signing in has no account: they may change bookmarks made the same way (no account, same LAN
    author label). Bookmarks from before accounts were recorded on them (no author_user_id): admins only."""
    if p.via == "none" or p.can("admin"):
        return True
    if not p.can("operator"):
        return False
    if p.via == "session":
        return b.get("author_user_id") is not None and b["author_user_id"] == p.user_id
    if p.via == "bypass":
        return b.get("author_user_id") is None and b.get("author") == p.author
    return False


def _owned_bookmark(request: Request, bookmark_id: int) -> dict:
    b = db.get_bookmark(bookmark_id)
    if b is None:
        raise HTTPException(404, "Unknown bookmark")
    if not _may_change_bookmark(request.state.principal, b):
        raise HTTPException(403, "Only whoever made this bookmark, or an admin, can change it")
    return b


@app.get("/api/bookmarks")
async def get_bookmarks(channel: int | None = None, start_utc: str = "", end_utc: str = "", limit: int = 500):
    rows = await run_in_threadpool(db.list_bookmarks, channel, _utc_param(start_utc, "start_utc") or None,
                                   _utc_param(end_utc, "end_utc") or None, max(1, min(limit, 1000)))
    return rows


class BookmarkPatch(BaseModel):
    """A partial edit: a field left out keeps its stored value. Same limits as creating one."""
    title: str | None = Field(None, max_length=200)
    note: str | None = Field(None, max_length=4000)
    severity: Literal["info", "warning", "critical"] | None = None


@app.patch("/api/bookmarks/{bookmark_id}")
async def update_bookmark(bookmark_id: int, req: BookmarkPatch, request: Request):
    """Edit a bookmark's title, note and/or severity (its time and cameras stay as recorded); fields not sent are
    kept. The mirrored events rows follow. Who edited it and when are kept; audited (bookmark.update)."""
    cur = await run_in_threadpool(_owned_bookmark, request, bookmark_id)
    b = await run_in_threadpool(db.update_bookmark, bookmark_id,
                                 cur["title"] or "" if req.title is None else req.title,
                                 cur["note"] or "" if req.note is None else req.note,
                                 cur["severity"] or "info" if req.severity is None else req.severity,
                                 request.state.principal.author)
    if b is None:
        raise HTTPException(404, "Unknown bookmark")
    _audit(request, "bookmark.update", str(bookmark_id), fields=sorted(req.model_dump(exclude_none=True)) or None)
    return b


@app.delete("/api/bookmarks/{bookmark_id}")
async def remove_bookmark(bookmark_id: int, request: Request):
    await run_in_threadpool(_owned_bookmark, request, bookmark_id)
    await run_in_threadpool(db.delete_bookmark, bookmark_id)
    _audit(request, "bookmark.delete", str(bookmark_id))
    return {"ok": True}


class ExportRequest(BaseModel):
    channels: list[str]
    start_utc: str
    end_utc: str
    package: Literal["signed", "plain"] = "signed"


@app.post("/api/export")
async def create_export(req: ExportRequest, request: Request):
    """Starts a background export job (spec section 10). Bookmarks on these cameras inside the range go into the
    signed manifest. Each channel is exported through a real PlaybackReader — the DVR's 4-session playback budget applies to exports exactly like a playback pane,
    and shows up in /api/playback/pool while running."""
    import datetime as _dt
    import secrets as _secrets
    s = current()
    chans = [c for c in s.channels if c.id in req.channels]
    if not chans:
        raise HTTPException(422, "No valid channel")
    # Both normalised to aware UTC (a naive time is taken as UTC, as everywhere in this API): comparing a naive
    # with an aware one raised a 500 here, and export.py compares them again against frame times.
    start_dt, end_dt = psess.parse_utc(req.start_utc), psess.parse_utc(req.end_utc)
    if start_dt is None or end_dt is None:
        raise HTTPException(422, "start_utc/end_utc must be ISO 8601")
    if end_dt <= start_dt:
        raise HTTPException(422, "end_utc must be after start_utc")
    if (end_dt - start_dt) > _dt.timedelta(hours=2):
        raise HTTPException(422, "Clips are limited to 2 hours per export for now")
    if _recorder_blocked():
        raise HTTPException(503, recorder_guard.MESSAGE)
    tz = _dvr_tz()
    if tz is None:
        raise HTTPException(503, TZ_UNKNOWN)
    channel_dicts = [{**c.model_dump(), "_tz_offset_min": _tz_offset_min(tz)} for c in chans]
    job_id = _secrets.token_hex(8)
    start_utc, end_utc = start_dt.isoformat(), end_dt.isoformat()
    exportmod.start_export(job_id, channel_dicts, start_utc, end_utc, req.package,
                            request.state.principal.author, s.connection.model_dump())
    _audit(request, "export.create", job_id, channels=[c.channel for c in chans], start_utc=start_utc,
           end_utc=end_utc, package=req.package)
    return {"job_id": job_id}


@app.get("/api/export/signing-key")
async def export_signing_key():
    """This install's export-signing public key and its fingerprint (operator+, like exporting itself): what a
    recipient of a signed package compares with the fingerprint verify.html shows. Declared before
    /api/export/{job_id}, which would otherwise swallow it as a job id."""
    return await run_in_threadpool(exportmod.signing_key_info)


@app.delete("/api/export/{job_id}")
async def export_cancel(job_id: str, request: Request):
    """Cancel a queued or running export: its recorder session is released and its partial files removed."""
    state = await run_in_threadpool(exportmod.cancel_job, job_id)
    if state is None:
        raise HTTPException(404, "Unknown export job")
    if state not in ("cancelling", "cancelled"):
        raise HTTPException(409, f"That export has already finished ({state})")
    _audit(request, "export.cancel", job_id)
    return {"ok": True, "state": state}


@app.get("/api/export/{job_id}")
async def export_status(job_id: str):
    job = await run_in_threadpool(exportmod.get_job, job_id)
    if job is None:
        raise HTTPException(404, "Unknown export job")
    return job


@app.get("/api/export/{job_id}/download")
async def export_download(job_id: str, request: Request):
    job = await run_in_threadpool(exportmod.get_job, job_id)
    if job is None or job.get("state") != "done" or not job.get("download"):
        raise HTTPException(404, "That export isn't ready")
    path = exportmod.EXPORT_DIR / job["download"]
    if not path.exists():
        raise HTTPException(404, "That export has expired")
    _audit(request, "export.download", job_id, package=job.get("package"))
    return FileResponse(path, filename=path.name)


# One frame is a base64 PNG straight from the browser's decoded playback buffer: a 4K frame is ~10-25 MB.
MAX_ENHANCE_IMAGE_B64 = 25 * 1024 * 1024
MAX_ENHANCE_FRAMES = 11
MAX_ENHANCE_BODY = MAX_ENHANCE_FRAMES * MAX_ENHANCE_IMAGE_B64 + 64 * 1024


class EnhanceRequest(BaseModel):
    channel: int
    at_utc: str = ""
    mode: Literal["auto", "face", "plate", "general"] = "auto"
    images: list[Annotated[str, Field(max_length=MAX_ENHANCE_IMAGE_B64)]]  # base64 PNG, oldest -> newest, 1-11 frames
    roi: list[float] | None = None  # optional [x, y, w, h] fractions (0-1) — crop before enhancing
    weight: float = 0.5  # GFPGAN fidelity (0=free reconstruction, 1=barely touched) — spec section 2d
    upscaler: str | None = None   # override Settings → Enhancement for this job (catalog id)
    face: str | None = None


async def _read_body_capped(request: Request, cap: int) -> bytes:
    """The request body, refused with 413 as soon as it passes `cap` bytes — before it is all held in memory,
    parsed as JSON or base64-decoded (a declared Content-Length over the cap is refused without reading)."""
    too_big = HTTPException(413, f"That request is too large (the limit is {cap // (1024 * 1024)} MB)")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > cap:
        raise too_big
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > cap:
            raise too_big
    return bytes(buf)


@app.post("/api/enhance")
async def create_enhance(request: Request):
    """Starts a background AI frame-enhancement job (docs/SPEC.md section 7.8). Frames come from the
    client's already-decoded playback buffer — no DVR session, doesn't touch the 4-session budget.
    The body is read with a size cap and validated by hand (not as a FastAPI body parameter), so an oversized
    upload is refused while it streams in rather than after being parsed."""
    import secrets as _secrets
    body = await _read_body_capped(request, MAX_ENHANCE_BODY)
    try:
        req = EnhanceRequest.model_validate_json(body)
    except ValidationError as e:
        raise RequestValidationError(e.errors(include_url=False, include_context=False, include_input=False))
    if not req.images or len(req.images) > MAX_ENHANCE_FRAMES:
        raise HTTPException(422, "1-11 frames expected")
    if req.roi is not None and len(req.roi) != 4:
        raise HTTPException(422, "roi must be [x, y, w, h]")
    if not 0.0 <= req.weight <= 1.0:
        raise HTTPException(422, "weight must be between 0 and 1")
    d = current().display
    upscaler = req.upscaler if req.upscaler in enhance_models.UPSCALERS else d.enhance_upscaler
    face = req.face if req.face in enhance_models.FACES else d.enhance_face_model
    job_id = _secrets.token_hex(8)
    enhance_ai.start_enhance(job_id, req.images, req.mode, req.channel, req.at_utc, req.roi, req.weight, upscaler, face)
    return {"job_id": job_id}


@app.get("/api/enhance/models")
async def enhance_models_status():
    """Settings → Enhancement: every upscaler, face and text-reading model, with whether it's ready, needs
    downloading, or needs the enhancer install — plus the recommended pairings."""
    return await run_in_threadpool(enhance_models.status)


class ModelDownloadRequest(BaseModel):
    kind: Literal["upscaler", "face", "plate"]
    id: str


@app.post("/api/enhance/models/download")
async def enhance_models_download(req: ModelDownloadRequest, request: Request):
    """Fetch a model ahead of first use (admin; it writes to the server's disk)."""
    if not request.state.principal.can("admin"):
        raise HTTPException(403, "Only an admin can download models")
    table = {"upscaler": enhance_models.UPSCALERS, "face": enhance_models.FACES, "plate": enhance_models.PLATES}[req.kind]
    if req.id not in table:
        raise HTTPException(404, "Unknown model")
    ok, why = enhance_models._engine_ready(req.kind, req.id)
    if not ok:
        raise HTTPException(409, why)
    enhance_models.download_in_background(req.kind, req.id)
    _audit(request, "model.download", f"{req.kind}:{req.id}")
    return {"ok": True}


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


class OcrRegion(BaseModel):
    # The operator's box on the picture: centre and size as fractions (w of the width, h of the height),
    # angle in degrees clockwise as drawn on screen.
    cx: float = Field(ge=0, le=1)
    cy: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1.5)
    h: float = Field(gt=0, le=1.5)
    angle: float = Field(default=0, ge=-90, le=90)


class OcrRequest(BaseModel):
    which: Literal["result", "source"] = "result"
    region: OcrRegion | None = None
    plate: bool = False   # plate characters only, no dictionary "corrections"


@app.post("/api/enhance/{job_id}/ocr")
async def enhance_ocr(job_id: str, req: OcrRequest):
    """Optional, on-demand text read (spec 4a) — Tesseract on an image already produced by this job, the
    whole picture or just the operator's (possibly rotated) box. Synchronous: about a second, no job/poll."""
    try:
        lines, crop, engine = await run_in_threadpool(enhance_ai.ocr, job_id, req.which,
                                                      req.region.model_dump() if req.region else None, req.plate,
                                                      current().display.enhance_plate_model)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ModuleNotFoundError as e:
        # Same reasoning as _run()'s own ModuleNotFoundError handling in enhance_ai.py: PIL/cv2/pytesseract
        # aren't in the Docker image by design, and a raw "No module named 'X'" reads as a bug there.
        raise HTTPException(503, f"Reading text isn't available on this server (missing: {e.name}). It's "
                                  "not included in the Docker image by design — see the README's "
                                  "\"AI frame enhancer\" section to install it on a native (non-Docker) run.")
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
    return {"lines": lines, "crop": crop, "engine": engine}


@app.get("/api/timeline/tz")
async def timeline_tz():
    """The DVR's UTC offset, so the calendar/time picker can show and set DVR-local dates correctly."""
    tz = _dvr_tz()
    if tz is None:
        return {"offset_minutes": 0, "ready": False}
    return {"offset_minutes": _tz_offset_min(tz), "ready": True}


# ------------------------------------------------------------------ DVR playback (WebCodecs feed)
#
# Binary frame format sent to the browser (one per NAL access unit):
#   byte 0      : 1 = keyframe, 0 = delta
#   bytes 1-8   : recorded time (UTC epoch seconds), float64 big-endian — see playback_session's segment labels
#   bytes 9+    : Annex-B NAL bytes (start code included), fed straight into WebCodecs VideoDecoder
# Before each segment's first frame a JSON text message: {"type":"playing"|"segment", "codec":"hevc"|"h264",
# "time_source":"calibration"|"anchor", "approx":bool, "display_from":epoch, "first_utc":epoch, "bound_s":…}.
# Control messages from the browser are JSON text: {"type":"seek","t":"<iso>"} or {"type":"speed","scale":"2"}.
# Speeds are only ever one of playback_session.NICE_SPEEDS and times only ever ISO 8601 instants: both end up in
# the recorder's RTSP request text (`Scale:` / `Range:`), so anything else is refused at connect (close 1008) or
# ignored in a message, never passed on.

REPLAY_WINDOW_S = 120   # a viewer may play back this far: the live view's instant replay (last 10 s), not review


def _within_replay_window(t: str) -> bool:
    import datetime
    try:
        at = datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    if at.tzinfo is None:
        return False
    age = (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds()
    return -30 <= age <= REPLAY_WINDOW_S


@app.websocket("/api/playback/ws")
async def playback_ws(ws: WebSocket, channel: str, start: str, speed: str = "1"):
    p = await _ws_admit(ws, "viewer" if _within_replay_window(start) else "operator")
    if p is None:
        return
    review = p.can("operator")
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)
        return
    s = current()
    ch = next((c for c in s.channels if c.id == channel and c.enabled), None)
    if ch is None:
        await ws.close(code=4404)
        return
    start_dt, speed = psess.parse_utc(start), psess.valid_speed(speed)
    if start_dt is None or speed is None:
        await ws.accept()
        await ws.close(code=1008, reason="Invalid start time" if start_dt is None else "Invalid speed")
        return
    start = start_dt.isoformat()
    if _recorder_blocked():
        await ws.accept()
        await ws.send_json({"type": "error", "message": recorder_guard.MESSAGE})
        await ws.close()
        return
    a_const = psess.calibration_for_time(ch.channel, start)
    tz = _dvr_tz()
    if a_const is None or tz is None:
        await ws.close(code=4409)  # not calibrated yet — client should retry shortly
        return
    conn = hikrelay.conn_of({"connection": s.connection.model_dump()})
    # The recording-track override, never the live main_path one (that silently plays live video instead).
    path = hikrelay.playback_path(ch.channel, ch.playback_path)
    await ws.accept()
    tracked = _ws_track(p, ws)
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
                        msg = json.loads(m["text"])
                    except ValueError:
                        continue
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("type") == "seek":
                        t = psess.parse_utc(msg.get("t"))
                        if t is None:
                            continue   # not a time: ignored, never handed to the reader
                        # A missing scale keeps the current speed (JSON.stringify drops an undefined one); an
                        # invalid one is dropped the same way rather than reaching the recorder.
                        if review or _within_replay_window(t.isoformat()):
                            reader.seek(t.isoformat(), psess.valid_speed(msg.get("scale")))
                    elif msg.get("type") == "speed":
                        # Same gate as "seek": a viewer's session is only ever within the replay window at
                        # connect time, and reader.set_speed() has no per-call window check of its own — an
                        # ungated reverse speed would let a viewer scrub arbitrarily far into DVR history.
                        # No legitimate viewer flow sends "speed" today (only playback.js's operator+ review
                        # UI does), so this can't regress live view's instant replay.
                        sp = psess.valid_speed(msg.get("scale"))
                        if review and sp is not None:
                            reader.set_speed(sp)

        async def to_client():
            import struct
            if reader.waiting_for_slot:
                await ws.send_json({"type": "queued", "busy": psess.pool.busy, "limit": psess.pool.limit})
            seg = None
            while True:
                item = await run_in_threadpool(reader.q.get)
                if item is None:
                    return
                if item[0] == "error":
                    await ws.send_json({"type": "error", "message": item[1]})
                    return
                if item.seg is not seg:
                    # Before the segment's first frame, on the same ordered socket: "playing" once, then "segment"
                    # after each seek. Codec, where the times come from (approx when anchored), and display_from
                    # — frames before it are the keyframe pre-roll, truthfully labelled.
                    await ws.send_json({"type": "playing" if seg is None else "segment", **psess.public_segment(item.seg)})
                    seg = item.seg
                header = bytes([1 if item.key else 0]) + struct.pack(">d", item.t)
                await ws.send_bytes(header + item.data)

        recv_task = asyncio.create_task(from_client())
        send_task = asyncio.create_task(to_client())
        await asyncio.wait([recv_task, send_task], return_when=asyncio.FIRST_COMPLETED)
        recv_task.cancel()
        send_task.cancel()
    finally:
        _ws_untrack(p, tracked)
        reader.stop()
        try:
            await ws.close()
        except Exception:
            pass


# ------------------------------------------------------------------ WebSocket proxy to go2rtc

@app.websocket("/ws")
async def ws_proxy(ws: WebSocket, src: str):
    p = await _ws_admit(ws, "viewer")
    if p is None:
        return
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)  # cross-site page trying to watch the cameras
        return
    if not re.fullmatch(r"[A-Za-z0-9_]+", src) or src not in desired_streams(current()):
        await ws.close(code=1008)
        return
    await ws.accept()
    tracked = _ws_track(p, ws)
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
        _ws_untrack(p, tracked)
        try:
            await ws.close()
        except Exception:
            pass


app.mount("/", NoCacheStatic(directory=str(cfg.ROOT / "web"), html=True), name="web")
