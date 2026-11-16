"""Per-channel clock calibration: converts an RTP timestamp (90 kHz, wraps every ~13.25 h) to an absolute
UTC time, so frames from different channels/sessions can be compared and multi-camera playback can be
frame-locked (see docs/SPEC.md section 2.4).

Method (measured, not assumed — see docs/SPEC.md section 2.6 for why the naive approach was wrong):
  1. Decode a few seconds of a channel's LIVE sub-stream, keeping each frame's RTP timestamp.
  2. Find the exact frame where the burned-in on-screen clock's seconds digits change ("ticks over"), by
     diffing the bright (white glyph) pixels of the OSD's seconds region — no OCR of the digit VALUE needed,
     only the instant of change, which is frame-exact.
  3. Ask the DVR what time it thinks it is right now (`/ISAPI/System/time`, NTP-synced), and project that
     reading back/forward to the tick's own wall-clock receive time to resolve which whole second it is.
  4. a_const = (that second) - rtp_ts_at_tick/90000.  error_estimate = the query's round-trip time (a real,
     measured bound — typically ~0.1-0.2s on a LAN, occasionally higher under load — not a guess).
"""
import subprocess
import sys
import time
from datetime import datetime, timezone

import isapi
import hikrelay as h

WRAP = 2 ** 32
RTP_HZ = 90000
OSD_BOX = (0, 0, 540, 64)  # x, y, w, h — generous crop of the top-left "YYYY-MM-DD Day HH:MM:SS" overlay on the SD stream


def _dvr_now(conn_isapi):
    """DVR's own clock, from one tightly-timed call; returns (utc_seconds_at(t_mid), round_trip_seconds).
    Uses time.time() (wall clock/epoch), not time.monotonic() (an arbitrary counter) — it has to be on the
    same epoch as the wall-clock receive times recorded in _decode_frames for the two to be comparable."""
    t0 = time.time()
    _, body = conn_isapi.get("/ISAPI/System/time", timeout=6)
    t1 = time.time()
    import re
    m = re.search(r"<localTime>([^<]+)</localTime>", body)
    if not m:
        return None, None, None
    dt = datetime.fromisoformat(m.group(1))
    return dt.timestamp(), (t0 + t1) / 2, t1 - t0


def _decode_frames(conn, path, seconds=6):
    """Open a live sub-stream, capture NALs fully into memory (recording the *wall-clock* time each NAL was
    received, for calibration), then decode in one blocking ffmpeg call. A live bidirectional pipe to ffmpeg
    here deadlocks (its stdout pipe fills, it stops reading stdin, our writer blocks) — capture-then-decode
    avoids that and matches how this codebase already does one-shot decodes elsewhere.
    Returns list of (rtp_ts, wall_clock_received, frame_ndarray)."""
    import numpy as np
    client = h.RtspClient(conn["host"], conn["port"], conn["user"], conn["pw"], path).open()
    aes = h.make_aes(conn["key"]) if conn["encrypted"] else None
    dp = h.Depacketizer(client.codec, aes)
    gate = h.StartGate(client.codec, client.sdp)
    stamps, walls, blob = [], [], bytearray()
    t0 = time.time()
    try:
        for p in client.packets():
            now = time.time()
            for ts, nal in dp.feed(p):
                for n in gate.feed(nal):
                    stamps.append(ts)
                    walls.append(now)
                    blob += h.START + n
            if now - t0 > seconds:
                break
    finally:
        client.close()
    if not stamps:
        return []
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", client.codec, "-i", "-",
         "-vf", f"crop={OSD_BOX[2]}:{OSD_BOX[3]}:{OSD_BOX[0]}:{OSD_BOX[1]},format=gray",
         "-f", "rawvideo", "-"],
        input=bytes(blob), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
    )
    frame_bytes = OSD_BOX[2] * OSD_BOX[3]
    raw = r.stdout
    n = len(raw) // frame_bytes
    frames = [np.frombuffer(raw[i * frame_bytes:(i + 1) * frame_bytes], dtype=np.uint8).reshape(OSD_BOX[3], OSD_BOX[2])
              for i in range(n)]
    n = min(len(frames), len(stamps))
    return list(zip(stamps[:n], walls[:n], frames[:n]))


def _find_tick(frames):
    """Index i such that frames[i] is the first frame after the OSD's bright pixels changed —
    i.e. the seconds digit ticked over between frame i-1 and frame i. None if no clean tick found."""
    import numpy as np
    masks = [(f > 180).astype(np.uint8) for _, _, f in frames]
    diffs = [int(np.abs(masks[i].astype(int) - masks[i - 1].astype(int)).sum()) for i in range(1, len(masks))]
    if not diffs:
        return None
    # a real tick is a spike well above the frame-to-frame noise floor
    baseline = sorted(diffs)[len(diffs) // 3]  # low tercile ~ steady-state noise
    peak = max(diffs)
    idx = diffs.index(peak) + 1
    if peak < max(30, baseline * 4):  # not a confident tick
        return None
    return idx


def calibrate_channel(conn_relay, conn_isapi, channel, sub_path):
    """Returns dict(a_const, error_estimate, method) or dict(error=...) if calibration failed this round.
    error_estimate is the DVR round-trip time of a single /ISAPI/System/time call (typically well under a
    second on a LAN) plus one RTP packet interval — not the length of the capture window, which has no
    bearing on precision now that the tick is anchored to a wall-clock receive time, not decode order."""
    frames = _decode_frames(conn_relay, sub_path, seconds=7)
    if len(frames) < 20:
        return {"error": f"only decoded {len(frames)} OSD frames (need >=20)"}
    idx = _find_tick(frames)
    if idx is None:
        return {"error": "no confident OSD tick-over found in this capture window"}
    tick_rtp, tick_wall, _ = frames[idx]
    dvr_now, query_wall, round_trip = _dvr_now(conn_isapi)
    if dvr_now is None:
        return {"error": "could not read /ISAPI/System/time"}
    # project the DVR's clock reading back/forward from the query instant to the tick's wall-clock instant
    dvr_time_at_tick = dvr_now + (tick_wall - query_wall)
    best = round(dvr_time_at_tick)
    a_const = best - tick_rtp / RTP_HZ
    error_estimate = round(round_trip + 1 / 12, 3)  # + one sub-stream frame interval (12 fps)
    return {"a_const": a_const, "error_estimate": error_estimate, "method": "osd_tick",
            "tick_index": idx, "frames_seen": len(frames), "dvr_time_at_tick": dvr_time_at_tick,
            "rounded_to": best}


# ------------------------------------------------------------------ labelling playback frames
#
# Measured against this recorder's burned-in clock (tools/measure_playback_time.py, docs/SPEC.md section 2.4):
#   * A playback session starts at the keyframe *before* the requested instant — 4.8 to 13.3 s early in 8 runs,
#     and the keyframe interval is 14-20 s on most channels and 50 s on one (ch 2), so up to a minute early.
#   * Recordings keep the RTP timestamps they were recorded with, so the calibration in force *when the footage
#     was recorded* converts them (Oct 15 footage: within +/-1 s using Oct 14-16 measurements).
#   * The RTP base resets for the whole recorder at once every so often (every channel jumps together:
#     10916 -> 1058 -> 29377 -> 39865 -> 3976 -> 45607 -> 14089 -> 6489, as a_const mod the wrap period). A
#     calibration from the other side of a reset is off by hours (Nov 5 footage with the Nov 14 calibration:
#     -14909 s) — the old "nearest calibration by time" pick crossed those, which was the section 2.4 symptom.
#   * Within one regime a_const drifts ~0.4 s/day and single measurements scatter ~+/-1 s.
#   * Asked for a time before its oldest recording, the recorder silently serves the oldest one it has (asked for
#     Oct 9, served Oct 15 — 6 days later), and presumably the next recording after any gap the same way.
PERIOD = WRAP / RTP_HZ
REGIME_TOL_S = 30.0      # same regime: a_const agrees within this (mod PERIOD); drift + noise stay well inside it
PREROLL_MAX_S = 60.0     # the session's first frame can be this far before the request (keyframe interval, 50 s seen)
LATE_SLACK_S = 3.0       # ...and this far after it, by calibration noise alone
CAL_BOUND_S = 1.5        # measured scatter of an in-regime calibration
CAL_DRIFT_S_PER_DAY = 0.4


def _epoch(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, datetime):
        return v.timestamp()
    return datetime.fromisoformat(v).timestamp()


def _circ(a, b):
    d = (a - b) % PERIOD
    return min(d, PERIOD - d)


def regimes(history, tol=REGIME_TOL_S):
    """Calibration rows grouped into runs that share one RTP base: [[row, ...], ...] oldest first. A single row
    that disagrees with both neighbours while they agree with each other is a bad measurement (one seen: 285 s
    off), not a reset, and is dropped. Rows: dicts with a_const and measured_utc (ISO string, datetime or epoch)."""
    rows = sorted(history, key=lambda r: _epoch(r["measured_utc"]))
    agree = lambda x, y: _circ(x["a_const"], y["a_const"]) <= tol
    clean = [r for i, r in enumerate(rows)
             if not (0 < i < len(rows) - 1 and not agree(r, rows[i - 1]) and not agree(r, rows[i + 1])
                     and agree(rows[i - 1], rows[i + 1]))]
    runs = []
    for r in clean:
        if runs and agree(r, runs[-1][-1]):
            runs[-1].append(r)
        else:
            runs.append([r])
    return runs


def _regime_answer(run, rtp_ts, near_utc):
    """(time, a_const, nearest_row) for `rtp_ts` from one regime: the median of its (up to) three rows nearest
    the footage — one measurement scatters ~1 s, and the regime drifts slowly, so near rows beat all rows."""
    first = run[0]["a_const"]
    t0 = abs_time(first, rtp_ts, near_utc)
    near = sorted(run, key=lambda r: abs(_epoch(r["measured_utc"]) - t0))[:3]
    # a_const values in one regime can differ by whole wrap periods (the counter wrapped between measurements);
    # align them before taking a median — abs_time unwraps near near_utc either way.
    aligned = sorted(r["a_const"] + round((first - r["a_const"]) / PERIOD) * PERIOD for r in near)
    a = aligned[len(aligned) // 2]
    return abs_time(a, rtp_ts, near_utc), a, near[0]


def choose_label(rtp_first, target_utc, history, fallback_a_const=None):
    """How to label a playback segment whose first frame has RTP timestamp `rtp_first`, requested at
    `target_utc` (epoch seconds), given the channel's calibration history. Returns a dict:

      time_source "calibration": a_const converts every frame's RTP timestamp to its true recorded time;
                  first_utc is the first frame's time, bound_s an honest +/- bound in seconds.
      time_source "anchor":      no calibration can be trusted for this footage — the first frame is labelled as
                  the requested instant (`offset` added to fallback_a_const's answer) and is really up to one
                  keyframe interval earlier; bound_s is None (unbounded if the recorder skipped a gap).

    A regime's answer is trusted only when it falls in the plausible window [target - PREROLL_MAX_S,
    target + LATE_SLACK_S] (the recorder starts at the keyframe before the request, never later) AND the regime
    was demonstrably in force when the footage was recorded: it has measurements on both sides of that time, or
    it is the newest regime and the footage is newer than its first measurement. Footage in a gap between
    regimes (the reset happened somewhere in it, unknown where) is never trusted. Footage the recorder served
    from much later than requested (a recording gap, a time before its oldest recording) can't be placed from
    RTP at all — the 32-bit timestamp only unwraps unambiguously within +/-6.6 h of a reference, and a wrong
    regime lands in a +/-6.6 h window half the time — so it anchors too, and callers that sign times check the
    coverage index. More than one trusted regime disagreeing means the evidence is ambiguous: anchor."""
    runs = regimes(history)
    lo, hi = target_utc - PREROLL_MAX_S, target_utc + LATE_SLACK_S
    accepted = []
    for i, run in enumerate(runs):
        t, a, nearest = _regime_answer(run, rtp_first, target_utc)
        if t < lo:
            continue
        m_first, m_last = _epoch(run[0]["measured_utc"]), _epoch(run[-1]["measured_utc"])
        if t > hi:
            continue
        bracketed = m_first <= t <= m_last
        newest = i == len(runs) - 1 and t >= m_first
        if bracketed or newest:
            days = abs(t - _epoch(nearest["measured_utc"])) / 86400 if bracketed else max(0.0, t - m_last) / 86400
            err = max(float(nearest.get("error_estimate") or 0), 0)
            accepted.append({"time_source": "calibration", "a_const": a, "first_utc": t,
                             "bound_s": round(CAL_BOUND_S + err + CAL_DRIFT_S_PER_DAY * days, 1),
                             "measured_utc": nearest["measured_utc"], "method": nearest.get("method"),
                             "error_estimate": nearest.get("error_estimate")})
    if len(accepted) > 1 and max(x["first_utc"] for x in accepted) - min(x["first_utc"] for x in accepted) > 2 * LATE_SLACK_S:
        accepted = []
    if accepted:
        return min(accepted, key=lambda x: x["bound_s"])
    out = {"time_source": "anchor", "a_const": fallback_a_const, "first_utc": float(target_utc), "bound_s": None}
    if fallback_a_const is not None:
        out["offset"] = target_utc - abs_time(fallback_a_const, rtp_first, target_utc)
    return out


def abs_time(a_const, rtp_ts, near_utc):
    """Absolute UTC seconds for an RTP timestamp, unwrapped against a nearby known UTC time (e.g. the current
    time when live, or the requested playback time when seeking)."""
    t = a_const + rtp_ts / RTP_HZ
    # rtp_ts is effectively (a_const's reference) mod 2^32/90000 away; unwrap to the instance nearest near_utc
    period = WRAP / RTP_HZ
    n = round((near_utc - t) / period)
    return t + n * period


if __name__ == "__main__":
    import json
    import sys as _sys
    sys.path.insert(0, ".")
    import settings as st
    s = st.load()
    conn = h.conn_of({"connection": s.connection.model_dump()})
    api = isapi.Isapi(s.connection.host, s.connection.username, s.connection.password, s.connection.http_port)
    chans = [int(c) for c in _sys.argv[1:]] or [c.channel for c in s.channels if c.enabled]
    for ch in chans:
        c = next((c for c in s.channels if c.channel == ch), None)
        r = calibrate_channel(conn, api, ch, h.stream_path(ch, "sub", c.sub_path if c else ""))
        print(ch, json.dumps(r))
