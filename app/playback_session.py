"""DVR playback sessions for the browser player: one background reader per open pane, all sharing a
4-slot pool (the DVR's hard session cap — docs/SPEC.md section 2.2/7.3).

Each reader opens an RTSP playback session (`Range: clock=...`), decrypts, depacketizes to NAL units,
converts each frame's RTP timestamp to an absolute UTC time via the channel's stored calibration, and
pushes (abs_time, is_keyframe, annexb_bytes) tuples into a thread-safe queue that the WebSocket handler
drains. Seeking and speed changes reissue PLAY on the same RTSP session (cheap: ~70-100ms, no reconnect).
"""
import datetime
import queue
import re
import threading
import time

import db
import hikrelay as h

MAX_SESSIONS = 4
# The recorder's playback bandwidth budget, in "real-time streams": measured directly against it, the sum of
# every open session's speed may not exceed 16 — 4 cameras at 4x, 2 at 8x or 1 at 16x are all served, while
# 3 at 8x or 2 at 16x get "453 Not Enough Bandwidth" for the ones past the line. A session below 1x still
# costs a whole stream.
SPEED_BUDGET = 16
NICE_SPEEDS = ("0.125", "0.25", "0.5", "1", "2", "4", "8", "16")
BANDWIDTH_MSG = "The recorder can't play this many cameras this fast — lower the speed, or show fewer cameras."


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
        self.waiting_for_slot = False
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def seek(self, start_utc, speed=None):
        self._seek_to = start_utc
        if speed is not None:
            self._new_speed = speed

    def set_speed(self, speed):
        self._new_speed = speed

    def stop(self):
        self._stop.set()
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
        """The calibration valid when this moment was recorded, not necessarily the one this reader was
        constructed with (which is only right for start_utc) — a channel's RTP clock drifts across
        calibration cycles, so re-deriving on every seek is what keeps old-footage playback (and multi-pane
        sync against other channels doing the same) accurate across the whole timeline, not just near
        wherever playback happened to begin (docs/SPEC.md section 2.4)."""
        r = db.get_calibration_near(self.channel, dt)
        return r["a_const"] if r else self.a_const

    def _play_loop(self):
        start_dt = datetime.datetime.fromisoformat(self._seek_to or self.start_utc)
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
                    # 453: the recorder's budget is (still) spoken for — a session that just ended can
                    # take a moment to be released on its side. Wait briefly rather than fail.
                    if self._stop.wait(0.8):
                        return
                    continue
                too_close = "400" in str(e) and recent(start_dt)   # 453 is the bandwidth refusal, not "too near now"
                if not too_close or attempt == tries - 1:
                    raise
                start_dt -= datetime.timedelta(seconds=backoff[attempt])
        aes = h.make_aes(self.conn["key"]) if self.conn["encrypted"] else None
        dp = h.Depacketizer(self.client.codec, aes)
        gate = h.StartGate(self.client.codec, self.client.sdp)
        near_utc = start_dt.timestamp()
        target_utc = start_dt.timestamp()
        anchor = None  # learned from this segment's first frame — see _anchor_correction's docstring
        au_buf = bytearray()
        for p in self.client.packets():
            if self._stop.is_set():
                return
            if self._seek_to is not None or self._new_speed is not None:
                seek_dt = datetime.datetime.fromisoformat(self._seek_to) if self._seek_to else \
                    datetime.datetime.fromtimestamp(near_utc, datetime.timezone.utc)
                speed = self._new_speed or self.speed
                self._seek_to, self._new_speed = None, None
                if speed != self._held:
                    if not pool.change(self._held, speed):
                        self.q.put(("error", BANDWIDTH_MSG))
                        return
                    self._held = speed
                self.speed = speed
                self.a_const = self._a_const_for(seek_dt)
                seek_end = seek_dt + datetime.timedelta(hours=24)
                status = self.client.play(f"clock={hik_time(seek_dt, self.tz)}-{hik_time(seek_end, self.tz)}", speed)
                if "453" in status:
                    self.q.put(("error", BANDWIDTH_MSG))
                    return
                if not status.startswith("RTSP/1.0 200"):
                    # Measured on the recorder: an in-session seek closer than ~30 s to now is refused (400),
                    # and after any refusal the session answers every request — PLAY anywhere, even PAUSE —
                    # with 455 Method Not Valid In This State. It can't be revived, so close it (TEARDOWN,
                    # awaited, so its budget is free) and open a new one at that time; opening backs off
                    # from "too close to now" on its own, and gets nearer to now than a seek may.
                    self.client.teardown()
                    self.client.close()
                    self.client = None
                    if self._seek_to is None:   # a newer seek that arrived meanwhile wins
                        self._seek_to = seek_dt.isoformat()
                    self._flush_queue()
                    return "reopen"
                near_utc = seek_dt.timestamp()
                target_utc = seek_dt.timestamp()
                anchor = None  # re-learn for the new segment — see _anchor_correction's docstring
                dp = h.Depacketizer(self.client.codec, aes)
                gate = h.StartGate(self.client.codec, self.client.sdp)
                au_buf = bytearray()
                self._flush_queue()
                continue
            for ts, nal in dp.feed(p):
                for n in gate.feed(nal):
                    # WebCodecs decodes one access unit (picture) per chunk, not one raw NAL per chunk: a
                    # leading VPS/SPS/PPS sent as its own "delta" chunk breaks it ("a key frame is required
                    # after configure()") because that first chunk isn't type 'key'. Buffer non-picture NALs
                    # and emit them together with the slice NAL that follows, as this DVR sends one slice
                    # NAL per picture (verified on its captures — no multi-slice pictures seen).
                    t = (n[0] >> 1 & 0x3F) if self.client.codec == "hevc" else (n[0] & 0x1F)
                    is_vcl = t <= 31 if self.client.codec == "hevc" else 1 <= t <= 5
                    au_buf += h.START + n
                    if not is_vcl:
                        continue
                    is_key = (16 <= t <= 23) if self.client.codec == "hevc" else t == 5
                    abs_t = _abs_time(self.a_const, ts, near_utc)
                    near_utc = abs_t
                    if anchor is None:
                        anchor = _anchor_correction(target_utc, abs_t)
                    try:
                        self.q.put((abs_t + anchor, is_key, bytes(au_buf)), timeout=2)
                    except queue.Full:
                        pass  # slow consumer: drop rather than stall the DVR session
                    au_buf = bytearray()

    def _flush_queue(self):
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass


def _abs_time(a_const, rtp_ts, near_utc):
    WRAP, RTP_HZ = 2 ** 32, 90000
    t = a_const + rtp_ts / RTP_HZ
    period = WRAP / RTP_HZ
    n = round((near_utc - t) / period)
    return t + n * period


def _anchor_correction(target_utc, first_abs_t):
    """How far a_const's own answer for this segment's first frame was from what was actually requested.
    Even the closest available historical calibration (_a_const_for) is only ever a *measurement*, proven
    accurate near when it was taken and not guaranteed beyond that (docs/SPEC.md section 2.4) — for a
    channel with no calibration history predating this session's footage (any channel, until several days
    of history have accumulated after this fix), or one whose clock drifted unusually between measurements,
    a_const's own answer can still be off by anywhere from seconds to hours.

    The DVR's own answer to "give me content at this clock= time" is far more trustworthy: an RTSP `clock=`
    playback request is served starting at (or within one keyframe interval of — commonly a few seconds)
    the exact requested instant, independent of anything this app computes. So this segment's every frame
    is re-anchored to target_utc using this one correction learned from its first frame, rather than trusting
    a_const's absolute answer for the rest of the session. RTP timestamps remain a reliable *relative* clock
    within the segment (docs/SPEC.md's "shared 90kHz clock" finding) — this only replaces the absolute
    anchor, not the relative spacing between frames. Bounds the remaining error, for every consumer of
    PlaybackReader (live playback, thumbnails, export), to roughly one keyframe interval instead of
    a_const's potentially much larger and less predictable drift — and, with multiple panes each anchored
    to their own request this way, is what actually makes "seek every camera to the same instant" mean the
    same recorded moment across all of them, which a_const's absolute accuracy alone can't guarantee."""
    return target_utc - first_abs_t


def calibration_for(channel):
    r = db.get_calibration(channel)
    return r["a_const"] if r else None


def calibration_for_time(channel, target_utc):
    """Like calibration_for, but picks the calibration measurement closest to target_utc rather than always
    the latest — see PlaybackReader._a_const_for for why. Falls back to calibration_for when there's no
    history yet for this channel (e.g. it was only just calibrated for the first time)."""
    r = db.get_calibration_near(channel, target_utc)
    if r:
        return r["a_const"]
    return calibration_for(channel)
