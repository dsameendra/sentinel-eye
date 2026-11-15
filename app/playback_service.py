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
rejection anywhere stops the rest.)

Once a day, _prune_loop drops what can no longer be played: recorder events (and their thumbnails) and cached
coverage from before the recorder's oldest recording (minus a margin) — only once a full coverage pass has
established that oldest day for certain. health() and retention() summarise all of this for the UI.)"""
import datetime
import threading
import time
import urllib.error
from pathlib import Path

import coverage
import db
import events
import hikrelay
import isapi
import recorder_guard
import thumbnails
import timebase

CALIBRATE_PERIOD_S = 60      # re-check the whole list once a minute; per-channel freshness skip keeps this cheap
BACKFILL_PERIOD_S = 3600     # new days (and today's re-check) once an hour; the watermark makes this cheap
COVERAGE_PERIOD_S = 1800
TZ_PERIOD_S = 3600           # the recorder's UTC offset changes with daylight saving; an hour late at worst
COVERAGE_RETRY_MAX_S = 86400
EARLIEST_REPROBE_S = 6 * 3600   # the recorder's oldest day moves forward daily as its disk loops
PRUNE_PERIOD_S = 86400
PRUNE_WAIT_S = 600           # until the first full coverage pass has established the oldest recorded day
PRUNE_MARGIN_DAYS = 2        # keep events this many days before the oldest recording, in case it's slightly off
ORPHAN_THUMB_AGE_S = 3600    # a thumbnail file is written before its row points at it: never touch a fresh one


class PlaybackService:
    def __init__(self, get_settings):
        self.get_settings = get_settings
        self._stop = threading.Event()
        self._cv = threading.Condition()
        self._gen = 0                 # bumped by wake(): every loop waiting in _sleep() starts its next pass now
        self._probe_needed = False    # after a reload: the clock read logs in first, alone (module docstring)
        self._sub_lock = threading.Lock()
        self.subscriber = None
        self.status = {"calibration": {}, "backfill": {"running": False}, "coverage": {"running": False}, "prune": {}}
        # Last time any loop got an answer from the recorder / failed to reach it at all (health()).
        self._contact = {"ok": None, "fail": None, "error": None}
        self._threads = []
        self.tz = None
        self._reset_coverage_cache()

    # ------------------------------------------------------------------ plumbing
    def _reset_coverage_cache(self):
        # indexed: (channel, day) refreshed by this process — days before yesterday never change, so they are
        # fetched once. failed: (channel, day) -> (retry_after_monotonic, attempts), so a day the recorder keeps
        # refusing is retried with backoff instead of stalling every pass. earliest: channel -> first recorded day.
        # certain: channel -> whether that day is known for sure (coverage.earliest_recorded_day_checked);
        # probed_at: channel -> monotonic time of the probe; oldest: channel -> first recorded instant (UTC ISO),
        # from the earliest day's own spans, re-read every pass; pass_ok: a whole pass completed since the reset.
        self._cov = {"indexed": set(), "failed": {}, "earliest": {}, "certain": {}, "probed_at": {}, "oldest": {},
                     "pass_ok": False}

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

    def _note_ok(self):
        self._contact["ok"] = time.time()

    def _note_fail(self, e):
        """Record a failure to reach the recorder at all (refused connection, timeout, no route) — not an HTTP
        error answer, which means it is there."""
        if unreachable_error(e):
            self._contact.update(fail=time.time(), error=f"{type(e).__name__}: {e}")

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
                    self._note_ok()
                    break
                except Exception as e:
                    self._note_fail(e)
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
        self._spawn(self._prune_loop)

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
                    self._note_ok()
                    if tz != self.tz:
                        self.tz = tz
                        if self.subscriber:
                            self.subscriber.tz = tz
                    self.status.pop("tz_error", None)
                except Exception as e:
                    self._note_fail(e)
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
            self._note_ok()
        except Exception as e:
            self._note_fail(e)
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
                if ch not in cov["earliest"] or time.monotonic() - cov["probed_at"].get(ch, 0) > EARLIEST_REPROBE_S:
                    self._probe_earliest(api, ch, tz)
            now_m = time.monotonic()
            failures = []
            for ch in chans:
                day = min(cov["earliest"][ch] or recent, recent)
                while day <= today:
                    if self._stop.is_set():
                        return
                    key = (ch, day)
                    retry_at, attempts = cov["failed"].get(key, (0.0, 0))
                    # The oldest day is re-read every pass too: the recorder overwrites it from the start.
                    oldest_day = day == cov["earliest"].get(ch)
                    if not ((day < recent and key in cov["indexed"] and not oldest_day) or retry_at > now_m):
                        try:
                            spans = coverage.refresh_day(api, ch, day, tz)
                            cov["indexed"].add(key)
                            cov["failed"].pop(key, None)
                            if oldest_day:
                                self._note_oldest(api, ch, tz, spans)
                        except isapi.DvrRequestError as e:
                            attempts += 1
                            cov["failed"][key] = (now_m + min(COVERAGE_PERIOD_S * 2 ** (attempts - 1), COVERAGE_RETRY_MAX_S), attempts)
                            failures.append(f"channel {ch} {day}: {e}")
                    day += datetime.timedelta(days=1)
            known = [d for c, d in cov["earliest"].items() if d and c in chans]
            st.update({"days_x_channels_indexed": len(cov["indexed"]),
                       "earliest": min(known).isoformat() if known else None,
                       "failed_days": len(cov["failed"]),
                       "last_pass_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            cov["pass_ok"] = True
            self._note_ok()
            if failures:
                st["last_error"] = f"{len(failures)} day(s) couldn't be indexed, will retry: {failures[0]}"
            else:
                st.pop("last_error", None)
        except Exception as e:
            # Same reasoning as _backfill_pass: a transient ISAPI failure here must not permanently kill the
            # periodic re-index — this exact call is what died on a real container's cold start, confirmed
            # directly, taking the whole thread down before it ever reached the retry loop.
            self._note_fail(e)
            st["last_error"] = str(e) if isinstance(e, recorder_guard.RecorderAuthBlocked) else f"{type(e).__name__}: {e}"
        finally:
            st["running"] = False

    def _probe_earliest(self, api, ch, tz):
        r = coverage.earliest_recorded_day_checked(api, ch, tz)
        cov = self._cov
        if r["day"] != cov["earliest"].get(ch):
            cov["oldest"].pop(ch, None)   # a different first day: its first instant is read again this pass
        cov["earliest"][ch] = r["day"]
        cov["certain"][ch] = r["certain"]
        cov["probed_at"][ch] = time.monotonic()

    def _note_oldest(self, api, ch, tz, spans):
        """The first recorded instant on the channel's oldest day. An empty oldest day means the recorder has
        just overwritten all of it: find the new first day now rather than claim footage that is gone."""
        cov = self._cov
        if spans:
            cov["oldest"][ch] = min(s for s, _ in spans)
            return
        cov["oldest"].pop(ch, None)
        self._probe_earliest(api, ch, tz)

    # ------------------------------------------------------------------ pruning
    def _prune_loop(self):
        while not self._stop.is_set():
            gen = self._gen
            done = False
            try:
                done = self.prune_pass()
            except Exception as e:
                self.status["prune"]["last_error"] = f"{type(e).__name__}: {e}"
            if self._sleep(PRUNE_PERIOD_S if done else PRUNE_WAIT_S, gen):
                return

    def prune_pass(self, now=None):
        """Drop what can no longer be played. For each enabled channel whose oldest recorded day is known for
        certain from a completed coverage pass: its recorder events (dvr-live / dvr-log — never bookmarks or
        anything else) that ended before that day minus PRUNE_MARGIN_DAYS, their thumbnail files, and its cached
        coverage for days before the same cut-off. Then thumbnail files no event refers to any more.
        calibration_history is never pruned: timebase.regimes() needs every measurement to tell the recorder's
        clock periods apart (a period's first and last measurements bracket the footage it labels), and it is
        tiny. Returns False (nothing done) while the oldest day isn't established yet."""
        st = self.status["prune"]
        cov = self._cov
        if not cov["pass_ok"] or self.tz is None:
            st["waiting"] = "Waiting for a full pass of the recording index"
            return False
        st.pop("waiting", None)
        removed_events = removed_cov = removed_thumbs = 0
        skipped = []
        for ch in self._channels():
            day = cov["earliest"].get(ch)
            if not day or not cov["certain"].get(ch):
                skipped.append(ch)
                continue
            cut_day = day - datetime.timedelta(days=PRUNE_MARGIN_DAYS)
            cutoff = datetime.datetime.combine(cut_day, datetime.time(0, 0), tzinfo=self.tz)
            n, thumbs = db.prune_dvr_events(ch, cutoff)
            removed_events += n
            removed_thumbs += sum(_remove_thumb(p) for p in thumbs)
            removed_cov += db.prune_coverage(ch, cut_day)
        removed_thumbs += _remove_orphan_thumbs(now)
        st.update({"last_run_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "events_removed": removed_events, "thumbnails_removed": removed_thumbs,
                   "coverage_days_removed": removed_cov,
                   "total_events_removed": st.get("total_events_removed", 0) + removed_events,
                   "skipped_channels": skipped})
        st.pop("last_error", None)
        return True

    # ------------------------------------------------------------------ summaries for the UI
    def retention(self, now=None):
        """{channel: {"oldest_utc", "oldest_day", "days"}} for every enabled channel: the first instant the
        recorder still has, and how many days back that is. Both None ("unknown") unless they come from this
        process's own coverage data with the oldest day known for certain — never estimated."""
        now = now or time.time()
        cov = self._cov
        out = {}
        for ch in self._channels():
            oldest = cov["oldest"].get(ch) if cov["certain"].get(ch) else None
            days = None
            if oldest:
                days = round(max(0.0, now - datetime.datetime.fromisoformat(oldest).timestamp()) / 86400, 1)
            day = cov["earliest"].get(ch) if oldest else None
            out[ch] = {"oldest_utc": oldest, "oldest_day": day.isoformat() if day else None, "days": days}
        return out

    def health(self):
        """The recorder's state in plain terms, for Settings → Status and the Live/Playback notice."""
        sub = self.subscriber
        c = self._contact
        # Reachable: the newest evidence wins — the live event stream being connected, any loop's last answer,
        # or the last time a loop (or the event stream) couldn't reach it at all.
        signals = []
        if c["ok"]:
            signals.append((c["ok"], True, None))
        if c["fail"]:
            signals.append((c["fail"], False, c["error"]))
        if sub is not None:
            if sub.connected:
                signals.append((time.time(), True, None))
            elif sub.last_error and sub.last_error_unreachable and sub.last_error_at:
                signals.append((sub.last_error_at, False, sub.last_error))
        if not self.get_settings().connection.host:
            reachable, error = None, None
        elif signals:
            _, reachable, error = max(signals, key=lambda x: x[0])
        else:
            reachable, error = None, self.status.get("dvr_error")
        bf = self.status["backfill"]
        marks = [db.get_watermark(m) for m in ("Alarm", "Exception")]
        through = min(marks) if all(marks) else None
        cal = {}
        for ch in self._channels():
            cal[ch] = calibration_state(self.status["calibration"].get(ch), db.get_calibration(ch))
        cv = self.status["coverage"]
        known = [r["oldest_utc"] for r in self.retention().values() if r["oldest_utc"]]
        return {
            "reachable": reachable, "error": error,
            "checked": self.tz is not None,
            "utc_offset_minutes": int(self.tz.utcoffset(None).total_seconds() // 60) if self.tz else None,
            "clock_error": self.status.get("tz_error"),
            "live_events": {"connected": bool(sub and sub.connected), "error": sub.last_error if sub else None,
                            "last_event_utc": sub.last_event_utc if sub else None},
            "history": {"running": bool(bf.get("running")), "waiting": bf.get("waiting"),
                        "last_error": bf.get("last_error"), "through_day": through},
            "coverage": {"running": bool(cv.get("running")), "waiting": cv.get("waiting"),
                         "last_error": cv.get("last_error"), "last_pass_utc": cv.get("last_pass_utc"),
                         "failed_days": cv.get("failed_days", 0)},
            "calibration": cal,
            "calibration_waiting": self.status.get("calibration_waiting"),
            "oldest_recording_utc": min(known) if known else None,
            "prune": dict(self.status["prune"]),
        }


def unreachable_error(e):
    """True for a failure to reach the recorder at all — not an HTTP answer (which means it is there) and not
    the lockout breaker."""
    if isinstance(e, (recorder_guard.RecorderAuthBlocked, urllib.error.HTTPError, isapi.DvrRequestError)):
        return False
    return isinstance(e, (urllib.error.URLError, OSError, TimeoutError))


def calibration_state(st, row):
    """One camera's clock calibration in plain terms: state ok | approximate | failed | pending, when it was
    measured, and why it failed. Approximate: measured, but only to within a few seconds (the on-screen clock
    couldn't be read, or the measurement's own error was large)."""
    st = st or {}
    out = {"state": "pending", "measured_utc": None, "error": st.get("last_error"), "clock_reset": False}
    if row:
        out["measured_utc"] = row["measured_utc"]
        out["clock_reset"] = bool(row.get("discontinuity"))
        rough = row.get("method") != "osd_tick" or (row.get("error_estimate") or 0) > 1.0
        out["state"] = "approximate" if rough else "ok"
        if st.get("last_error") and _age_hours(row["measured_utc"]) > 12:
            out["state"] = "failed"   # the last good one is getting old and re-measuring keeps failing
    elif st.get("last_error"):
        out["state"] = "failed"
    return out


def _remove_thumb(path):
    """Delete one of our own cached thumbnail files (never anything outside data/thumbnails). 1 if removed."""
    try:
        p = Path(path).resolve()
        if p.parent != thumbnails.THUMB_DIR.resolve() or not p.is_file():
            return 0
        p.unlink()
        return 1
    except OSError:
        return 0


def _remove_orphan_thumbs(now=None):
    """Thumbnail files whose event no longer exists (pruned, merged, deleted), older than ORPHAN_THUMB_AGE_S."""
    d = thumbnails.THUMB_DIR
    if not d.is_dir():
        return 0
    now = now or time.time()
    ids = db.event_ids()
    n = 0
    for p in d.glob("*.jpg"):
        try:
            if p.stem.isdigit() and int(p.stem) in ids:
                continue
            if now - p.stat().st_mtime < ORPHAN_THUMB_AGE_S:
                continue
            n += _remove_thumb(p)
        except OSError:
            pass
    return n


def _relay_conn(settings):
    return hikrelay.conn_of({"connection": settings.connection.model_dump()})


def _age_hours(iso):
    t = datetime.datetime.fromisoformat(iso)
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 3600
