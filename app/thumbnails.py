"""On-demand event thumbnails: one JPEG frame captured from the DVR near an event's midpoint (start+end)/2,
so a clip that spans several seconds is represented by what was happening partway through it, not just its
first instant. Cached to disk and referenced from events.snapshot_path (the column the schema already has
for this) so each event is only ever captured once, not regenerated on every request."""
import datetime
import subprocess
import tempfile
import threading
from pathlib import Path

import db
import hikrelay as h
import playback_session as psess
from settings import DATA

THUMB_DIR = DATA / "thumbnails"

_locks = {}
_locks_guard = threading.Lock()


def path_for(event_id):
    return THUMB_DIR / f"{event_id}.jpg"


def get_or_generate(event, connection_dict, main_path_override, tz_offset_min):
    """event: a dict row from the events table (id, channel, start_utc, end_utc, snapshot_path).
    Serialized per event_id so concurrent requests for the same thumbnail don't each open a DVR session."""
    cached = event.get("snapshot_path")
    if cached and Path(cached).exists():
        return Path(cached)

    with _locks_guard:
        lock = _locks.setdefault(event["id"], threading.Lock())
    with lock:
        # re-check: another request may have generated it while we waited for the lock
        row = db.one("SELECT snapshot_path FROM events WHERE id=?", (event["id"],))
        if row and row["snapshot_path"] and Path(row["snapshot_path"]).exists():
            return Path(row["snapshot_path"])
        try:
            return _generate(event, connection_dict, main_path_override, tz_offset_min)
        finally:
            with _locks_guard:
                _locks.pop(event["id"], None)


def _generate(event, connection_dict, main_path_override, tz_offset_min):
    start = datetime.datetime.fromisoformat(event["start_utc"])
    end = datetime.datetime.fromisoformat(event["end_utc"])
    mid = start + (end - start) / 2

    conn = h.conn_of({"connection": connection_dict})
    ch = event["channel"]
    a_const = psess.calibration_for(ch)
    if a_const is None:
        raise RuntimeError("This channel has no clock calibration yet")
    tz = datetime.timezone(datetime.timedelta(minutes=tz_offset_min))
    path = h.playback_path(ch, main_path_override or "")

    reader = psess.PlaybackReader(conn, ch, path, a_const, mid.isoformat(), tz, "1")
    reader.start()
    nal = None
    try:
        for _ in range(5):  # the first access unit should already be a decodable keyframe (StartGate)
            item = reader.q.get(timeout=15)
            if item is None:
                break
            if item[0] == "error":
                raise RuntimeError(item[1])
            nal = item[2]
            break
    finally:
        reader.stop()
    if nal is None:
        raise RuntimeError("No frame available at that time")

    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out_path = path_for(event["id"])
    with tempfile.NamedTemporaryFile(suffix=".hevc", delete=False) as f:
        f.write(nal)
        tmp = f.name
    try:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "hevc", "-i", tmp, "-frames:v", "1",
                         "-vf", "scale=320:-1", "-q:v", "5", str(out_path)], check=True, timeout=20)
    finally:
        Path(tmp).unlink(missing_ok=True)

    db.write("UPDATE events SET snapshot_path=? WHERE id=?", (str(out_path), event["id"]))
    return out_path
