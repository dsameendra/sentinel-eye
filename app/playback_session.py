"""DVR playback sessions for the browser player: one background reader per open pane, all sharing a
4-slot pool (the DVR's hard session cap — docs/SPEC.md section 2.2/7.3).

Each reader opens an RTSP playback session (`Range: clock=...`), decrypts, depacketizes to access units,
labels each frame with its recorded time (timebase.choose_label: the calibration that was in force when the
footage was recorded when one can be trusted, otherwise anchored to the request and flagged approximate), and
pushes Frame tuples into a thread-safe queue that the WebSocket handler, exports and thumbnails drain. A
session starts at the keyframe before the requested instant (up to a keyframe interval — measured up to ~50 s
— early); those frames are kept, truthfully labelled and flagged `pre`, because decoding needs them.
Seeking reissues PLAY with a new `clock=` range on the same RTSP session (cheap: ~70-100ms, no reconnect).
A speed change, and resuming a held feed, reissue PLAY with `Range: npt=now-` instead: measured on the recorder,
that carries on from the very next frame (no repeat, no gap, accepted at every speed), where `clock=<now>`
restarted from the previous keyframe — the picture jumped back up to a keyframe interval. The browser holds
(RTSP PAUSE, kept alive) and resumes the feed as its buffer fills and drains: real back-pressure, nothing is
dropped (docs/SPEC.md 7.2, tools/NOTES.md).
"""
import collections
import datetime
import queue
import statistics
import threading
import time

import db
import hikrelay as h
import recorder_guard
import timebase

MAX_SESSIONS = 4
# The recorder's playback bandwidth budget, in "real-time streams": measured directly against it, the sum of
# every open session's speed may not exceed 16 — 4 cameras at 4x, 2 at 8x or 1 at 16x are all served, while
# 3 at 8x or 2 at 16x get "453 Not Enough Bandwidth" for the ones past the line. A session below 1x still
# costs a whole stream.
SPEED_BUDGET = 16
NICE_SPEEDS = ("0.125", "0.25", "0.5", "1", "2", "4", "8", "16")
BANDWIDTH_MSG = "The recorder can't play this many cameras this fast — lower the speed, or show fewer cameras."
KEEPALIVE_S = 10         # a held (RTSP-paused) session sends OPTIONS this often: nothing else shows it's in use
AUTO_HOLD_S = 5          # a consumer that stops reading for this long gets the feed paused for it (see _put)

# One picture from a reader: t = its recorded time (epoch s), key = keyframe, data = Annex-B access unit,
# seg = the segment's shared metadata dict (see PlaybackReader._new_segment), pre = recorded before the requested
# instant (only there because the session starts at the previous keyframe: decode it, don't show it as "the
# requested moment"). Error items stay ("error", message) tuples — every consumer checks item[0] == "error".
Frame = collections.namedtuple("Frame", "t key data seg pre")


class AccessUnits:
    """Groups NAL units into access units (one picture each) for WebCodecs and the MP4 muxer. WebCodecs decodes
    one access unit per chunk, not one raw NAL per chunk: a leading VPS/SPS/PPS sent as its own "delta" chunk
    breaks it ("a key frame is required after configure()") because that first chunk isn't type 'key'. So
    non-picture NALs are buffered and emitted together with the slice NAL that follows — this DVR sends one
    slice NAL per picture (verified on its captures — no multi-slice pictures seen)."""

    def __init__(self, codec):
        self.codec = codec
        self.buf = bytearray()

    def feed(self, nal):
        """None while buffering, else (is_key, access_unit_bytes) once a picture NAL completes one."""
        hevc = self.codec == "hevc"
        t = (nal[0] >> 1 & 0x3F) if hevc else (nal[0] & 0x1F)
        self.buf += h.START + nal
        if not (t <= 31 if hevc else 1 <= t <= 5):
            return None
        out = (16 <= t <= 23) if hevc else t == 5, bytes(self.buf)
        self.buf = bytearray()
        return out


def valid_speed(v):
    """`v` as one of NICE_SPEEDS ("2", "0.5", …), or None. Speeds go into the recorder's RTSP `Scale:` header,
    so only these exact strings are ever passed on; a JSON number (2, 0.5) is accepted in its canonical form."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        v = f"{v:g}"
    return v if isinstance(v, str) and v in NICE_SPEEDS else None


def parse_utc(v):
    """An ISO 8601 instant as an aware UTC datetime, or None if it isn't one. A naive time is taken as UTC (the
    API's times are all UTC): formatting a naive one for the recorder would otherwise silently use the host's
    own zone (hik_time's astimezone)."""
    if not isinstance(v, str) or not v or len(v) > 64:
        return None
    try:
        dt = datetime.datetime.fromisoformat(v.replace("Z", "+00:00") if v.endswith("Z") else v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def units(speed) -> float:
    try:
        return max(1.0, float(speed))
    except (TypeError, ValueError):
        return 1.0


class SessionPool:
    """Gate on the recorder's two playback limits, shared by every playback pane, thumbnail and export:
    at most 4 sessions, and at most SPEED_BUDGET real-time streams' worth of speed across them."""

    def __init__(self, limit=MAX_SESSIONS, budget=SPEED_BUDGET):
        self._cv = threading.Condition()
        self._in_use = 0
        self._units = 0.0
        self.limit = limit
        self.budget = budget

    def _fits(self, u):
        return self._in_use < self.limit and self._units + u <= self.budget + 1e-9

    def acquire(self, timeout=20, speed="1"):
        """Wait for a session with room for `speed`. True when granted."""
        u = units(speed)
        with self._cv:
            if not self._cv.wait_for(lambda: self._fits(u), timeout=timeout):
                return False
            self._in_use += 1
            self._units += u
            return True

    def acquire_fastest(self, speeds, timeout=20):
        """Wait for a session, taking the fastest of `speeds` that fits right now (exports: 16x when the
        recorder is otherwise idle, slower rather than refused while someone is reviewing). Returns the
        granted speed, or None on timeout."""
        with self._cv:
            if not self._cv.wait_for(lambda: self._fits(1.0), timeout=timeout):
                return None
            for sp in sorted(speeds, key=units, reverse=True):
                if self._fits(units(sp)):
                    self._in_use += 1
                    self._units += units(sp)
                    return sp
            return None

    def change(self, old_speed, new_speed):
        """Move an open session to a new speed if the budget allows. True when applied."""
        delta = units(new_speed) - units(old_speed)
        with self._cv:
            if self._units + delta > self.budget + 1e-9:
                return False
            self._units += delta
            self._cv.notify_all()
            return True

    def release(self, speed="1"):
        with self._cv:
            self._in_use = max(0, self._in_use - 1)
            self._units = max(0.0, self._units - units(speed))
            self._cv.notify_all()

    @property
    def busy(self):
        with self._cv:
            return self._in_use

    @property
    def used_units(self):
        with self._cv:
            return self._units


pool = SessionPool()


def hik_time(dt: datetime.datetime, tz) -> str:
    """Format an absolute instant as the DVR wants for `Range: clock=...`: like its logs, the trailing 'Z'
    here does not mean UTC — the DVR expects its own LOCAL wall-clock digits (verified: requesting UTC time
    directly, unconverted, played back footage ~5.5h off — exactly the DVR's UTC+5:30 offset)."""
    return dt.astimezone(tz).strftime("%Y%m%dT%H%M%SZ")


class PlaybackReader:
    """One DVR playback session + decrypt/depacketize pipeline, feeding a bounded queue."""

    def __init__(self, conn, channel, main_path, a_const, start_utc, tz, speed="1", adaptive_speeds=None):
        """adaptive_speeds: take the fastest of these the budget allows at start (exports), instead of a
        fixed `speed` that may not fit."""
        self.adaptive_speeds = adaptive_speeds
        self.conn, self.channel, self.path = conn, channel, main_path
        self.a_const = a_const
        self.tz = tz
        self.speed = speed
        self.start_utc = start_utc
        self.q = queue.Queue(maxsize=200)
        self._stop = threading.Event()
        self._seek_to = None
        self._new_speed = None
        self.client = None
        self.error = None
        self.segment = None        # the current segment's metadata (see _new_segment), for callers that poll
        self._last_label = None    # recorded time of the newest frame handed out: where a speed change resumes
        self.waiting_for_slot = False
        self._want_hold = False    # the consumer asked for the feed to be paused (hold()/resume())
        self._auto_hold = False    # ...or it stopped reading for AUTO_HOLD_S (_put)
        self._paused = False       # the RTSP session is PAUSEd right now
        self._wake = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    @property
    def codec(self):
        """"hevc" or "h264" once the session is open (from the recorder's SDP), else None."""
        c = self.client
        return c.codec if c is not None else None

    def seek(self, start_utc, speed=None):
        """Play from `start_utc` (resuming a held feed). Ignored when it isn't an ISO 8601 instant; an invalid `speed` keeps the current one (the
        server validates both first; this is the second layer before they reach the RTSP request)."""
        dt = parse_utc(start_utc)
        if dt is None:
            return
        self._seek_to = dt.isoformat()
        if valid_speed(speed) is not None:
            self._new_speed = valid_speed(speed)
        self._want_hold = False   # a seek empties the consumer's buffer: it wants the new position's frames
        self._wake.set()

    def set_speed(self, speed):
        """Change speed in place: the stream carries on from the next frame (PLAY `npt=now-`)."""
        if valid_speed(speed) is not None:
            self._new_speed = valid_speed(speed)
            self._wake.set()

    def hold(self):
        """Pause the recorder's feed (RTSP PAUSE, kept alive) — the consumer has enough buffered."""
        self._want_hold = True

    def resume(self):
        """Resume a held feed where it stopped (PLAY `npt=now-`)."""
        self._want_hold = False
        self._wake.set()

    def stop(self):
        self._stop.set()
        self._wake.set()
        # A flowing session notices the flag on its next packet and tears down cleanly (waiting for the
        # recorder's reply, so its budget is really free before the pool hands it on). A quiet one — no
        # packets coming — gets its socket cut after a short grace, so its share isn't held for the 15s
        # idle timeout.
        def cut():
            c = self.client   # read once: a reopen can swap it out meanwhile
            if self.thread.is_alive() and c is not None and c.sock is not None:
                try:
                    import socket
                    c.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        threading.Timer(2.0, cut).start()
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass

    def _run(self):
        c = self.conn
        if recorder_guard.tripped(recorder_guard.fingerprint(c["host"], c["user"], c["pw"])):
            # Fail before queueing for a session slot: nothing will log in until the password is fixed.
            self.error = recorder_guard.MESSAGE
            self.q.put(("error", self.error))
            return
        self.waiting_for_slot = True
        if self.adaptive_speeds:
            got = pool.acquire_fastest(self.adaptive_speeds, timeout=25)
            if got:
                self.speed = got
        else:
            got = pool.acquire(timeout=25, speed=self.speed)
        if not got:
            self.error = ("The recorder's playback sessions are all in use — try again shortly."
                          if pool.busy >= pool.limit else BANDWIDTH_MSG)
            self.q.put(("error", self.error))
            return
        self.waiting_for_slot = False
        self._held = self.speed
        if self._stop.is_set():
            # Stopped while queued for a slot (a pane closed, an export cancelled): don't log in at all.
            pool.release(self._held)
            return
        try:
            # A seek the recorder refuses leaves its session unusable, so the loop hands back "reopen" and
            # starts a fresh session at that time (see the seek branch in _play_loop).
            while self._play_loop() == "reopen" and not self._stop.is_set():
                pass
        except h.RelayError as e:
            self.error = str(e)
            try:
                self.q.put(("error", self.error))
            except queue.Full:
                pass
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            try:
                self.q.put(("error", self.error))
            except queue.Full:
                pass
        finally:
            if self.client:
                self.client.teardown()
                self.client.close()
            pool.release(self._held)

    def _a_const_for(self, dt):
        """A calibration near this moment, only for the anchored fallback's frame-to-frame spacing (any a_const
        gives the same spacing within a segment) — which calibration really applies is _new_segment's job."""
        r = db.get_calibration_near(self.channel, dt)
        return r["a_const"] if r else self.a_const

    def _new_segment(self, target_utc, rtp_first):
        """Metadata shared by every frame of one PLAY segment, decided from its first frame (timebase.choose_label).
        `display_from` is the requested instant: frames before it are the keyframe pre-roll."""
        try:
            history = pooled_history()
        except Exception:
            history = []
        lab = timebase.choose_label(rtp_first, target_utc, history, self.a_const)
        if lab.get("a_const") is None:   # no calibration at all: the anchor needs only relative spacing
            lab["a_const"] = target_utc - rtp_first / timebase.RTP_HZ
            lab["offset"] = target_utc - timebase.abs_time(lab["a_const"], rtp_first, target_utc)
        first = timebase.abs_time(lab["a_const"], rtp_first, target_utc) + lab.get("offset", 0.0)
        seg = {"codec": self.codec or "hevc", "time_source": lab["time_source"], "approx": lab["time_source"] != "calibration",
               "target": target_utc, "display_from": target_utc, "first_utc": first, "bound_s": lab["bound_s"],
               "_a": lab["a_const"], "_offset": lab.get("offset", 0.0),
               "_cal": {k: lab.get(k) for k in ("a_const", "measured_utc", "method", "error_estimate")}
               if lab["time_source"] == "calibration" else {}}
        self.segment = seg
        return seg

    def _play_loop(self):
        start_dt = parse_utc(self._seek_to or self.start_utc)
        if start_dt is None:
            raise h.RelayError("Invalid playback time")
        self._seek_to = None
        self.a_const = self._a_const_for(start_dt)
        # The DVR refuses PLAY for a time too close to "now" (still-open recording segment) — with 400 Bad
        # Request and no other signal. How close moves as it writes: measured from under a minute to about
        # two (anything past ~2 min opened every time). So back off in growing steps — up to ~7 min — rather
        # than guess a margin: the session starts at the newest footage the recorder will serve. Only for
        # recent footage; a 400 further back means something else, and is raised.
        backoff = (20, 20, 30, 30, 45, 60, 90, 120)
        recent = lambda dt: (datetime.datetime.now(datetime.timezone.utc)
                             - (dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc))).total_seconds() < 600
        tries = len(backoff) + 1
        for attempt in range(tries):
            end_dt = start_dt + datetime.timedelta(hours=24)
            rng = f"clock={hik_time(start_dt, self.tz)}-{hik_time(end_dt, self.tz)}"
            self.client = h.RtspClient(self.conn["host"], self.conn["port"], self.conn["user"], self.conn["pw"], self.path)
            try:
                self.client.open(play_range=rng, scale=self.speed, idle_timeout=15)
                break
            except h.RelayError as e:
                self.client.close()
                if "fast" in str(e) and attempt < tries - 1:
                    # 453: the recorder's budget is (still) spoken for — a session that just ended can take a moment
                    # to be released on its side, and its budget is shared with whatever else plays from it (another
                    # app; heavy live viewing — measured: 16x refused with 17 live streams open, served with 9).
                    # A fast catch-up feed steps down a speed at once; otherwise wait briefly rather than fail.
                    lower = [sp for sp in NICE_SPEEDS if 1 <= float(sp) < float(self.speed)]
                    if lower and self.adaptive_speeds:
                        pool.change(self._held, lower[-1])
                        self._held = self.speed = lower[-1]
                        continue
                    if self._stop.wait(0.8):
                        return
                    continue
                too_close = "400" in str(e) and recent(start_dt)   # 453 is the bandwidth refusal, not "too near now"
                if not too_close or attempt == tries - 1:
                    raise
                start_dt -= datetime.timedelta(seconds=backoff[attempt])
        self._paused = False
        aes = h.make_aes(self.conn["key"]) if self.conn["encrypted"] else None
        dp = h.Depacketizer(self.client.codec, aes)
        gate = h.StartGate(self.client.codec, self.client.sdp)
        target_utc = start_dt.timestamp()
        seg = None        # decided from this segment's first frame — see _new_segment
        near_raw = target_utc
        aus = AccessUnits(self.client.codec)
        pk = self.client.packets()
        while True:
            if self._stop.is_set():
                return
            if self._seek_to is not None:
                seek_dt = parse_utc(self._seek_to)
                speed = self._new_speed or self.speed
                self._seek_to, self._new_speed = None, None
                if seek_dt is None:
                    continue
                if speed != self._held:
                    if not pool.change(self._held, speed):
                        self._put(("error", BANDWIDTH_MSG))
                        return
                    self._held = speed
                self.speed = speed
                self.a_const = self._a_const_for(seek_dt)
                seek_end = seek_dt + datetime.timedelta(hours=24)
                # From a held (PAUSEd) session too: measured, a clock= PLAY seeks and plays from there.
                status = self.client.play(f"clock={hik_time(seek_dt, self.tz)}-{hik_time(seek_end, self.tz)}", speed)
                self._paused = False
                if "453" in status:
                    self._put(("error", BANDWIDTH_MSG))
                    return
                if not status.startswith("RTSP/1.0 200"):
                    # Measured on the recorder: an in-session seek closer than ~30 s to now is refused (400),
                    # and after any refusal the session answers every request — PLAY anywhere, even PAUSE —
                    # with 455 Method Not Valid In This State. It can't be revived, so close it (TEARDOWN,
                    # awaited, so its budget is free) and open a new one at that time; opening backs off
                    # from "too close to now" on its own, and gets nearer to now than a seek may.
                    self._flush_queue()
                    self._last_label = None
                    return self._reopen_at(seek_dt)
                target_utc = seek_dt.timestamp()
                near_raw = target_utc
                seg = None   # re-decided for the new segment
                self._last_label = None
                dp = h.Depacketizer(self.client.codec, aes)
                gate = h.StartGate(self.client.codec, self.client.sdp)
                aus = AccessUnits(self.client.codec)
                self._flush_queue()
                continue
            if self._want_hold or (self._auto_hold and self.q.qsize() > self.q.maxsize // 2):
                r = self._hold_feed()
                if r is not None:
                    return r
                continue
            self._auto_hold = False
            if self._paused or self._new_speed is not None:
                # Resume a held feed and/or change speed, in place: the same segment carries on.
                r = self._play_in_place()
                if r is not None:
                    return r
                continue
            p = next(pk)
            for ts, nal in dp.feed(p):
                for n in gate.feed(nal):
                    au = aus.feed(n)
                    if au is None:
                        continue
                    if seg is None:
                        seg = self._new_segment(target_utc, ts)
                    t, near_raw = _label(seg, ts, near_raw)
                    # A frame older than one already handed out (a recorder that restarted from the keyframe
                    # after all): needed for decoding, never to be shown as new — flagged like pre-roll.
                    pre = t < seg["display_from"] - 0.02 or (self._last_label is not None and t <= self._last_label - 0.02)
                    if not pre or self._last_label is None:
                        self._last_label = t
                    self._put(Frame(t, au[0], au[1], seg, pre))

    def _put(self, item):
        """Hand an item to the consumer without ever dropping it: a dropped frame breaks decoding up to the next
        keyframe (up to ~50 s here). A consumer that stops reading for AUTO_HOLD_S gets the recorder's feed
        PAUSEd for it (measured: a session simply left unread for 60 s lost a frame or two; a PAUSEd one kept
        alive resumed exactly after 90 s), and resumed once it has drained half the queue."""
        waited = 0.0
        while not self._stop.is_set():
            try:
                self.q.put(item, timeout=0.25)
                return
            except queue.Full:
                waited += 0.25
                if self._seek_to is not None and item is not None and item[0] != "error":
                    return   # a seek is waiting: this frame belongs to the old position anyway
                if waited >= AUTO_HOLD_S and not self._paused and self.client is not None:
                    try:
                        if self.client.pause().startswith("RTSP/1.0 200"):
                            self._paused = True
                            self._auto_hold = True
                    except (OSError, ConnectionError):
                        pass

    def _hold_feed(self):
        """Pause the recorder's feed (if it isn't already) and keep the session alive until resumed, a seek or
        a stop. Returns None to carry on, or what _play_loop should return."""
        if not self._paused:
            status = self.client.pause()
            if not status.startswith("RTSP/1.0 200"):
                # Can't pause here: carry on feeding (the consumer's own buffer cap and the blocking queue
                # still bound it).
                self._want_hold = self._auto_hold = False
                self._put(("feed", {"scale": self.speed, "hold": False, "refused": "hold"}))
                return None
            self._paused = True
        if self._want_hold:
            self._put(("feed", {"scale": self.speed, "hold": True}))
        last = time.monotonic()
        while not self._stop.is_set() and self._seek_to is None:
            if not (self._want_hold or (self._auto_hold and self.q.qsize() > self.q.maxsize // 2)):
                break
            self._wake.wait(0.25)
            self._wake.clear()
            if time.monotonic() - last >= KEEPALIVE_S:
                self.client.keepalive()
                last = time.monotonic()
        return None

    def _play_in_place(self):
        """PLAY `npt=now-` (resume after a hold, and/or a new speed): measured on the recorder, the stream then
        carries on from the next frame. Returns None to carry on, or what _play_loop should return."""
        want = self._new_speed or self.speed
        self._new_speed = None
        old = self.speed
        refused = None
        if want != self._held:
            if pool.change(self._held, want):
                self._held = want
            else:
                refused, want = want, self._held   # the budget is spoken for (an export, a thumbnail): keep the old speed
        status = self.client.play("npt=now-", want, keep=True)
        if "453" in status and want != old:
            pool.change(want, old)
            self._held = old
            refused, want = want, old
            status = self.client.play("npt=now-", want, keep=True)
        self.speed = want
        if not status.startswith("RTSP/1.0 200"):
            # Not accepted (never seen on this recorder): fall back to reopening at the newest frame handed out.
            # It restarts at the keyframe before that, so those frames come flagged `pre` and the player decodes
            # them without showing them — the picture holds, it never jumps back.
            resume = self._last_label
            return self._reopen_at(datetime.datetime.fromtimestamp(resume, datetime.timezone.utc) if resume is not None
                                   else parse_utc(self.start_utc))
        was_paused, self._paused = self._paused, False
        if refused or want != old or (was_paused and not self._auto_hold):
            msg = {"scale": want, "hold": False}
            if refused:
                msg["refused"] = refused
            self._put(("feed", msg))
        self._auto_hold = False
        return None

    def _reopen_at(self, dt):
        """Close this (unusable) session and have _run open a fresh one at `dt`."""
        self.client.teardown()
        self.client.close()
        self.client = None
        self._paused = False
        if self._seek_to is None:   # a newer seek that arrived meanwhile wins
            self._seek_to = dt.isoformat()
        return "reopen"

    def _flush_queue(self):
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass


BATCH_S = 600   # calibration rows measured this close together are one round (the service calibrates every camera in turn)


def pooled_history():
    """Every channel's calibration history as one, each calibration round reduced to its median. The recorder's
    RTP timestamps are one clock shared by every channel (docs/SPEC.md 2.4), so a measurement on any channel
    calibrates them all — and each single measurement scatters about ±0.5 s (measured over 2026-09/11: per channel
    standard deviation 0.35-0.98 s around its round's median, no channel offset by more than 0.3 s on average).
    Labelling each channel from its own rows let two cameras' labels for the same instant disagree by up to
    ~1.6 s; one pooled history gives every pane the same answer, so frame-locked panes agree on their burned-in
    clocks, and the median of a round is steadier than any one row."""
    rows = [dict(r) for r in db.query(
        "SELECT a_const, measured_utc, error_estimate, method FROM calibration_history ORDER BY measured_utc")]
    out, cur = [], []

    def flush():
        if not cur:
            return
        # The rows of a round that agree with most of the others (a single bad measurement — one 285 s off was
        # seen — is left out), aligned across 32-bit wraps, then their median.
        agree = lambda x, y: timebase._circ(x["a_const"], y["a_const"]) <= timebase.REGIME_TOL_S
        anchor = max(cur, key=lambda r: sum(agree(r, o) for o in cur))
        ok = [r for r in cur if agree(r, anchor)]
        ref = anchor["a_const"]
        aligned = sorted(r["a_const"] + round((ref - r["a_const"]) / timebase.PERIOD) * timebase.PERIOD for r in ok)
        mid = ok[len(ok) // 2]
        out.append({"a_const": statistics.median(aligned), "measured_utc": mid["measured_utc"],
                    "error_estimate": statistics.median(float(r["error_estimate"] or 0) for r in ok),
                    "method": mid["method"], "n": len(ok)})

    for r in rows:
        if cur and timebase._epoch(r["measured_utc"]) - timebase._epoch(cur[0]["measured_utc"]) > BATCH_S:
            flush()
            cur = []
        cur.append(r)
    flush()
    return out


def _abs_time(a_const, rtp_ts, near_utc):
    return timebase.abs_time(a_const, rtp_ts, near_utc)


def _label(seg, rtp_ts, near_raw):
    """(recorded time, new near_raw) for one frame of a segment. near_raw tracks the un-offset answer so the
    32-bit RTP wrap (every ~13.25 h) unwraps against the previous frame, not against the label."""
    raw = timebase.abs_time(seg["_a"], rtp_ts, near_raw)
    return raw + seg["_offset"], raw


def public_segment(seg):
    """The part of a segment's metadata the browser gets (the "playing"/"segment" WebSocket messages)."""
    return {"codec": seg["codec"], "time_source": seg["time_source"], "approx": seg["approx"],
            "display_from": seg["display_from"], "first_utc": seg["first_utc"], "bound_s": seg["bound_s"]}


def calibration_for(channel):
    r = db.get_calibration(channel)
    return r["a_const"] if r else None


def calibration_for_time(channel, target_utc):
    """A calibration value for a reader's frame spacing (the one measured closest to target_utc), or None while
    the channel has never been calibrated — callers treat None as "not ready yet". Which calibration (if any)
    truly applies to the footage is decided per segment from the whole history (timebase.choose_label)."""
    r = db.get_calibration_near(channel, target_utc)
    if r:
        return r["a_const"]
    return calibration_for(channel)
