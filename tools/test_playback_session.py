"""Checks for app/playback_session.py's input guards (no recorder): only NICE_SPEEDS and ISO 8601 instants ever
reach the recorder's RTSP request, a naive time is UTC (not the host's zone), and a reader fails fast — without
taking a session slot or logging in — while the lockout breaker is tripped.

   .venv/bin/python3 tools/test_playback_session.py
"""
import datetime
import os
import sys
import tempfile

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-playback-session-")
sys.path.insert(0, "app")
import playback_session as psess
import recorder_guard

PASS = []


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def speeds():
    for v in psess.NICE_SPEEDS:
        check(f"speed {v!r} accepted", psess.valid_speed(v) == v)
    for v, want in ((2, "2"), (0.5, "0.5"), (0.125, "0.125"), (16.0, "16")):
        check(f"numeric speed {v!r} -> {want!r}", psess.valid_speed(v) == want)
    for v in ("3", "1\r\nX-Evil: 1", "", None, "-1", "1e1", True, [], "16 ", "+2"):
        check(f"speed {v!r} refused", psess.valid_speed(v) is None)


def times():
    utc = datetime.timezone.utc
    want = datetime.datetime(2026, 5, 1, 10, 0, tzinfo=utc)
    for v in ("2026-05-01T10:00:00Z", "2026-05-01T10:00:00.000Z", "2026-05-01T15:30:00+05:30", "2026-05-01T10:00:00"):
        check(f"time {v!r} parsed as {want.isoformat()}", psess.parse_utc(v) == want, psess.parse_utc(v))
    for v in ("yesterday", "", None, 1714557600, "2026-05-01T10:00:00Z\r\nX: y", "x" * 100):
        check(f"time {v!r} refused", psess.parse_utc(v) is None)


def reader_controls():
    r = psess.PlaybackReader({"host": "h", "port": 554, "user": "u", "pw": "p", "encrypted": False, "key": ""},
                             1, "/Streaming/tracks/101", 1.0, "2026-05-01T10:00:00Z", datetime.timezone.utc)
    r.seek("not a time", "2")
    check("reader: a non-ISO seek is ignored", r._seek_to is None and r._new_speed is None)
    r.seek("2026-05-01T10:00:00Z", "1\r\nX: y")
    check("reader: a valid seek with a bad speed seeks, keeping the speed",
          r._seek_to == "2026-05-01T10:00:00+00:00" and r._new_speed is None, (r._seek_to, r._new_speed))
    r.set_speed("3")
    check("reader: an unknown speed is ignored", r._new_speed is None)
    r.set_speed("4")
    check("reader: a valid speed applies", r._new_speed == "4")


def reader_fails_fast_when_tripped():
    conn = {"host": "10.0.0.9", "port": 554, "user": "admin", "pw": "bad", "encrypted": False, "key": ""}
    recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", "bad"), "test")
    try:
        busy = psess.pool.busy
        r = psess.PlaybackReader(conn, 1, "/Streaming/tracks/101", 1.0, "2026-05-01T10:00:00Z", datetime.timezone.utc)
        r._run()
        item = r.q.get_nowait()
        check("reader: breaker tripped -> the fix-it error, at once", item == ("error", recorder_guard.MESSAGE), item)
        check("reader: ...without taking a playback slot", psess.pool.busy == busy and r.client is None)
    finally:
        recorder_guard.clear()


def main():
    speeds()
    times()
    reader_controls()
    reader_fails_fast_when_tripped()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
