"""Checks for how playback frames get their recorded time (no recorder): timebase.choose_label's decision between
a calibration and the anchored fallback — regimes split at RTP resets, outliers ignored, gaps and forward jumps
anchored, the plausible window, the 32-bit RTP wrap — and a real PlaybackReader driven by a fake RTSP session:
segment metadata, pre-roll flags, a speed change carrying on in place (PLAY npt=now-, same segment, no repeat),
the pooled calibration history, and a reader stopped while queued for a slot never logging in. Measurements behind the numbers: docs/SPEC.md 2.4.

   .venv/bin/python3 tools/test_playback_time.py
"""
import datetime
import os
import queue
import struct
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-playback-time-")
sys.path.insert(0, "app")
import db  # noqa: E402
import hikrelay as h  # noqa: E402
import playback_session as psess  # noqa: E402
import timebase as tb  # noqa: E402

PASS = []
UTC = datetime.timezone.utc
P = tb.PERIOD
DAY = 86400.0
T0 = 1_792_000_000.0   # 2026-10-14-ish: an epoch for synthetic footage


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def rtp_for(t, a):
    """The RTP timestamp a frame recorded at `t` carries under a regime whose a_const is `a`."""
    return int(round((t - a) * tb.RTP_HZ)) % tb.WRAP


def rows(a, start, end, step=6 * 3600, drift_per_day=0.0, err=0.12):
    out, m = [], start
    while m <= end:
        out.append({"a_const": a + drift_per_day * (m - start) / DAY, "measured_utc": m, "error_estimate": err, "method": "osd_tick"})
        m += step
    return out


A = T0 - 30_000.123        # regime A's a_const
B = A + 17_003.7           # after an RTP reset: a different value mod P


def regimes():
    hist = rows(A, T0 - 5 * DAY, T0 + 5 * DAY) + rows(B, T0 + 6 * DAY, T0 + 9 * DAY)
    runs = tb.regimes(hist)
    check("regimes: a reset splits the history in two", len(runs) == 2 and len(runs[0]) == 41, [len(r) for r in runs])
    bad = dict(hist[10], a_const=hist[10]["a_const"] + 285.0)   # one bad measurement (seen: 285 s off)
    runs = tb.regimes(hist[:10] + [bad] + hist[11:])
    check("regimes: a single outlier is dropped, not a reset", len(runs) == 2 and len(runs[0]) == 40, [len(r) for r in runs])
    wrapped = [dict(r, a_const=r["a_const"] + (P if i % 2 else 0)) for i, r in enumerate(rows(A, T0, T0 + 2 * DAY))]
    check("regimes: a_const values a whole wrap apart are one regime", len(tb.regimes(wrapped)) == 1)
    drifting = rows(A, T0 - 20 * DAY, T0 + 20 * DAY, drift_per_day=0.4)
    check("regimes: 0.4 s/day drift over 40 days stays one regime", len(tb.regimes(drifting)) == 1)


def labels():
    hist = rows(A, T0 - 5 * DAY, T0 + 5 * DAY) + rows(B, T0 + 6 * DAY, T0 + 9 * DAY)

    # Old footage inside regime A, the session starting 9.3 s before the request (the previous keyframe).
    true0 = T0 + 1234.5
    r = tb.choose_label(rtp_for(true0, A), true0 + 9.3, hist, fallback_a_const=B)
    check("bracketed old footage -> calibration", r["time_source"] == "calibration", r)
    check("...first frame at its true time, not the request", abs(r["first_utc"] - true0) < 0.01, r["first_utc"] - true0)
    check("...with an honest bound (~1.5 s + measurement error)", 1.5 <= r["bound_s"] <= 2.0, r["bound_s"])

    # Newest regime, footage two days after its last measurement (the app was off): trusted inside the window,
    # with drift added to the bound.
    true1 = T0 + 11 * DAY
    r = tb.choose_label(rtp_for(true1, B), true1 + 4.8, hist)
    check("newest regime, footage after its last row -> calibration", r["time_source"] == "calibration" and abs(r["first_utc"] - true1) < 0.01, r)
    check("...bound grows ~0.4 s/day past the last row", r["bound_s"] >= 1.5 + 0.8, r["bound_s"])

    # A ch2-like 50 s keyframe interval is still inside the window; past PREROLL_MAX_S it isn't.
    r = tb.choose_label(rtp_for(true0, A), true0 + 50, hist)
    check("50 s pre-roll (measured on ch 2) -> calibration", r["time_source"] == "calibration", r)
    r = tb.choose_label(rtp_for(true0, A), true0 + tb.PREROLL_MAX_S + 10, hist)
    check("answer before the window -> anchor", r["time_source"] == "anchor", r)
    r = tb.choose_label(rtp_for(true0 + 10, A), true0, hist)
    check("answer 10 s after the request -> anchor (never served later than asked)", r["time_source"] == "anchor", r)

    # Footage in the gap between regimes: the reset happened somewhere in it, unknown where.
    gap = T0 + 5.5 * DAY
    r = tb.choose_label(rtp_for(gap, B), gap + 3, hist)
    check("gap footage recorded under the later regime -> anchor", r["time_source"] == "anchor", r)
    r = tb.choose_label(rtp_for(gap, A), gap + 3, hist)
    check("gap footage recorded under the earlier regime -> anchor", r["time_source"] == "anchor", r)

    # Measured: asked for a time before the oldest recording, the recorder served footage days later.
    asked = T0 - 1 * DAY
    r = tb.choose_label(rtp_for(asked + 2 * DAY, A), asked, hist)
    check("forward jump (recorder served 2 days later) -> anchor, never a wrong 'calibrated' time", r["time_source"] == "anchor", r)

    old = T0 - 9 * DAY
    r = tb.choose_label(rtp_for(old, A), old + 6, hist)
    check("footage older than every calibration -> anchor", r["time_source"] == "anchor", r)

    r = tb.choose_label(123456, T0, [], fallback_a_const=A)
    lab = tb.abs_time(r["a_const"], 123456, T0) + r["offset"]
    check("no history -> anchor labelled exactly the request", r["time_source"] == "anchor" and abs(lab - T0) < 1e-6 and r["bound_s"] is None, r)

    # The wrong-regime pick the old code made: nearest calibration by time is from across the reset.
    nearest_by_time = min(hist, key=lambda x: abs(x["measured_utc"] - (T0 + 5.6 * DAY)))
    t_wrong = tb.abs_time(nearest_by_time["a_const"], rtp_for(T0 + 4.9 * DAY, A), T0 + 4.9 * DAY)
    check("(the old nearest-by-time pick is hours off across a reset)", abs(t_wrong - (T0 + 4.9 * DAY)) > 600, t_wrong - (T0 + 4.9 * DAY))

    # A calibration taken many wraps away still unwraps to the right instant.
    a_far = true0 - 3.5 * P
    far_hist = rows(a_far, true0 - DAY, true0 + DAY)
    r = tb.choose_label(rtp_for(true0, a_far), true0 + 7, far_hist)
    check("unwraps across many 13.25 h periods", r["time_source"] == "calibration" and abs(r["first_utc"] - true0) < 0.01, r)


def wrap():
    """Frame labels stay monotonic and evenly spaced across the 32-bit RTP wrap (every ~13.25 h)."""
    a = T0 - 40_000.0
    t_wrap = a + P * round((T0 - a) / P)          # an instant where rtp wraps to 0
    start = t_wrap - 0.5
    seg = {"_a": a, "_offset": 0.0}
    near, out, rtps = start, [], []
    for i in range(16):
        ts = rtp_for(start + i / 15, a)
        rtps.append(ts)
        t, near = psess._label(seg, ts, near)
        out.append(t)
    steps = [b - x for x, b in zip(out, out[1:])]
    check("wrap: the RTP counter really wrapped in this run", any(b < x for x, b in zip(rtps, rtps[1:])))
    check("wrap: labels step 1/15 s straight across it", all(abs(s - 1 / 15) < 1e-4 for s in steps), [round(s, 4) for s in steps])
    r = tb.choose_label(rtps[0], start + 5, rows(a, start - DAY, start + DAY))
    check("wrap: the first frame just before a wrap is placed correctly", abs(r["first_utc"] - start) < 0.01, r)
    seg = {"_a": a, "_offset": 12.5}
    t, _ = psess._label(seg, rtps[0], start)
    check("anchor offset applied to the label, not to the unwrap reference", abs(t - (start + 12.5)) < 1e-6)


def access_units():
    au = psess.AccessUnits("h264")
    got = [au.feed(n) for n in (b"\x67\x42", b"\x68\xce", b"\x65\x88", b"\x41\x9a", b"\x06\x05", b"\x41\x9b")]
    check("h264: parameter sets ride with the IDR as one key access unit",
          got[:2] == [None, None] and got[2] == (True, h.START + b"\x67\x42" + h.START + b"\x68\xce" + h.START + b"\x65\x88"), got[2])
    check("h264: a P slice is a delta unit; an SEI waits for the next slice",
          got[3] == (False, h.START + b"\x41\x9a") and got[4] is None and got[5] == (False, h.START + b"\x06\x05" + h.START + b"\x41\x9b"))
    au = psess.AccessUnits("hevc")
    vps, sps, pps, idr, trail = b"\x40\x01", b"\x42\x01", b"\x44\x01", b"\x26\x01", b"\x02\x01"
    got = [au.feed(n) for n in (vps, sps, pps, idr, trail)]
    check("hevc: VPS/SPS/PPS + IDR_W_RADL -> one key unit, TRAIL_R -> delta",
          got[3] and got[3][0] is True and got[3][1].count(h.START) == 4 and got[4] == (False, h.START + trail))


# ------------------------------------------------------------------ a real PlaybackReader, fake recorder
FPS = 15
GOP_S = 16.0      # this recorder's typical keyframe interval (ch 1/4: 14-20 s; ch 2: 50 s)
TZ = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def rtp_packet(seq, ts, nal):
    return struct.pack(">BBHII", 0x80, 96, seq & 0xFFFF, ts, 0x1234) + nal


class FakeRecorder:
    """Stands in for hikrelay.RtspClient: serves H.264 from the keyframe at or before each PLAY's clock= start,
    with RTP timestamps from regime `a_true`, and records every PLAY range."""
    a_true = None
    instances = []

    def __init__(self, host, port, user, pw, path, timeout=10, guarded=True):
        self.codec, self.sdp, self.sock, self.plays = "h264", "", None, []
        self._from = None
        FakeRecorder.instances.append(self)

    def _seek(self, rng):
        local = datetime.datetime.strptime(rng.split("=")[1].split("-")[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=TZ)
        t = local.timestamp()
        self._from = t - (t % GOP_S)          # the keyframe before (GOPs aligned to multiples of GOP_S)
        self._gen = getattr(self, "_gen", 0) + 1

    def open(self, play_range="", scale=None, idle_timeout=8):
        self.plays.append((play_range, scale))
        self._seek(play_range)
        return self

    def play(self, range_="", scale=None, keep=False):
        self.plays.append((range_, scale))
        if not range_.startswith("npt=now"):   # npt=now-: carry on from the next frame (as the recorder does)
            self._seek(range_)
        return "RTSP/1.0 200 OK"

    def pause(self):
        return "RTSP/1.0 200 OK"

    def keepalive(self):
        return "RTSP/1.0 200 OK"

    def packets(self):
        seq, gen, i = 0, None, 0
        while True:
            if gen != self._gen:
                gen, i = self._gen, 0
            t = self._from + i / FPS
            ts = rtp_for(t, FakeRecorder.a_true)
            if i % int(GOP_S * FPS) == 0:
                for nal in (b"\x67\x42\xe0\x1e", b"\x68\xce\x3c\x80", b"\x65\x88\x84"):
                    seq += 1
                    yield rtp_packet(seq, ts, nal)
            else:
                seq += 1
                yield rtp_packet(seq, ts, b"\x41\x9a\x02")
            i += 1
            time.sleep(0.0005)

    def teardown(self):
        pass

    def close(self):
        pass


CONN = {"host": "10.0.0.9", "port": 554, "user": "u", "pw": "p", "encrypted": False, "key": ""}


def reader_end_to_end():
    db.init()
    ch = 3
    a_true = A
    FakeRecorder.a_true = a_true
    req = T0 + 0.3 * DAY + 7.0   # 7 s into a GOP
    # Regime A around the footage, plus one bad measurement nearer in time than any good one: the old
    # nearest-by-time pick (still what get_calibration_near returns) is then hours off — the reader must not
    # use it for labels, nor for where a speed change resumes.
    for r in rows(a_true, req - 2 * DAY, req + 2 * DAY):
        if abs(r["measured_utc"] - req) > 3600:
            db.set_calibration(ch, r["a_const"], r["error_estimate"], r["method"], datetime.datetime.fromtimestamp(r["measured_utc"], UTC).isoformat())
    db.set_calibration(ch, a_true + 9000.5, 0.1, "osd_tick", datetime.datetime.fromtimestamp(req + 60, UTC).isoformat())
    nearest = db.get_calibration_near(ch, datetime.datetime.fromtimestamp(req, UTC))
    check("setup: the nearest-by-time calibration is the bad one", abs(nearest["a_const"] - (a_true + 9000.5)) < 1e-6)

    real = h.RtspClient
    h.RtspClient = FakeRecorder
    try:
        r = psess.PlaybackReader(CONN, ch, "/Streaming/tracks/301", nearest["a_const"],
                                 datetime.datetime.fromtimestamp(req, UTC).isoformat(), TZ, "1")
        r.start()
        frames = []
        while len(frames) < 200:
            it = r.q.get(timeout=5)
            if it is None or it[0] == "error":
                check("reader: delivers frames without an error", False, it)
                return
            frames.append(it)
        f0 = frames[0]
        seg = f0.seg
        check("reader: frames are Frame tuples", isinstance(f0, psess.Frame) and f0.key)
        check("reader: segment labelled from the calibration in force", seg["time_source"] == "calibration" and not seg["approx"], seg["time_source"])
        check("reader: first frame is the keyframe before the request, at its true time",
              abs(f0.t - (req - 7.0)) < 0.01, f0.t - req)
        check("reader: display_from is the request", seg["display_from"] == req)
        pre = [f.pre for f in frames]
        n_pre = pre.index(False)
        check("reader: exactly the frames before the request are flagged pre", n_pre == 7 * FPS and not any(pre[n_pre:]), n_pre)
        check("reader: the first shown frame is the requested instant", abs(frames[n_pre].t - req) < 1 / FPS)
        check("reader: codec reported", seg["codec"] == "h264" and r.codec == "h264")
        pub = psess.public_segment(seg)
        check("reader: public segment has no private fields", set(pub) == {"codec", "time_source", "approx", "display_from", "first_utc", "bound_s"}, pub)
        steps = [b.t - x.t for x, b in zip(frames, frames[1:])]
        check("reader: labels evenly spaced", all(abs(s - 1 / FPS) < 1e-3 for s in steps))

        rec = FakeRecorder.instances[-1]
        last = frames[-1]
        r.set_speed("2")
        deadline = time.time() + 5
        after = []
        while (len(rec.plays) < 2 or len(after) < 30) and time.time() < deadline:
            try:
                it = r.q.get(timeout=0.2)
            except queue.Empty:
                continue
            if it is not None and it[0] == "feed":
                continue
            after.append(it)
        check("speed change re-PLAYs in place (npt=now-, new Scale), not at a clock= time",
              len(rec.plays) >= 2 and rec.plays[-1] == ("npt=now-", "2"), rec.plays[-1:])
        seq = [last] + after
        check("speed change: the same segment carries on, the next frame after the last one, no repeat or gap",
              all(f.seg is seg for f in after) and all(abs((b.t - a.t) - 1 / FPS) < 1e-3 for a, b in zip(seq, seq[1:])),
              [round(b.t - a.t, 3) for a, b in zip(seq, seq[1:])][:5])
        r.stop()
        r.thread.join(timeout=5)
        check("reader: stops", not r.thread.is_alive())

        # Another channel with no history of its own: the recorder's RTP clock is shared, so channel 3's
        # calibrations label it too (pooled_history).
        r = psess.PlaybackReader(CONN, 4, "/Streaming/tracks/401", None, datetime.datetime.fromtimestamp(req, UTC).isoformat(), TZ, "1")
        r.start()
        it = r.q.get(timeout=5)
        r.stop()
        r.thread.join(timeout=5)
        check("pooled: a channel with no rows of its own is labelled from the shared clock's history",
              it.seg["time_source"] == "calibration" and abs(it.t - (req - 7.0)) < 0.01, it.seg["time_source"])

        # Anchored fallback: footage no calibration regime covers (long before every measurement).
        old = req - 40 * DAY
        r = psess.PlaybackReader(CONN, 4, "/Streaming/tracks/401", None, datetime.datetime.fromtimestamp(old, UTC).isoformat(), TZ, "1")
        r.start()
        it = r.q.get(timeout=5)
        r.stop()
        r.thread.join(timeout=5)
        check("anchored: approx, first frame labelled the request, nothing flagged pre",
              it.seg["time_source"] == "anchor" and it.seg["approx"] and abs(it.t - old) < 1e-6 and not it.pre, it.seg)
    finally:
        h.RtspClient = real


def stop_while_queued():
    """A reader stopped while waiting for a slot must not log in once a slot frees up (a closed pane, a cancelled
    export) — it used to open its RTSP session anyway."""
    real = h.RtspClient
    h.RtspClient = FakeRecorder
    before = len(FakeRecorder.instances)
    held = [psess.pool.acquire(timeout=1) for _ in range(psess.pool.limit)]
    try:
        r = psess.PlaybackReader(CONN, 3, "/Streaming/tracks/301", A, datetime.datetime.fromtimestamp(T0, UTC).isoformat(), TZ, "1")
        r.start()
        time.sleep(0.3)
        check("queued: reader is waiting for a slot", r.waiting_for_slot)
        r.stop()
        for ok in held:
            if ok:
                psess.pool.release()
        held = []
        r.thread.join(timeout=5)
        check("queued then stopped: never opened a session", len(FakeRecorder.instances) == before and not r.thread.is_alive())
        check("queued then stopped: the slot went back to the pool", psess.pool.busy == 0, psess.pool.busy)
    finally:
        for ok in held:
            if ok:
                psess.pool.release()
        h.RtspClient = real


def main():
    regimes()
    labels()
    wrap()
    access_units()
    reader_end_to_end()
    stop_while_queued()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
