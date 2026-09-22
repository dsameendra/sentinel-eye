"""SQLite storage for playback: events, DVR coverage, backfill watermarks, per-channel clock calibration.
WAL mode (concurrent readers, one writer); a module lock serializes writes from our own threads."""
import json
import sqlite3
import threading

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

CREATE TABLE IF NOT EXISTS calibration (
    channel INTEGER PRIMARY KEY,
    a_const REAL NOT NULL,        -- abs_utc_seconds = a_const + rtp_ts/90000  (rtp_ts pre-unwrap, see timebase.py)
    measured_utc TEXT NOT NULL,
    error_estimate REAL,          -- seconds; from the OSD tick-over check
    method TEXT,                  -- 'osd_tick' | 'fallback_requested_time'
    prev_a_const REAL,            -- for discontinuity detection
    discontinuity INTEGER DEFAULT 0
);

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


def init():
    with _lock:
        _conn().executescript(SCHEMA)


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


def upsert_event(source, channel, kind, start_utc, end_utc, confidence=None, region=None, attrs=None,
                  snapshot_path=None, now=None):
    """Insert, or extend end_utc if this exact (source, channel, kind, start_utc) already exists (e.g. a
    Start seen twice, or a live event later confirmed by log backfill)."""
    import datetime
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    with _lock:
        c = _conn()
        c.execute(
            """INSERT INTO events(source, channel, kind, start_utc, end_utc, confidence, region_json, attrs_json, snapshot_path, created_utc)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source, channel, kind, start_utc) DO UPDATE SET
                 end_utc = excluded.end_utc WHERE excluded.end_utc > events.end_utc""",
            (source, channel, kind, start_utc, end_utc, confidence,
             json.dumps(region) if region is not None else None,
             json.dumps(attrs) if attrs is not None else None, snapshot_path, now),
        )


def get_watermark(log_type):
    r = one("SELECT last_completed_day FROM backfill_watermark WHERE log_type=?", (log_type,))
    return r["last_completed_day"] if r else None


def set_watermark(log_type, day):
    import datetime
    write(
        "INSERT INTO backfill_watermark(log_type, last_completed_day, updated_utc) VALUES (?,?,?) "
        "ON CONFLICT(log_type) DO UPDATE SET last_completed_day=excluded.last_completed_day, updated_utc=excluded.updated_utc",
        (log_type, day, datetime.datetime.now(datetime.timezone.utc).isoformat()),
    )


def get_calibration(channel):
    r = one("SELECT * FROM calibration WHERE channel=?", (channel,))
    return dict(r) if r else None


def set_calibration(channel, a_const, error_estimate, method, now=None):
    import datetime
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    prev = get_calibration(channel)
    discontinuity = 0
    if prev and abs(prev["a_const"] - a_const) > 2.0:
        discontinuity = 1
    with _lock:
        _conn().execute(
            """INSERT INTO calibration(channel, a_const, measured_utc, error_estimate, method, prev_a_const, discontinuity)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(channel) DO UPDATE SET a_const=excluded.a_const, measured_utc=excluded.measured_utc,
                 error_estimate=excluded.error_estimate, method=excluded.method,
                 prev_a_const=calibration.a_const, discontinuity=excluded.discontinuity""",
            (channel, a_const, now, error_estimate, method, prev["a_const"] if prev else None, discontinuity),
        )
    return discontinuity
