"""Checks for how a playback session's feed is steered (no recorder): speed changes and resuming a held feed carry
on in place (PLAY `Range: npt=now-`, measured on the recorder — docs/SPEC.md 7.4, tools/NOTES.md), video that
arrives ahead of an RTSP reply is kept rather than dropped, hold/resume map to RTSP PAUSE (kept alive) and PLAY,
a recorder that refuses the in-place PLAY falls back to reopening at the newest frame with the replayed frames
flagged (never shown twice), the budget refusing a faster feed is not fatal, a slow consumer loses no frame
(the feed is paused for it instead), and every channel's calibrations are pooled per round.

   .venv/bin/python3 tools/test_playback_feed.py
"""
import datetime
import os
import queue
import socket
import struct
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-playback-feed-")
sys.path.insert(0, "app")
import db  # noqa: E402
import hikrelay as h  # noqa: E402
import playback_session as psess  # noqa: E402
import timebase as tb  # noqa: E402

PASS = []
UTC = datetime.timezone.utc
TZ = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
FPS = 15
GOP_S = 16.0
T0 = 1_792_000_000.0
A = T0 - 30_000.123


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def rtp_for(t, a=A):
    return int(round((t - a) * tb.RTP_HZ)) % tb.WRAP


def rtp_packet(seq, ts, nal):
    return struct.pack(">BBHII", 0x80, 96, seq & 0xFFFF, ts, 0x1234) + nal


# ------------------------------------------------------------------ RtspClient keeps video ahead of a reply
def pending_packets():
    a, b = socket.socketpair()
    c = h.RtspClient("10.0.0.9", 554, "u", "p", "/Streaming/tracks/101", guarded=False)
    c.sock = a
    c.session = "1"
    frame = lambda ch, payload: b"$" + bytes([ch]) + struct.pack(">H", len(payload)) + payload
    reply = b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nSession: 1\r\n\r\n"

    def serve(chunks):
        b.recv(65536)   # the request
        b.sendall(b"".join(chunks))

    t = threading.Thread(target=serve, args=([frame(0, b"v1"), frame(1, b"rtcp"), frame(0, b"v2"), reply, frame(0, b"v3")],))
    t.start()
    st = c.play("npt=now-", "4", keep=True)
    t.join()
    check("PLAY in place: status read past the interleaved video", st == "RTSP/1.0 200 OK", st)
    got = []
    pk = c.packets()
    for _ in range(3):
        got.append(next(pk))
    check("PLAY in place (keep): video that arrived before the reply comes out first, in order, RTCP dropped",
          got == [b"v1", b"v2", b"v3"], got)

    t = threading.Thread(target=serve, args=([frame(0, b"old1"), reply, frame(0, b"new1")],))
    t.start()
    c.play("clock=20261115T100000Z-20261116T100000Z", "1")
    t.join()
    got = next(c.packets())
    check("seek (keep=False): video from the old position is dropped", got == b"new1", got)

    t = threading.Thread(target=serve, args=([frame(0, b"p1"), reply],))
    t.start()
    st = c.pause()
    t.join()
    check("PAUSE: the frames still in flight are kept for the resume", st.endswith("200 OK") and c.pending == [b"p1"], c.pending)
    t = threading.Thread(target=serve, args=([reply],))
    t.start()
    st = c.keepalive()
    t.join()
    check("keepalive: OPTIONS answered", st.endswith("200 OK"))
    a.close()
    b.close()


# ------------------------------------------------------------------ a reader against a fake recorder
class Fake:
    """hikrelay.RtspClient stand-in: H.264 at FPS from the GOP keyframe before each clock= PLAY; `npt=now-` carries
    on (or, with refuse_npt, is refused with 455 as a dead session would be); PAUSE stops the flow. Records commands."""
    refuse_npt = False
    instances = []

    def __init__(self, host, port, user, pw, path, timeout=10, guarded=True):
        self.codec, self.sdp, self.sock = "h264", "", None
        self.log = []
        self.paused = False
        self._i = 0
        Fake.instances.append(self)

    def _seek(self, rng):
        local = datetime.datetime.strptime(rng.split("=")[1].split("-")[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=TZ)
        t = local.timestamp()
        self._from = t - (t % GOP_S)
        self._i = 0
        self._gen = getattr(self, "_gen", 0) + 1

    def open(self, play_range="", scale=None, idle_timeout=8):
        self.log.append(("OPEN", play_range, scale))
        self._seek(play_range)
        return self

    def play(self, range_="", scale=None, keep=False):
        self.log.append(("PLAY", range_, scale))
        if range_.startswith("npt=now"):
            if Fake.refuse_npt:
                return "RTSP/1.0 455 Method Not Valid in This State"
        else:
            self._seek(range_)
        self.paused = False
        return "RTSP/1.0 200 OK"

    def pause(self):
        self.log.append(("PAUSE",))
        self.paused = True
        return "RTSP/1.0 200 OK"

    def keepalive(self):
        self.log.append(("OPTIONS",))
        return "RTSP/1.0 200 OK"

    def packets(self):
        seq = 0
        while True:
            while self.paused:
                time.sleep(0.01)
            gen = self._gen
            t = self._from + self._i / FPS
            ts = rtp_for(t)
            if self._i % int(GOP_S * FPS) == 0:
                for nal in (b"\x67\x42\xe0\x1e", b"\x68\xce\x3c\x80", b"\x65\x88\x84"):
                    seq += 1
                    yield rtp_packet(seq, ts, nal)
            else:
                seq += 1
                yield rtp_packet(seq, ts, b"\x41\x9a\x02")
            if gen == self._gen:   # not re-seeked while this frame was going out
                self._i += 1
            time.sleep(0.0005)

    def teardown(self):
        self.log.append(("TEARDOWN",))

    def close(self):
        pass


CONN = {"host": "10.0.0.9", "port": 554, "user": "u", "pw": "p", "encrypted": False, "key": ""}


def drain(r, n, timeout=5, keep_feed=None):
    out, deadline = [], time.time() + timeout
    while len(out) < n and time.time() < deadline:
        try:
            it = r.q.get(timeout=0.2)
        except queue.Empty:
            continue
        if it is None or it[0] == "error":
            out.append(it)
            break
        if it[0] == "feed":
            if keep_feed is not None:
                keep_feed.append(it[1])
            continue
        out.append(it)
    return out


def contiguous(frames):
    return all(abs((b.t - a.t) - 1 / FPS) < 1e-3 for a, b in zip(frames, frames[1:]))


def reader(req, speed="1"):
    r = psess.PlaybackReader(CONN, 3, "/Streaming/tracks/301", A, datetime.datetime.fromtimestamp(req, UTC).isoformat(), TZ, speed)
    r.start()
    return r


def calibrate():
    db.init()
    for k in range(-8, 9):
        m = T0 + k * 6 * 3600
        db.set_calibration(3, A, 0.1, "osd_tick", datetime.datetime.fromtimestamp(m, UTC).isoformat())


def hold_resume():
    real = h.RtspClient
    h.RtspClient = Fake
    try:
        req = T0 + 7.0
        r = reader(req)
        first = drain(r, 150)
        rec = Fake.instances[-1]
        feeds = []
        r.hold()
        time.sleep(0.3)
        # whatever was already queued still arrives; then nothing new while held
        held = drain(r, 10000, timeout=0.6, keep_feed=feeds)
        n_before = rec._i
        time.sleep(0.4)
        check("hold: RTSP PAUSE sent, the feed stops", ("PAUSE",) in rec.log and rec._i == n_before, rec.log[-3:])
        check("hold: acknowledged to the consumer", any(f.get("hold") for f in feeds), feeds)
        old_ka = psess.KEEPALIVE_S
        psess.KEEPALIVE_S = 0.3
        time.sleep(0.8)
        psess.KEEPALIVE_S = old_ka
        check("hold: kept alive with OPTIONS", ("OPTIONS",) in rec.log)
        r.resume()
        after = drain(r, 60, keep_feed=feeds)
        seq = (first + held)[-1:] + after
        check("resume: PLAY npt=now- at the same speed", ("PLAY", "npt=now-", "1") in rec.log, rec.log[-2:])
        check("resume: carries on from the next frame, same segment, nothing repeated or lost",
              contiguous(seq) and all(f.seg is first[0].seg for f in after), [round(b.t - a.t, 3) for a, b in zip(seq, seq[1:])][:4])

        # A speed change while held is applied with the resume.
        r.hold()
        drain(r, 10000, timeout=0.5)
        r.set_speed("4")
        time.sleep(0.3)
        check("speed while held: not applied until resumed", ("PLAY", "npt=now-", "4") not in rec.log)
        r.resume()
        drain(r, 10, keep_feed=feeds)
        check("speed while held: resumed at the new speed", ("PLAY", "npt=now-", "4") in rec.log and r.speed == "4")

        # A seek while held: PLAY clock= from the paused session.
        r.hold()
        drain(r, 10000, timeout=0.5)
        target = T0 + 100.0
        r.seek(datetime.datetime.fromtimestamp(target, UTC).isoformat(), "1")
        got = drain(r, 5)
        check("seek while held: resumes with a new segment at the keyframe before the target",
              got and got[0].seg is not first[0].seg and abs(got[0].t - (target - target % GOP_S)) < 0.01, got[:1])
        r.stop()
        r.thread.join(timeout=5)
        check("reader stops (held or not), pool released", not r.thread.is_alive() and psess.pool.busy == 0, psess.pool.busy)
    finally:
        h.RtspClient = real


def refused_in_place():
    """A recorder that refuses PLAY npt=now- (never seen on this one): reopen at the newest frame handed out; the
    keyframe pre-roll it replays is flagged, so nothing already shown counts as new."""
    real = h.RtspClient
    h.RtspClient = Fake
    Fake.refuse_npt = True
    try:
        req = T0 + 7.0
        r = reader(req)
        first = drain(r, 200)
        last = first[-1].t
        n0 = len(Fake.instances)
        r.set_speed("2")
        after = drain(r, 300)
        check("refused: a fresh session is opened at the newest frame",
              len(Fake.instances) == n0 + 1 and Fake.instances[-1].log[0][2] == "2", Fake.instances[-1].log[:1])
        replay = [f for f in after if f.t <= last + 1e-6]
        new = [f for f in after if f.t > last + 1e-6]
        check("refused: the replayed frames (from the keyframe before) are all flagged pre", replay and all(f.pre for f in replay), len(replay))
        check("refused: then it carries on with the next frame, not flagged", new and not new[0].pre and abs(new[0].t - last - 1 / FPS) < 1e-3,
              new[:1] and new[0].t - last)
        r.stop()
        r.thread.join(timeout=5)
    finally:
        Fake.refuse_npt = False
        h.RtspClient = real


def budget_refused():
    real = h.RtspClient
    h.RtspClient = Fake
    held = []
    try:
        r = reader(T0 + 7.0)
        drain(r, 20)
        for _ in range(3):   # fill the rest of the budget: 1 + 3*5 = 16
            held.append(psess.pool.acquire(timeout=1, speed="4"))
        feeds = []
        r.set_speed("8")
        got = drain(r, 30, keep_feed=feeds)
        check("budget refuses a faster feed: not fatal, it carries on at the old speed and says so",
              got and got[-1] is not None and got[-1][0] != "error" and r.speed == "1" and any(f.get("refused") == "8" for f in feeds), feeds)
        r.stop()
        r.thread.join(timeout=5)
    finally:
        for ok in held:
            if ok:
                psess.pool.release("4")
        h.RtspClient = real


def slow_consumer():
    real = h.RtspClient
    h.RtspClient = Fake
    old = psess.AUTO_HOLD_S
    psess.AUTO_HOLD_S = 0.5
    try:
        r = reader(T0 + 7.0)
        r.q = queue.Queue(maxsize=20)
        time.sleep(1.5)   # nobody reading
        rec = Fake.instances[-1]
        check("slow consumer: the feed is paused for it (not dropped)", ("PAUSE",) in rec.log, rec.log[-2:])
        got = drain(r, 300)
        check("slow consumer: every frame arrives, in order", len(got) == 300 and contiguous(got), len(got))
        check("slow consumer: resumed in place once drained", ("PLAY", "npt=now-", "1") in rec.log)
        r.stop()
        r.thread.join(timeout=5)
    finally:
        psess.AUTO_HOLD_S = old
        h.RtspClient = real


def pooled():
    db.query("DELETE FROM calibration_history")
    iso = lambda t: datetime.datetime.fromtimestamp(t, UTC).isoformat()
    m = T0
    for ch, off in zip(range(1, 9), (0.3, -0.4, 0.1, 0.6, -0.2, 0.0, 285.0, -0.1)):   # ch 7: a bad reading
        db.set_calibration(ch, A + off + (tb.PERIOD if ch == 2 else 0), 0.1, "osd_tick", iso(m + ch * 20))
    db.set_calibration(1, A + 0.2, 0.1, "osd_tick", iso(m + 6 * 3600))
    hist = psess.pooled_history()
    check("pooled: one row per calibration round", len(hist) == 2, len(hist))
    check("pooled: a round is its median, the outlier left out, wraps aligned",
          abs(hist[0]["a_const"] - (A + 0.0)) < 1e-6 and hist[0]["n"] == 7, (hist[0]["a_const"] - A, hist[0]["n"]))
    check("pooled: a lone measurement is a round of its own", abs(hist[1]["a_const"] - (A + 0.2)) < 1e-6)
    check("pooled: one regime", len(tb.regimes(hist)) == 1)


def main():
    pending_packets()
    calibrate()
    hold_resume()
    refused_in_place()
    budget_refused()
    slow_consumer()
    pooled()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
