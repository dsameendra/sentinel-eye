"""Background jobs for playback (M0): DB init, per-channel clock calibration, DVR log backfill (watermarked,
resumable), the live alertStream subscriber, and the coverage index. Wired into server.py's lifespan."""
import datetime
import threading
import time

import coverage
import db
import events
import isapi
import timebase


class PlaybackService:
    def __init__(self, get_settings):
        self.get_settings = get_settings
        self._stop = threading.Event()
        self.subscriber = None
        self.status = {"calibration": {}, "backfill": {"running": False}, "coverage": {"running": False}}
        self._threads = []
        self.tz = None

    def _api(self):
        c = self.get_settings().connection
        return isapi.Isapi(c.host, c.username, c.password, c.http_port)

    def _tz(self):
        return events.tz_local(self._api())

    def start(self):
        db.init()
        # Everything past here needs the DVR. Don't block server startup on it: with no host configured yet
        # (fresh install) or the DVR offline, the UI still has to come up so the operator can fix Settings.
        self._spawn(self._bootstrap)

    def _bootstrap(self):
        delay = 5
        while not self._stop.is_set():
            if self.get_settings().connection.host:
                try:
                    self.tz = self._tz()
                    break
                except Exception as e:
                    self.status["dvr_error"] = f"{type(e).__name__}: {e}"
            if self._stop.wait(delay):
                return
            delay = min(delay * 2, 60)
        if self._stop.is_set():
            return
        self.status.pop("dvr_error", None)
        self.subscriber = events.AlertStreamSubscriber(self._api(), self.tz)
        self.subscriber.start()
        self._spawn(self._calibrate_all)
        self._spawn(self._backfill_loop)
        self._spawn(self._coverage_loop)

    def stop(self):
        self._stop.set()
        if self.subscriber:
            self.subscriber.stop()

    def _spawn(self, fn):
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        self._threads.append(t)

    def _channels(self):
        return [c.channel for c in self.get_settings().channels if c.enabled]

    def _calibrate_all(self):
        api = self._api()
        conn_relay = _relay_conn(self.get_settings())
        while not self._stop.is_set():
            for ch in self._channels():
                if self._stop.is_set():
                    break
                cached = db.get_calibration(ch)
                fresh = cached and _age_hours(cached["measured_utc"]) < 6
                if fresh:
                    self.status["calibration"][ch] = {"a_const": cached["a_const"], "error_estimate": cached["error_estimate"],
                                                        "measured_utc": cached["measured_utc"], "discontinuity": bool(cached["discontinuity"])}
                    continue
                try:
                    r = timebase.calibrate_channel(conn_relay, api, ch, f"/Streaming/Channels/{ch}02")
                except Exception as e:
                    r = {"error": f"{type(e).__name__}: {e}"}
                if "a_const" in r:
                    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                    disc = db.set_calibration(ch, r["a_const"], r["error_estimate"], r["method"], now)
                    self.status["calibration"][ch] = {"a_const": r["a_const"], "error_estimate": r["error_estimate"],
                                                        "measured_utc": now, "discontinuity": bool(disc)}
                else:
                    self.status["calibration"].setdefault(ch, {})["last_error"] = r.get("error")
            time.sleep(60)  # re-check the whole list once a minute; per-channel skip keeps this cheap

    def _backfill_loop(self):
        api = self._api()
        tz = self.tz
        while not self._stop.is_set():
            self.status["backfill"]["running"] = True
            try:
                for major in ("Alarm", "Exception"):
                    if db.get_watermark(major) is None:
                        earliest = None
                        for ch in self._channels():
                            d = coverage.earliest_recorded_day(api, ch, tz)
                            if d and (earliest is None or d < earliest):
                                earliest = d
                        since = earliest or (datetime.datetime.now(tz).date() - datetime.timedelta(days=1))
                        db.write("INSERT OR IGNORE INTO backfill_watermark(log_type, last_completed_day, updated_utc) VALUES (?,?,?)",
                                 (major, (since - datetime.timedelta(days=1)).isoformat(), datetime.datetime.now(datetime.timezone.utc).isoformat()))
                    r = events.backfill_major(api, major, tz, stop_event=self._stop)
                    self.status["backfill"][major] = r
                self.status["backfill"].pop("last_error", None)
            except Exception as e:
                # A transient ISAPI failure (the DVR briefly refusing a request under load — confirmed
                # directly: several background loops and live streams all hit ISAPI within the same few
                # seconds on a real container's cold start) must not permanently kill this thread. Without
                # this, one bad call stops backfill forever until the process restarts, silently.
                self.status["backfill"]["last_error"] = f"{type(e).__name__}: {e}"
            self.status["backfill"]["running"] = False
            time.sleep(3600)  # re-check for new days once an hour; watermark makes this cheap after the first pass

    def _coverage_loop(self):
        api = self._api()
        tz = self.tz
        chans = self._channels()
        today = datetime.datetime.now(tz).date()
        try:
            earliest = min((coverage.earliest_recorded_day(api, ch, tz) for ch in chans), default=None,
                            key=lambda d: d or datetime.date.max)
            if earliest:
                self.status["coverage"]["running"] = True
                n = coverage.refresh_all(api, chans, tz, earliest, today, stop_event=self._stop)
                self.status["coverage"] = {"running": False, "days_x_channels_indexed": n, "earliest": earliest.isoformat()}
        except Exception as e:
            # Same reasoning as _backfill_loop: a transient ISAPI failure here must not permanently kill the
            # periodic re-index below — this exact call is what died on a real container's cold start,
            # confirmed directly, taking the whole thread down before it ever reached the retry loop.
            self.status["coverage"]["running"] = False
            self.status["coverage"]["last_error"] = f"{type(e).__name__}: {e}"
        while not self._stop.is_set():
            time.sleep(1800)
            if self._stop.is_set():
                break
            try:
                coverage.refresh_all(api, chans, tz, today - datetime.timedelta(days=1), datetime.datetime.now(tz).date())
                today = datetime.datetime.now(tz).date()
                self.status["coverage"].pop("last_error", None)
            except Exception as e:
                # today is deliberately left unadvanced on failure, so the next pass retries the same
                # range instead of silently skipping whatever day just failed to index.
                self.status["coverage"]["last_error"] = f"{type(e).__name__}: {e}"


def _relay_conn(settings):
    import hikrelay as h
    return h.conn_of({"connection": settings.connection.model_dump()})


def _age_hours(iso):
    t = datetime.datetime.fromisoformat(iso)
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 3600
