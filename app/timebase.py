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
        r = calibrate_channel(conn, api, ch, f"/Streaming/Channels/{ch}02")
        print(ch, json.dumps(r))
