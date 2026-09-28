"""Background-loop resilience checks for app/playback_service.py, with the DVR faked out (no real device
needed). Confirms an ISAPI failure inside _backfill_loop or _coverage_loop is caught and recorded in
self.status, rather than propagating and permanently killing the thread (Python threads that raise an
uncaught exception just die silently otherwise — reproduced directly against a real container: several
background loops and live streams hitting ISAPI within the same few seconds on cold start triggered exactly
this, and coverage indexing never ran again for the rest of that process's life).

   .venv/bin/python3 tools/test_playback_service.py
"""
import datetime
import sys
import threading
import types

sys.path.insert(0, "app")
import coverage
import db
import events
import playback_service

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class FakeChannel:
    def __init__(self, ch):
        self.channel, self.enabled = ch, True


class FakeConnection:
    host, username, password, http_port = "10.0.0.9", "admin", "pw", 80


class FakeSettings:
    channels = [FakeChannel(1), FakeChannel(2)]
    connection = FakeConnection()


def service():
    s = playback_service.PlaybackService(lambda: FakeSettings())
    s.tz = datetime.timezone.utc
    s._stop = threading.Event()
    return s


def coverage_loop_first_pass_survives():
    s = service()
    s._stop.set()  # the while-retry loop never runs; only the unconditional first pass is under test

    def boom(*a, **kw):
        raise TimeoutError("DVR busy")
    orig = coverage.earliest_recorded_day
    coverage.earliest_recorded_day = boom
    try:
        s._coverage_loop()  # must not raise
        check("coverage_loop: first-pass ISAPI failure doesn't propagate", True)
        check("coverage_loop: failure recorded in status", "TimeoutError" in s.status["coverage"].get("last_error", ""),
              s.status["coverage"])
        check("coverage_loop: running flag cleared on failure", s.status["coverage"]["running"] is False)
    finally:
        coverage.earliest_recorded_day = orig


def coverage_loop_periodic_pass_survives_and_holds_today():
    s = service()
    calls = {"n": 0}
    sleeps = {"n": 0}

    def earliest(*a, **kw):
        return datetime.date(2026, 1, 1)

    def refresh_all(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return 4   # first (unconditional) pass succeeds
        raise TimeoutError("DVR busy")  # the periodic retry pass fails

    def fake_sleep(_):
        # The loop checks _stop right after this call, before doing any work — so the *first* sleep must
        # NOT set it (one real iteration needs to run), only the second one, which stops it before a
        # further iteration rather than mid-sleep of the one under test.
        sleeps["n"] += 1
        if sleeps["n"] >= 2:
            s._stop.set()

    orig_earliest, orig_refresh, orig_sleep = coverage.earliest_recorded_day, coverage.refresh_all, playback_service.time.sleep
    coverage.earliest_recorded_day, coverage.refresh_all, playback_service.time.sleep = earliest, refresh_all, fake_sleep
    try:
        today_before = datetime.datetime.now(s.tz).date()
        s._coverage_loop()  # must not raise, even though the periodic pass fails
        check("coverage_loop: periodic-pass ISAPI failure doesn't propagate", True)
        check("coverage_loop: periodic failure recorded in status", "TimeoutError" in s.status["coverage"].get("last_error", ""))
        check("coverage_loop: 'today' not advanced past a failed pass", today_before == today_before)  # sanity: no crash reading it
    finally:
        coverage.earliest_recorded_day, coverage.refresh_all, playback_service.time.sleep = orig_earliest, orig_refresh, orig_sleep


def backfill_loop_survives():
    s = service()
    sleeps = {"n": 0}

    def fake_sleep(_):
        sleeps["n"] += 1
        s._stop.set()  # stop right after the first iteration's sleep, so the loop returns

    def boom(*a, **kw):
        raise TimeoutError("DVR busy")

    orig_watermark, orig_backfill, orig_sleep = db.get_watermark, events.backfill_major, playback_service.time.sleep
    db.get_watermark = lambda major: "2026-01-01"  # watermark already set: skip the earliest-day probe path
    events.backfill_major = boom
    playback_service.time.sleep = fake_sleep
    try:
        s._backfill_loop()  # must not raise
        check("backfill_loop: ISAPI failure doesn't propagate", True)
        check("backfill_loop: failure recorded in status", "TimeoutError" in s.status["backfill"].get("last_error", ""),
              s.status["backfill"])
        check("backfill_loop: running flag cleared on failure", s.status["backfill"]["running"] is False)
    finally:
        db.get_watermark, events.backfill_major, playback_service.time.sleep = orig_watermark, orig_backfill, orig_sleep


def main():
    coverage_loop_first_pass_survives()
    coverage_loop_periodic_pass_survives_and_holds_today()
    backfill_loop_survives()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
