"""Background jobs for playback (M0): DB init, per-channel clock calibration, DVR log backfill (watermarked,
resumable), the live alertStream subscriber, the coverage index, and the recorder clock (re-read hourly, for
daylight saving). Wired into server.py's lifespan.

Every loop reads the settings afresh on each pass, so a changed connection or channel list applies without a
restart; server.py calls reload() when they change. Every wait goes through _sleep(), which stop() and wake()
cut short, so shutting down or reloading is prompt instead of waiting out an hour-long sleep.

While the recorder is rejecting the saved credentials (recorder_guard), no loop logs in: each one records why it
is waiting and sleeps until reload()/wake(). After a reload, one login — the clock read in _tz_loop — goes first
and the others wait for it, so a still-wrong password costs one failed login, not one per loop at once. (Logins
from elsewhere — live relays, playback panes — are serialised by recorder_guard.login_lock, so the first
rejection anywhere stops the rest.)"""
import datetime
import threading
import time

import coverage
import db
import events
import hikrelay
import isapi
import recorder_guard
import timebase

CALIBRATE_PERIOD_S = 60      # re-check the whole list once a minute; per-channel freshness skip keeps this cheap
BACKFILL_PERIOD_S = 3600     # new days (and today's re-check) once an hour; the watermark makes this cheap
COVERAGE_PERIOD_S = 1800
TZ_PERIOD_S = 3600           # the recorder's UTC offset changes with daylight saving; an hour late at worst
COVERAGE_RETRY_MAX_S = 86400


class PlaybackService:
    def __init__(self, get_settings):
        self.get_settings = get_settings
        self._stop = threading.Event()
        self._cv = threading.Condition()
        self._gen = 0                 # bumped by wake(): every loop waiting in _sleep() starts its next pass now
        self._probe_needed = False    # after a reload: the clock read logs in first, alone (module docstring)
        self._sub_lock = threading.Lock()
        self.subscriber = None
        self.status = {"calibration": {}, "backfill": {"running": False}, "coverage": {"running": False}}
        self._threads = []
        self.tz = None
        self._reset_coverage_cache()

    # ------------------------------------------------------------------ plumbing
    def _reset_coverage_cache(self):
        # indexed: (channel, day) refreshed by this process — days before yesterday never change, so they are
        # fetched once. failed: (channel, day) -> (retry_after_monotonic, attempts), so a day the recorder keeps
        # refusing is retried with backoff instead of stalling every pass. earliest: channel -> first recorded day.
        self._cov = {"indexed": set(), "failed": {}, "earliest": {}}

    def _api(self, settings=None):
        c = (settings or self.get_settings()).connection
        return isapi.Isapi(c.host, c.username, c.password, c.http_port)

    def _fp(self):
        c = self.get_settings().connection
        return recorder_guard.fingerprint(c.host, c.username, c.password)

    def _tz(self):
        return events.tz_local(self._api())

    def _blocked(self, ignore_probe=False):
        """Why the loops mustn't contact the recorder right now, or None."""
        if not self.get_settings().connection.host:
            return "No recorder configured"
        if recorder_guard.tripped(self._fp()):
            return recorder_guard.MESSAGE
        if self._probe_needed and not ignore_probe:
            return "Checking the recorder connection"
        return None

    def _sleep(self, seconds, gen=None):
        """Wait up to `seconds`; returns early on stop() or on a wake() since `gen` (the generation the caller
        read at the start of its pass, so a wake that lands mid-pass isn't lost). True when stopping."""
        with self._cv:
            if gen is None:
                gen = self._gen
            self._cv.wait_for(lambda: self._stop.is_set() or self._gen != gen, timeout=seconds)
        return self._stop.is_set()

    def wake(self):
        """Start every loop's next pass now (settings saved, breaker cleared)."""
        with self._cv:
            self._gen += 1
            self._cv.notify_all()

    def _spawn(self, fn):
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        self._threads.append(t)

    def _channels(self):
        return [c.channel for c in self.get_settings().channels if c.enabled]

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        db.init()
        # Everything past here needs the DVR. Don't block server startup on it: with no host configured yet
        # (fresh install) or the DVR offline, the UI still has to come up so the operator can fix Settings.
        self._spawn(self._bootstrap)

    def _bootstrap(self):
        delay = 5
        while not self._stop.is_set():
            gen = self._gen
            reason = self._blocked(ignore_probe=True)   # this clock read IS the first login
            if reason is None:
                try:
                    self.tz = self._tz()
                    break
                except Exception as e:
                    self.status["dvr_error"] = str(e) if isinstance(e, recorder_guard.RecorderAuthBlocked) \
                        else f"{type(e).__name__}: {e}"
            else:
                self.status["dvr_error"] = reason
            if self._sleep(delay, gen):
                return
            delay = min(delay * 2, 60)
        if self._stop.is_set():
            return
        self.status.pop("dvr_error", None)
        self._probe_needed = False
        self._restart_subscriber()
        self._spawn(self._calibrate_all)
        self._spawn(self._backfill_loop)
        self._spawn(self._coverage_loop)
        self._spawn(self._tz_loop)

    def reload(self, connection_changed=True):
        """Settings changed (connection or channels). The loops already read settings on every pass; this
        restarts the alertStream with the new connection (after the clock read has checked it — see the module
        docstring) and starts every loop's next pass now. `connection_changed`: a different recorder (host or
        HTTP port), so the in-memory coverage index starts over; a new password alone keeps it."""
        if connection_changed:
            self._reset_coverage_cache()   # possibly another recorder: what was indexed says nothing about it
        self._probe_needed = True
        self.wake()

    def stop(self):
        self._stop.set()
        with self._cv:
            self._cv.notify_all()
        if self.subscriber:
            self.subscriber.stop()

    def _restart_subscriber(self):
        with self._sub_lock:
            old = self.subscriber
            open_starts = old._open_starts if old else None   # events in progress stay one span across it
            if old:
                old.stop()
            self.subscriber = None
            if self.get_settings().connection.host:
                # A new subscriber with the current credentials; it waits by itself while the breaker blocks them.
                self.subscriber = events.AlertStreamSubscriber(self._api(), self.tz, open_starts)
                self.subscriber.start()

    # ------------------------------------------------------------------ loops
    def _tz_loop(self):
        """Re-reads the recorder's UTC offset hourly (daylight saving), and is the single first login after a
        reload: only once it has answered do the subscriber and the other loops go back to the recorder."""
        while not self._stop.is_set():
            gen = self._gen
            probing = self._probe_needed
            if self._blocked(ignore_probe=True) is None:
                try:
                    tz = self._tz()
                    if tz != self.tz:
                        self.tz = tz
                        if self.subscriber:
                            self.subscriber.tz = tz
                    self.status.pop("tz_error", None)
                except Exception as e:
                    self.status["tz_error"] = f"{type(e).__name__}: {e}"
            if probing:
                # Whatever the answer: a rejection has tripped the breaker (which blocks everything anyway);
                # an unreachable recorder is no lockout risk, so the loops may as well try on their own.
                self._probe_needed = False
                self._restart_subscriber()   # the old one still holds the previous connection's credentials
                self.wake()
                gen = self._gen
            if self._sleep(TZ_PERIOD_S, gen):
                return

    def _calibrate_all(self):
        while not self._stop.is_set():
            gen = self._gen
            reason = self._blocked()
            if reason:
                self.status["calibration_waiting"] = reason
            else:
                self.status.pop("calibration_waiting", None)
                self._calibrate_pass()
            if self._sleep(CALIBRATE_PERIOD_S, gen):
                return

    def _calibrate_pass(self):
        s = self.get_settings()
        api = isapi.Isapi(s.connection.host, s.connection.username, s.connection.password, s.connection.http_port)
        conn_relay = _relay_conn(s)
        for c in [c for c in s.channels if c.enabled]:
            ch = c.channel
            if self._stop.is_set() or recorder_guard.tripped(api.fp):   # tripped by another loop mid-pass
                break
            cached = db.get_calibration(ch)
            fresh = cached and _age_hours(cached["measured_utc"]) < 6
            if fresh:
                self.status["calibration"][ch] = {"a_const": cached["a_const"], "error_estimate": cached["error_estimate"],
                                                    "measured_utc": cached["measured_utc"], "discontinuity": bool(cached["discontinuity"])}
                continue
            try:
                # The live SD stream, honouring the channel's own path override (a non-Hikvision source).
                r = timebase.calibrate_channel(conn_relay, api, ch, hikrelay.stream_path(ch, "sub", c.sub_path))
            except Exception as e:
                r = {"error": str(e) if isinstance(e, (hikrelay.RelayError, recorder_guard.RecorderAuthBlocked))
                     else f"{type(e).__name__}: {e}"}
            if "a_const" in r:
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                disc = db.set_calibration(ch, r["a_const"], r["error_estimate"], r["method"], now)
                self.status["calibration"][ch] = {"a_const": r["a_const"], "error_estimate": r["error_estimate"],
                                                    "measured_utc": now, "discontinuity": bool(disc)}
            else:
                self.status["calibration"].setdefault(ch, {})["last_error"] = r.get("error")

    def _backfill_loop(self):
        while not self._stop.is_set():
            gen = self._gen
            reason = self._blocked()
            if reason:
                self.status["backfill"]["waiting"] = reason
            else:
                self.status["backfill"].pop("waiting", None)
                self._backfill_pass()
            if self._sleep(BACKFILL_PERIOD_S, gen):
                return

    def _backfill_pass(self):
        self.status["backfill"]["running"] = True
        try:
            api, tz = self._api(), self.tz
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
            # this, one bad call stops backfill forever until the process restarts, silently. The watermark
            # only ever advances past a fully-fetched day, so the next pass resumes exactly where this failed.
            self.status["backfill"]["last_error"] = f"{type(e).__name__}: {e}"
        self.status["backfill"]["running"] = False

    def _coverage_loop(self):
        while not self._stop.is_set():
            gen = self._gen
            reason = self._blocked()
            if reason:
                self.status["coverage"]["waiting"] = reason
            else:
                self.status["coverage"].pop("waiting", None)
                self._coverage_pass()
            if self._sleep(COVERAGE_PERIOD_S, gen):
                return

    def _coverage_pass(self):
        """Index every enabled channel from its first recorded day through today. Days before yesterday never
        change, so each is fetched once per process; yesterday and today are re-fetched every pass. A day the
        recorder refuses (non-200) is skipped and retried later with backoff, so one bad day neither aborts the
        whole index nor gets re-requested every pass; a connection failure or a credential rejection ends the
        pass (the next one resumes, skipping what's already indexed)."""
        st = self.status["coverage"]
        cov = self._cov
        st["running"] = True
        try:
            api, tz = self._api(), self.tz
            chans = self._channels()
            today = datetime.datetime.now(tz).date()
            recent = today - datetime.timedelta(days=1)
            for ch in chans:
                if ch not in cov["earliest"]:
                    cov["earliest"][ch] = coverage.earliest_recorded_day(api, ch, tz)
            now_m = time.monotonic()
            failures = []
            for ch in chans:
                day = min(cov["earliest"][ch] or recent, recent)
                while day <= today:
                    if self._stop.is_set():
                        return
                    key = (ch, day)
                    retry_at, attempts = cov["failed"].get(key, (0.0, 0))
                    if not ((day < recent and key in cov["indexed"]) or retry_at > now_m):
                        try:
                            coverage.refresh_day(api, ch, day, tz)
                            cov["indexed"].add(key)
                            cov["failed"].pop(key, None)
                        except isapi.DvrRequestError as e:
                            attempts += 1
                            cov["failed"][key] = (now_m + min(COVERAGE_PERIOD_S * 2 ** (attempts - 1), COVERAGE_RETRY_MAX_S), attempts)
                            failures.append(f"channel {ch} {day}: {e}")
                    day += datetime.timedelta(days=1)
            known = [d for c, d in cov["earliest"].items() if d and c in chans]
            st.update({"days_x_channels_indexed": len(cov["indexed"]),
                       "earliest": min(known).isoformat() if known else None,
                       "failed_days": len(cov["failed"])})
            if failures:
                st["last_error"] = f"{len(failures)} day(s) couldn't be indexed, will retry: {failures[0]}"
            else:
                st.pop("last_error", None)
        except Exception as e:
            # Same reasoning as _backfill_pass: a transient ISAPI failure here must not permanently kill the
            # periodic re-index — this exact call is what died on a real container's cold start, confirmed
            # directly, taking the whole thread down before it ever reached the retry loop.
            st["last_error"] = str(e) if isinstance(e, recorder_guard.RecorderAuthBlocked) else f"{type(e).__name__}: {e}"
        finally:
            st["running"] = False


def _relay_conn(settings):
    return hikrelay.conn_of({"connection": settings.connection.model_dump()})


def _age_hours(iso):
    t = datetime.datetime.fromisoformat(iso)
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 3600
