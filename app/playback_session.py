"""DVR playback sessions for the browser player: one background reader per open pane, all sharing a
4-slot pool (the DVR's hard session cap — docs/playback-spec.md section 2.2/7.3).

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
NICE_SPEEDS = ("0.125", "0.25", "0.5", "1", "2", "4", "8", "16")


class SessionPool:
    """Counting gate on the DVR's 4-session limit, shared by every open playback pane."""

    def __init__(self, limit=MAX_SESSIONS):
        self._sem = threading.Semaphore(limit)
        self._lock = threading.Lock()
        self._in_use = 0
        self.limit = limit

    def acquire(self, timeout=20):
        got = self._sem.acquire(timeout=timeout)
        if got:
            with self._lock:
                self._in_use += 1
        return got

    def release(self):
        with self._lock:
            self._in_use = max(0, self._in_use - 1)
        self._sem.release()

    @property
    def busy(self):
        with self._lock:
            return self._in_use


pool = SessionPool()


def hik_time(dt: datetime.datetime, tz) -> str:
    """Format an absolute instant as the DVR wants for `Range: clock=...`: like its logs, the trailing 'Z'
    here does not mean UTC — the DVR expects its own LOCAL wall-clock digits (verified: requesting UTC time
    directly, unconverted, played back footage ~5.5h off — exactly the DVR's UTC+5:30 offset)."""
    return dt.astimezone(tz).strftime("%Y%m%dT%H%M%SZ")


class PlaybackReader:
    """One DVR playback session + decrypt/depacketize pipeline, feeding a bounded queue."""

    def __init__(self, conn, channel, main_path, a_const, start_utc, tz, speed="1"):
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
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass

    def _run(self):
        self.waiting_for_slot = True
        if not pool.acquire(timeout=25):
            self.error = "The recorder's 4 playback sessions are all busy — try again shortly."
            self.q.put(("error", self.error))
            return
        self.waiting_for_slot = False
        try:
            self._play_loop()
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
                self.client.close()
            pool.release()

    def _play_loop(self):
        start_dt = datetime.datetime.fromisoformat(self._seek_to or self.start_utc)
        self._seek_to = None
        # The DVR refuses PLAY for a time too close to "now" (still-open recording segment) — with 400 Bad
        # Request and no other signal. How close is inconsistent (not a fixed margin we can just default
        # past), so back off and retry rather than guess: verified this recovers cleanly.
        for attempt in range(6):
            end_dt = start_dt + datetime.timedelta(hours=24)
            rng = f"clock={hik_time(start_dt, self.tz)}-{hik_time(end_dt, self.tz)}"
            self.client = h.RtspClient(self.conn["host"], self.conn["port"], self.conn["user"], self.conn["pw"], self.path)
            try:
                self.client.open(play_range=rng, scale=self.speed, idle_timeout=15)
                break
            except h.RelayError as e:
                too_close = "400" in str(e) or "453" in str(e)
                if not too_close or attempt == 5:
                    raise
                self.client.close()
                start_dt -= datetime.timedelta(seconds=20)
        aes = h.make_aes(self.conn["key"]) if self.conn["encrypted"] else None
        dp = h.Depacketizer(self.client.codec, aes)
        gate = h.StartGate(self.client.codec, self.client.sdp)
        near_utc = start_dt.timestamp()
        au_buf = bytearray()
        for p in self.client.packets():
            if self._stop.is_set():
                return
            if self._seek_to is not None or self._new_speed is not None:
                seek_dt = datetime.datetime.fromisoformat(self._seek_to) if self._seek_to else \
                    datetime.datetime.fromtimestamp(near_utc, datetime.timezone.utc)
                speed = self._new_speed or self.speed
                self._seek_to, self._new_speed = None, None
                self.speed = speed
                for attempt in range(6):
                    seek_end = seek_dt + datetime.timedelta(hours=24)
                    status = self.client.play(f"clock={hik_time(seek_dt, self.tz)}-{hik_time(seek_end, self.tz)}", speed)
                    if status.startswith("RTSP/1.0 200") or ("400" not in status and "453" not in status) or attempt == 5:
                        break
                    seek_dt -= datetime.timedelta(seconds=20)
                if not status.startswith("RTSP/1.0 200"):
                    self.q.put(("error", f"Seek/speed change failed: {status}"))
                    return
                near_utc = seek_dt.timestamp()
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
                    try:
                        self.q.put((abs_t, is_key, bytes(au_buf)), timeout=2)
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


def calibration_for(channel):
    r = db.get_calibration(channel)
    return r["a_const"] if r else None
