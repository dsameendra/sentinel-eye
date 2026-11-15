"""DVR playback sessions for the browser player: one background reader per open pane, all sharing a
4-slot pool (the DVR's hard session cap — docs/SPEC.md section 2.2/7.3).

Each reader opens an RTSP playback session (`Range: clock=...`), decrypts, depacketizes to access units,
labels each frame with its recorded time (timebase.choose_label: the calibration that was in force when the
footage was recorded when one can be trusted, otherwise anchored to the request and flagged approximate), and
pushes Frame tuples into a thread-safe queue that the WebSocket handler, exports and thumbnails drain. A
session starts at the keyframe before the requested instant (up to a keyframe interval — measured up to ~50 s
— early); those frames are kept, truthfully labelled and flagged `pre`, because decoding needs them.
Seeking and speed changes reissue PLAY on the same RTSP session (cheap: ~70-100ms, no reconnect).
"""
import collections
import datetime
import queue
import threading

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
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    @property
    def codec(self):
        """"hevc" or "h264" once the session is open (from the recorder's SDP), else None."""
        c = self.client
        return c.codec if c is not None else None

    def seek(self, start_utc, speed=None):
        """Ignored when `start_utc` isn't an ISO 8601 instant; an invalid `speed` keeps the current one (the
        server validates both first; this is the second layer before they reach the RTSP request)."""
        dt = parse_utc(start_utc)
        if dt is None:
            return
        self._seek_to = dt.isoformat()
        if valid_speed(speed) is not None:
            self._new_speed = valid_speed(speed)

    def set_speed(self, speed):
        if valid_speed(speed) is not None:
            self._new_speed = valid_speed(speed)

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
            history = db.get_calibration_history(self.channel)
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
        target_utc = start_dt.timestamp()
        seg = None        # decided from this segment's first frame — see _new_segment
        near_raw = target_utc
        aus = AccessUnits(self.client.codec)
        for p in self.client.packets():
            if self._stop.is_set():
                return
            if self._seek_to is not None or self._new_speed is not None:
                # A speed change alone resumes from the newest frame handed out, by its *label* — the raw a_const
                # answer can be hours off for old footage (a calibration from across an RTP reset), and PLAYing at
                # that would jump to different footage.
                resume = self._last_label if self._last_label is not None else target_utc
                seek_dt = (parse_utc(self._seek_to) if self._seek_to else None) or \
                    datetime.datetime.fromtimestamp(resume, datetime.timezone.utc)
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
                target_utc = seek_dt.timestamp()
                near_raw = target_utc
                seg = None   # re-decided for the new segment
                self._last_label = None   # until it delivers a frame, a speed change resumes at this target
                dp = h.Depacketizer(self.client.codec, aes)
                gate = h.StartGate(self.client.codec, self.client.sdp)
                aus = AccessUnits(self.client.codec)
                self._flush_queue()
                continue
            for ts, nal in dp.feed(p):
                for n in gate.feed(nal):
                    au = aus.feed(n)
                    if au is None:
                        continue
                    if seg is None:
                        seg = self._new_segment(target_utc, ts)
                    t, near_raw = _label(seg, ts, near_raw)
                    self._last_label = t
                    try:
                        self.q.put(Frame(t, au[0], au[1], seg, t < seg["display_from"] - 0.02), timeout=2)
                    except queue.Full:
                        pass  # slow consumer: drop rather than stall the DVR session

    def _flush_queue(self):
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass


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
