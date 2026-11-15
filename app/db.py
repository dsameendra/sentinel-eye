"""SQLite storage for playback: events, DVR coverage, backfill watermarks, per-channel clock calibration.
WAL mode (concurrent readers, one writer); a module lock serializes writes from our own threads."""
import datetime
import json
import sqlite3
import threading
from pathlib import Path

from settings import DATA

DB_FILE = DATA / "playback.db"
_lock = threading.Lock()
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,         -- dvr-live | dvr-log | live-ai | scan-ai | manual
    channel INTEGER NOT NULL,
    kind TEXT NOT NULL,           -- motion | line | intrusion | tamper | videoloss | bookmark | ...
    start_utc TEXT NOT NULL,      -- ISO 8601 UTC
    end_utc TEXT NOT NULL,
    confidence REAL,
    region_json TEXT,
    attrs_json TEXT,
    snapshot_path TEXT,
    created_utc TEXT NOT NULL,
    UNIQUE(source, channel, kind, start_utc)
);
CREATE INDEX IF NOT EXISTS ix_events_ch_time ON events(channel, start_utc);
CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS coverage_days (
    channel INTEGER NOT NULL,
    day TEXT NOT NULL,            -- DVR-local YYYY-MM-DD, the unit the DVR itself reports coverage in
    spans_json TEXT NOT NULL,     -- [[start_utc, end_utc], ...] merged spans for that day
    refreshed_utc TEXT NOT NULL,
    PRIMARY KEY (channel, day)
);

CREATE TABLE IF NOT EXISTS backfill_watermark (
    log_type TEXT PRIMARY KEY,    -- 'Alarm' | 'Exception'
    last_completed_day TEXT,      -- DVR-local YYYY-MM-DD fully ingested; resume the day after this
    updated_utc TEXT
);

-- Starts still open at the end of the watermark day (a motion that began at 23:59:50 and stopped at
-- 00:00:05): handed to the next day's stitch so the event stays one span instead of splitting at midnight.
-- Written in the same transaction as the watermark it belongs to.
CREATE TABLE IF NOT EXISTS backfill_open (
    log_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel INTEGER NOT NULL,
    start_utc TEXT NOT NULL,
    PRIMARY KEY (log_type, kind, channel)
);

CREATE TABLE IF NOT EXISTS calibration (
    channel INTEGER PRIMARY KEY,
    a_const REAL NOT NULL,        -- abs_utc_seconds = a_const + rtp_ts/90000  (rtp_ts pre-unwrap, see timebase.py)
    measured_utc TEXT NOT NULL,
    error_estimate REAL,          -- seconds; from the OSD tick-over check
    method TEXT,                  -- 'osd_tick' | 'fallback_requested_time'
    prev_a_const REAL,            -- for discontinuity detection
    discontinuity INTEGER DEFAULT 0
);

-- Every calibration measurement ever taken, per channel — never overwritten (unlike `calibration` above,
-- which only ever holds the latest). A channel's RTP clock drifts across calibration cycles (re-measured
-- every 6h), so the a_const that's accurate for footage playback is whichever one was valid *when that
-- footage was recorded*, not necessarily today's (docs/SPEC.md section 2.4 — this is the fix for the
-- multi-hour timestamp error, and multi-camera desync, seen on old footage).
CREATE TABLE IF NOT EXISTS calibration_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel INTEGER NOT NULL,
    a_const REAL NOT NULL,
    measured_utc TEXT NOT NULL,
    error_estimate REAL,
    method TEXT
);
CREATE INDEX IF NOT EXISTS ix_calibration_history_ch_time ON calibration_history(channel, measured_utc);

CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channels_json TEXT NOT NULL,
    time_utc TEXT NOT NULL,
    title TEXT,
    note TEXT,
    severity TEXT,
    author TEXT,
    created_utc TEXT NOT NULL
);
"""


def _conn():
    if not hasattr(_local, "conn"):
        DATA.mkdir(exist_ok=True)
        c = sqlite3.connect(DB_FILE, timeout=30, isolation_level=None)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.row_factory = sqlite3.Row
        _local.conn = c
    return _local.conn


# PRAGMA user_version: one-off data migrations already applied to this database.
_DEDUPE_VERSION = 1


def init():
    with _lock:
        c = _conn()
        c.executescript(SCHEMA)
        if c.execute("PRAGMA user_version").fetchone()[0] < _DEDUPE_VERSION:
            _dedupe_dvr_events(c)
            c.execute(f"PRAGMA user_version={_DEDUPE_VERSION}")


def query(sql, params=()):
    return _conn().execute(sql, params).fetchall()


def one(sql, params=()):
    r = _conn().execute(sql, params).fetchone()
    return r


def write(sql, params=()):
    with _lock:
        _conn().execute(sql, params)


def executemany(sql, seq):
    with _lock:
        _conn().executemany(sql, seq)


# The recorder reports each of its own events twice: live on the alertStream (source dvr-live) and later in its
# log (dvr-log, by backfill). The table's unique key includes the source, so without merging, every DVR event
# was stored — and shown, counted, thumbnailed — twice. The two copies' start times agree to within a second
# or so (seen: identical, or one second apart), never more than this.
DVR_SOURCES = ("dvr-live", "dvr-log")
MERGE_WINDOW_S = 2.0


def _epoch(iso):
    return datetime.datetime.fromisoformat(iso).timestamp()


def _dvr_match(c, channel, kind, start_utc):
    """The existing DVR event (either source) this one is a copy of: same channel+kind, start within
    MERGE_WINDOW_S. Candidates come from a slightly wider string window on the index, then the exact test is
    numeric — stored strings don't all carry microseconds, so string distance isn't time distance."""
    t = _epoch(start_utc)
    utc = datetime.timezone.utc
    lo = datetime.datetime.fromtimestamp(t - MERGE_WINDOW_S - 1, utc).isoformat()
    hi = datetime.datetime.fromtimestamp(t + MERGE_WINDOW_S + 1, utc).isoformat()
    rows = c.execute(
        f"SELECT id, start_utc, end_utc FROM events WHERE channel=? AND kind=? AND source IN ({','.join('?' * len(DVR_SOURCES))})"
        " AND start_utc >= ? AND start_utc <= ?", (channel, kind, *DVR_SOURCES, lo, hi)).fetchall()
    near = [(abs(_epoch(r["start_utc"]) - t), r["id"], r) for r in rows if abs(_epoch(r["start_utc"]) - t) <= MERGE_WINDOW_S]
    return min(near)[2] if near else None


def upsert_event(source, channel, kind, start_utc, end_utc, confidence=None, region=None, attrs=None,
                  snapshot_path=None, now=None):
    """Insert, or extend end_utc if this exact (source, channel, kind, start_utc) already exists (e.g. a
    Start seen twice, or a live event later confirmed by log backfill).

    DVR events (dvr-live / dvr-log) also merge into an existing row of either source whose start is within
    MERGE_WINDOW_S: that row only ever has its end extended — never its start (the live subscriber finds its
    row again by the start it reported) and never its id (thumbnails are keyed by it)."""
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    with _lock:
        c = _conn()
        if source in DVR_SOURCES:
            row = _dvr_match(c, channel, kind, start_utc)
            if row is not None:
                if _epoch(end_utc) > _epoch(row["end_utc"]):
                    c.execute("UPDATE events SET end_utc=? WHERE id=?", (end_utc, row["id"]))
                return
        c.execute(
            """INSERT INTO events(source, channel, kind, start_utc, end_utc, confidence, region_json, attrs_json, snapshot_path, created_utc)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source, channel, kind, start_utc) DO UPDATE SET
                 end_utc = excluded.end_utc WHERE excluded.end_utc > events.end_utc""",
            (source, channel, kind, start_utc, end_utc, confidence,
             json.dumps(region) if region is not None else None,
             json.dumps(attrs) if attrs is not None else None, snapshot_path, now),
        )


def _dedupe_dvr_events(c):
    """One-off cleanup of the live/log duplicates stored before upsert_event merged them (see DVR_SOURCES).
    Groups rows of the same channel+kind whose starts are within MERGE_WINDOW_S of the group's first, keeps
    the one with a thumbnail (else the longest, else the oldest), stretches it to the group's latest end and
    deletes the rest. Idempotent; run once per database from init() (PRAGMA user_version)."""
    rows = c.execute(f"SELECT id, channel, kind, start_utc, end_utc, snapshot_path FROM events "
                     f"WHERE source IN ({','.join('?' * len(DVR_SOURCES))})", DVR_SOURCES).fetchall()
    rows = sorted(({**dict(r), "s": _epoch(r["start_utc"]), "e": _epoch(r["end_utc"])} for r in rows),
                  key=lambda r: (r["channel"], r["kind"], r["s"], r["id"]))
    groups, cur = [], []
    for r in rows:
        if cur and (r["channel"], r["kind"]) == (cur[0]["channel"], cur[0]["kind"]) and r["s"] - cur[0]["s"] <= MERGE_WINDOW_S:
            cur.append(r)
        else:
            if len(cur) > 1:
                groups.append(cur)
            cur = [r]
    if len(cur) > 1:
        groups.append(cur)
    if not groups:
        return 0
    removed = 0
    c.execute("BEGIN")
    try:
        for g in groups:
            keep = max(g, key=lambda r: (bool(r["snapshot_path"]), r["e"] - r["s"], -r["id"]))
            last = max(g, key=lambda r: r["e"])
            if last["e"] > keep["e"]:
                c.execute("UPDATE events SET end_utc=? WHERE id=?", (last["end_utc"], keep["id"]))
            for r in g:
                if r["id"] != keep["id"]:
                    c.execute("DELETE FROM events WHERE id=?", (r["id"],))
                    removed += 1
                    if r["snapshot_path"] and r["snapshot_path"] != keep["snapshot_path"]:
                        p = Path(r["snapshot_path"])
                        if p.parent == DATA / "thumbnails":   # only ever our own cached thumbnail files
                            p.unlink(missing_ok=True)
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return removed


def create_bookmark(channels, time_utc, title, note, severity, author, now=None):
    """channels: list of DVR channel numbers (ints) this bookmark applies to."""
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    with _lock:
        cur = _conn().execute(
            "INSERT INTO bookmarks(channels_json, time_utc, title, note, severity, author, created_utc) VALUES (?,?,?,?,?,?,?)",
            (json.dumps(channels), time_utc, title, note, severity, author, now))
        return cur.lastrowid


def list_bookmarks(channel=None, start_utc=None, end_utc=None, limit=500):
    q, params = "SELECT * FROM bookmarks WHERE 1=1", []
    if start_utc:
        q += " AND time_utc >= ?"; params.append(start_utc)
    if end_utc:
        q += " AND time_utc <= ?"; params.append(end_utc)
    q += " ORDER BY time_utc DESC LIMIT ?"; params.append(limit)
    out = []
    for r in query(q, tuple(params)):
        d = dict(r)
        d["channels"] = json.loads(d.pop("channels_json"))
        if channel is None or channel in d["channels"]:
            out.append(d)
    return out


def delete_bookmark(bookmark_id):
    with _lock:
        c = _conn()
        c.execute("DELETE FROM bookmarks WHERE id=?", (bookmark_id,))
        c.execute("DELETE FROM events WHERE kind='bookmark' AND json_extract(attrs_json,'$.bookmark_id')=?", (bookmark_id,))


def get_watermark(log_type):
    r = one("SELECT last_completed_day FROM backfill_watermark WHERE log_type=?", (log_type,))
    return r["last_completed_day"] if r else None


def get_open_starts(log_type):
    """{(kind, channel): start_utc} still open at the end of the watermark day (see backfill_open)."""
    return {(r["kind"], r["channel"]): r["start_utc"]
            for r in query("SELECT kind, channel, start_utc FROM backfill_open WHERE log_type=?", (log_type,))}


def advance_watermark(log_type, day, open_starts):
    """Mark `day` fully ingested together with the starts still open at its end — one transaction, so a crash
    can't leave a watermark pointing past a day whose open events were never handed on."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with _lock:
        c = _conn()
        c.execute("BEGIN")
        try:
            c.execute(
                "INSERT INTO backfill_watermark(log_type, last_completed_day, updated_utc) VALUES (?,?,?) "
                "ON CONFLICT(log_type) DO UPDATE SET last_completed_day=excluded.last_completed_day, updated_utc=excluded.updated_utc",
                (log_type, day, now))
            c.execute("DELETE FROM backfill_open WHERE log_type=?", (log_type,))
            c.executemany("INSERT INTO backfill_open(log_type, kind, channel, start_utc) VALUES (?,?,?,?)",
                          [(log_type, k, ch, s) for (k, ch), s in open_starts.items()])
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise


def set_watermark(log_type, day):
    write(
        "INSERT INTO backfill_watermark(log_type, last_completed_day, updated_utc) VALUES (?,?,?) "
        "ON CONFLICT(log_type) DO UPDATE SET last_completed_day=excluded.last_completed_day, updated_utc=excluded.updated_utc",
        (log_type, day, datetime.datetime.now(datetime.timezone.utc).isoformat()),
    )


def get_calibration(channel):
    r = one("SELECT * FROM calibration WHERE channel=?", (channel,))
    return dict(r) if r else None


def set_calibration(channel, a_const, error_estimate, method, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    prev = get_calibration(channel)
    discontinuity = 0
    if prev and abs(prev["a_const"] - a_const) > 2.0:
        discontinuity = 1
    with _lock:
        c = _conn()
        c.execute(
            """INSERT INTO calibration(channel, a_const, measured_utc, error_estimate, method, prev_a_const, discontinuity)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(channel) DO UPDATE SET a_const=excluded.a_const, measured_utc=excluded.measured_utc,
                 error_estimate=excluded.error_estimate, method=excluded.method,
                 prev_a_const=calibration.a_const, discontinuity=excluded.discontinuity""",
            (channel, a_const, now, error_estimate, method, prev["a_const"] if prev else None, discontinuity),
        )
        c.execute(
            "INSERT INTO calibration_history(channel, a_const, measured_utc, error_estimate, method) VALUES (?,?,?,?,?)",
            (channel, a_const, now, error_estimate, method),
        )
    return discontinuity


def get_calibration_history(channel):
    """Every calibration measurement stored for `channel` (a_const, measured_utc, error_estimate, method), oldest
    first — timebase.choose_label decides which of them, if any, applies to a piece of footage."""
    return [dict(r) for r in query(
        "SELECT a_const, measured_utc, error_estimate, method FROM calibration_history WHERE channel=? ORDER BY measured_utc",
        (channel,))]


def get_calibration_near(channel, target_utc):
    """The historical calibration measurement closest to target_utc (an ISO 8601 string or datetime) — old
    footage should use whichever a_const was valid when it was recorded, not necessarily the latest one
    (docs/SPEC.md section 2.4). None if this channel has no calibration history at all yet."""
    import datetime as _dt

    def _epoch(v):
        if isinstance(v, _dt.datetime):
            return v.timestamp()
        return _dt.datetime.fromisoformat(v).timestamp()

    target = _epoch(target_utc)
    rows = query("SELECT * FROM calibration_history WHERE channel=?", (channel,))
    if not rows:
        return None
    best = min(rows, key=lambda r: abs(_epoch(r["measured_utc"]) - target))
    return dict(best)
