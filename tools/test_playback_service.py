"""Background-loop checks for app/playback_service.py, with the DVR faked out (no real device needed).

Confirms an ISAPI failure inside a backfill or coverage pass is caught and recorded in self.status rather than
propagating and permanently killing the thread (Python threads that raise an uncaught exception just die
silently otherwise — reproduced directly against a real container: several background loops and live streams
hitting ISAPI within the same few seconds on cold start triggered exactly this, and coverage indexing never ran
again for the rest of that process's life). Also: one refused day doesn't abort the coverage index and is
retried with backoff; loops read settings afresh each pass; stop()/reload() cut waits short; nothing contacts
the recorder while the lockout breaker is tripped; calibration honours a channel's SD path override.

   .venv/bin/python3 tools/test_playback_service.py
"""
import datetime
import os
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-playback-service-")
sys.path.insert(0, "app")
import coverage
import db
import events
import isapi
import playback_service
import recorder_guard
import settings as cfg
import timebase

PASS = []


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def make_settings(channels=(1, 2), host="10.0.0.9", sub_path=""):
    return cfg.Settings(connection=cfg.Connection(host=host, username="admin", password="pw"),
                        channels=[cfg.Channel(id=f"c{n}", channel=n, sub_path=sub_path if n == 1 else "") for n in channels])


class Holder:
    def __init__(self, s):
        self.s = s

    def __call__(self):
        return self.s


def service(settings=None):
    h = Holder(settings or make_settings())
    s = playback_service.PlaybackService(h)
    s.tz = datetime.timezone.utc
    s.holder = h
    return s


class Patch:
    """Temporarily replace module attributes; restores on exit."""
    def __init__(self, *triples):
        self.triples, self.saved = triples, []

    def __enter__(self):
        for mod, name, val in self.triples:
            self.saved.append((mod, name, getattr(mod, name)))
            setattr(mod, name, val)
        return self

    def __exit__(self, *a):
        for mod, name, val in reversed(self.saved):
            setattr(mod, name, val)


def boom(*a, **kw):
    raise TimeoutError("DVR busy")


def coverage_first_pass_failure_recorded():
    s = service()
    with Patch((coverage, "earliest_recorded_day", boom)):
        s._coverage_pass()  # must not raise
    check("coverage: a first-pass ISAPI failure doesn't propagate", True)
    check("coverage: failure recorded in status", "TimeoutError" in s.status["coverage"].get("last_error", ""), s.status["coverage"])
    check("coverage: running flag cleared on failure", s.status["coverage"]["running"] is False)


def coverage_one_bad_day_doesnt_abort():
    s = service(make_settings(channels=(1,)))
    today = datetime.datetime.now(datetime.timezone.utc).date()
    earliest = today - datetime.timedelta(days=5)
    bad = today - datetime.timedelta(days=3)
    calls = []

    def refresh_day(api, ch, day, tz):
        calls.append(day)
        if day == bad:
            raise isapi.DvrRequestError("recording search", 500)
        return []

    with Patch((coverage, "earliest_recorded_day", lambda *a, **k: earliest), (coverage, "refresh_day", refresh_day)):
        s._coverage_pass()
        first = list(calls)
        check("coverage: every day of the first pass was tried despite one refusal", first == [earliest + datetime.timedelta(days=i) for i in range(6)], first)
        check("coverage: the refused day is reported, not fatal",
              "1 day(s)" in s.status["coverage"].get("last_error", "") and s.status["coverage"]["failed_days"] == 1, s.status["coverage"])
        check("coverage: other days indexed", s.status["coverage"]["days_x_channels_indexed"] == 5, s.status["coverage"])
        calls.clear()
        s._coverage_pass()
        recent = {today - datetime.timedelta(days=1), today}
        check("coverage: next pass re-fetches only yesterday+today (old days indexed once, the bad day backs off)",
              set(calls) == recent, calls)
        # backoff elapsed: the bad day is retried, and on success clears
        key = (1, bad)
        s._cov["failed"][key] = (0.0, s._cov["failed"][key][1])
        calls.clear()
        s._coverage_pass()
        check("coverage: a failed day is retried once its backoff has passed", bad in calls, calls)
        check("coverage: ...and still failing doubles its backoff", s._cov["failed"][key][1] == 2)

    def refresh_ok(api, ch, day, tz):
        calls.append(day)
        return []
    s._cov["failed"][key] = (0.0, 2)
    with Patch((coverage, "earliest_recorded_day", lambda *a, **k: earliest), (coverage, "refresh_day", refresh_ok)):
        s._coverage_pass()
    check("coverage: a retried day that succeeds clears the error", "last_error" not in s.status["coverage"]
          and not s._cov["failed"], s.status["coverage"])


def coverage_reads_settings_each_pass():
    s = service(make_settings(channels=(1,)))
    today = datetime.datetime.now(datetime.timezone.utc).date()
    seen = set()

    def refresh_day(api, ch, day, tz):
        seen.add((ch, api.host))
        return []

    with Patch((coverage, "earliest_recorded_day", lambda *a, **k: today), (coverage, "refresh_day", refresh_day)):
        s._coverage_pass()
        s.holder.s = make_settings(channels=(1, 3), host="10.0.0.42")
        s.reload(connection_changed=True)
        s._coverage_pass()
    check("coverage: a changed channel list and host apply on the next pass (no restart)",
          (3, "10.0.0.42") in seen and (1, "10.0.0.42") in seen, seen)


def backfill_failure_recorded():
    s = service()
    with Patch((db, "get_watermark", lambda major: "2026-01-01"), (events, "backfill_major", boom)):
        s._backfill_pass()  # must not raise
    check("backfill: ISAPI failure doesn't propagate", True)
    check("backfill: failure recorded in status", "TimeoutError" in s.status["backfill"].get("last_error", ""), s.status["backfill"])
    check("backfill: running flag cleared on failure", s.status["backfill"]["running"] is False)


def loops_wait_while_breaker_tripped():
    s = service()
    contacted = []
    note = lambda *a, **k: contacted.append(a) or []
    recorder_guard.trip(s._fp(), "test")
    try:
        with Patch((coverage, "earliest_recorded_day", note), (coverage, "refresh_day", note),
                   (events, "backfill_major", note), (timebase, "calibrate_channel", note)):
            threads = []
            for loop, key in ((s._coverage_loop, ("coverage", "waiting")), (s._backfill_loop, ("backfill", "waiting")),
                              (s._calibrate_all, ("calibration_waiting",))):
                t = threading.Thread(target=loop, daemon=True)
                t.start()
                threads.append(t)
                time.sleep(0.2)
                st = s.status
                for k in key:
                    st = st.get(k, {}) if isinstance(st, dict) else {}
                check(f"breaker: {loop.__name__} waits, saying why", st == recorder_guard.MESSAGE, st)
            check("breaker: no loop contacted the recorder", not contacted, contacted)
            s.stop()
            t0 = time.time()
            for th in threads:
                th.join(2)
            check("stop(): waiting loops end promptly", time.time() - t0 < 1 and not any(th.is_alive() for th in threads),
                  time.time() - t0)
    finally:
        recorder_guard.clear()


def reload_wakes_a_sleeping_loop():
    s = service()
    passes = []
    s._coverage_pass = lambda: passes.append(time.time())
    t = threading.Thread(target=s._coverage_loop, daemon=True)
    t.start()
    time.sleep(0.2)
    s._probe_needed = False
    s.wake()
    time.sleep(0.2)
    check("wake(): a loop asleep for 30 min starts its next pass at once", len(passes) == 2, passes)
    s.reload(connection_changed=False)
    time.sleep(0.2)
    check("reload(): loops hold off until the one probing login has answered",
          len(passes) == 2 and s.status["coverage"].get("waiting") == "Checking the recorder connection", s.status["coverage"])
    s._probe_needed = False
    s.wake()
    time.sleep(0.2)
    check("...and resume once it has", len(passes) == 3, passes)
    s.stop()
    t.join(2)
    check("stop(): the loop thread exits", not t.is_alive())


def tz_loop_probes_then_releases():
    s = service()
    started = []

    class FakeSub:
        def __init__(self, api, tz, open_starts=None):
            self.api, self.tz, self._open_starts = api, tz, open_starts if open_starts is not None else {}
            self.connected, self.last_event_utc = False, None
            started.append(self)

        def start(self):
            pass

        def stop(self):
            self.stopped = True

    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    with Patch((events, "AlertStreamSubscriber", FakeSub), (events, "tz_local", lambda api: ist)):
        s.subscriber = FakeSub(s._api(), s.tz, {("motion", 1): ["x", "x"]})
        started.clear()
        s.reload(connection_changed=False)
        t = threading.Thread(target=s._tz_loop, daemon=True)
        t.start()
        time.sleep(0.3)
        check("tz loop: re-reads the recorder's offset (daylight saving is picked up)", s.tz == ist, s.tz)
        check("tz loop: after a reload, its login goes first, then the subscriber restarts",
              len(started) == 1 and not s._probe_needed, (started, s._probe_needed))
        check("reload: events in progress carry over to the new subscriber", started and ("motion", 1) in started[0]._open_starts)
        s.stop()
        t.join(2)


def bootstrap_never_guesses_utc():
    s = service()
    s.tz = None

    def bad_tz(api):
        raise isapi.DvrRequestError("clock", 503)

    with Patch((events, "tz_local", bad_tz)):
        t = threading.Thread(target=s._bootstrap, daemon=True)
        t.start()
        time.sleep(0.3)
        s.stop()
        t.join(2)
    check("bootstrap: a refused clock read leaves tz unknown (no UTC guess)", s.tz is None and "503" in s.status.get("dvr_error", ""),
          s.status.get("dvr_error"))


def calibration_uses_sub_path_override():
    s = service(make_settings(channels=(1, 2), sub_path="/custom/sd"))
    paths = []

    def cal(conn, api, ch, path):
        paths.append((ch, path))
        return {"error": "no tick"}

    with Patch((timebase, "calibrate_channel", cal)):
        s._calibrate_pass()
    check("calibration: honours the channel's SD path override", (1, "/custom/sd") in paths, paths)
    check("calibration: standard path otherwise", (2, "/Streaming/Channels/202") in paths, paths)


def main():
    db.init()
    coverage_first_pass_failure_recorded()
    coverage_one_bad_day_doesnt_abort()
    coverage_reads_settings_each_pass()
    backfill_failure_recorded()
    loops_wait_while_breaker_tripped()
    reload_wakes_a_sleeping_loop()
    tz_loop_probes_then_releases()
    bootstrap_never_guesses_utc()
    calibration_uses_sub_path_override()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
