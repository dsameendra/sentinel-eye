"""REAL-RECORDER SCRIPT — read-only, but it logs in to the user's DVR. Do not run it unless the owner asks.

Measures how a playback session's first frame relates to the instant that was requested, against the only
ground truth the recordings carry: the recorder's burned-in on-screen clock (OSD). For each channel and each
requested instant T it opens one PlaybackReader at exactly T (the same reader live playback, thumbnails and
exports use), keeps ~4 s of frames with each frame's RTP timestamp, decodes them with ffmpeg cropped to the
OSD clock, finds the frame where the seconds digit ticks over, and saves that frame's crop as a PNG so its
digits can be read (by eye — no OCR dependency). It prints, per run:

  * the label the app gives the first frame and where it came from (time_source: calibration | anchor),
  * the time a fresh calibration (one `timebase.calibrate_channel`, live sub-stream + one ISAPI clock read)
    gives it, and the time the app's stored calibration history (read-only from the real playback.db) gives
    it — the nearest-in-time row, and every distinct regime that lands near T,
  * the RTP span from the first frame to the OSD tick, so first-frame true time = OSD second at the tick −
    that span.

Safety (AGENTS.md: repeated failed logins lock the DVR account):
  * SENTINEL_DATA points at a scratch dir; the real settings and calibration history are only *read* (the
    settings file is parsed in place, never copied; playback.db is opened `immutable=1`). Credentials are
    never printed.
  * Every recorder client is the guarded one; the script aborts if the real lockout marker exists, and stops
    all contact at the first authentication failure.
  * One playback session at a time, each torn down (reader.stop()) before the next.

    .venv/bin/python3 tools/measure_playback_time.py --real-history --channels 1,5 \
        --times 2026-11-15T13:20:37Z,2026-10-16T04:30:13Z --out /path/outside/the/repo

  --full-frame saves one full first frame per channel instead (to locate the OSD on the main stream).
"""
import argparse
import datetime
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REAL_DATA = ROOT / "data"
os.environ["SENTINEL_DATA"] = os.environ.get("MEASURE_SCRATCH") or tempfile.mkdtemp(prefix="se-measure-")
sys.path.insert(0, str(ROOT / "app"))

import numpy as np  # noqa: E402

import db  # noqa: E402
import events  # noqa: E402
import hikrelay as h  # noqa: E402
import isapi  # noqa: E402
import playback_session as psess  # noqa: E402
import recorder_guard  # noqa: E402
import settings as cfg  # noqa: E402
import timebase  # noqa: E402

RTP_HZ = timebase.RTP_HZ

UTC = datetime.timezone.utc
PERIOD = timebase.PERIOD


class Abort(Exception):
    pass


def guard_ok():
    if (REAL_DATA / recorder_guard.MARKER_NAME).exists():
        raise Abort("the real recorder lockout marker is set — not contacting the recorder")
    if recorder_guard.tripped():
        raise Abort("the recorder rejected the credentials — stopping all recorder contact")


def real_history(channel):
    """Every calibration measurement the real install has stored for `channel`, read-only."""
    p = (REAL_DATA / "playback.db").resolve()
    if not p.exists():
        return []
    c = sqlite3.connect(f"file:{p}?immutable=1", uri=True)
    c.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in c.execute(
            "SELECT a_const, measured_utc, error_estimate FROM calibration_history WHERE channel=?", (channel,))]
    finally:
        c.close()


def capture(conn, channel, path, a_const, t_req, tz, seconds, speed="1"):
    """Frames from one PlaybackReader at t_req: (list of (label, rtp_ts, is_key, au), codec, segment). The RTP
    timestamp is recovered from each frame's label and its segment's conversion (label = abs_time(a, rtp) +
    offset), so the history's answers can be compared offline."""
    reader = psess.PlaybackReader(conn, channel, path, a_const, t_req.isoformat(), tz, speed)
    frames, t0 = [], time.time()
    reader.start()
    try:
        while time.time() - t0 < seconds + 20:
            try:
                item = reader.q.get(timeout=15)
            except Exception:
                break
            if item is None:
                break
            if item[0] == "error":
                if "password" in item[1] or "rejected" in item[1]:
                    raise Abort(item[1])
                raise RuntimeError(item[1])
            frames.append(item)
            if item.t - frames[0].t >= seconds:
                break
    finally:
        reader.stop()
        reader.thread.join(timeout=8)
    if not frames:
        return [], "hevc", None
    seg = frames[0].seg
    rtp = lambda f: int(round((f.t - seg["_offset"] - seg["_a"]) * RTP_HZ)) % 2 ** 32
    return [(f.t, rtp(f), f.key, f.data) for f in frames if f.seg is seg], seg["codec"], seg


def decode_gray(blob, codec, box, scale_w):
    """Decode Annex-B `blob` scaled to `scale_w` wide, crop box=(x, y, w, h), as gray frames."""
    x, y, w, hh = box
    r = subprocess.run(["ffmpeg", "-v", "error", "-f", codec, "-i", "-",
                        "-vf", f"scale={scale_w}:-2,crop={w}:{hh}:{x}:{y},format=gray", "-f", "rawvideo", "-"],
                       input=blob, capture_output=True, timeout=60)
    fb = w * hh
    return [np.frombuffer(r.stdout[i * fb:(i + 1) * fb], np.uint8).reshape(hh, w) for i in range(len(r.stdout) // fb)]


def save_png(blob, codec, index, box, scale_w, out):
    vf = f"select=eq(n\\,{index}),scale={scale_w}:-2"
    if box:
        x, y, w, hh = box
        vf += f",crop={w}:{hh}:{x}:{y}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", codec, "-i", "-", "-vf", vf, "-frames:v", "1",
                    "-fps_mode", "passthrough", str(out)], input=blob, capture_output=True, timeout=60)


def ticks(gray):
    """Indexes i where the OSD's bright pixels changed sharply between frame i-1 and i (timebase._find_tick's
    test, but every tick rather than only the strongest)."""
    masks = [(f > 180).astype(np.int16) for f in gray]
    diffs = [int(np.abs(masks[i] - masks[i - 1]).sum()) for i in range(1, len(masks))]
    if not diffs:
        return []
    floor = sorted(diffs)[len(diffs) // 3]
    thr = max(30, floor * 4)
    return [i + 1 for i, d in enumerate(diffs) if d >= thr]


def nearest(rows, t):
    return min(rows, key=lambda r: abs(datetime.datetime.fromisoformat(r["measured_utc"]).timestamp() - t)) if rows else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channels", default="1")
    ap.add_argument("--times", default="", help="comma-separated ISO instants (UTC); default: 10 min ago")
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument("--out", required=True, help="scratch dir for PNGs/JSON (never inside the repo)")
    # The crop that held this recorder's main-stream clock ("YYYY-MM-DD Day HH:MM:SS", top left) at 1920 wide.
    ap.add_argument("--box", default="0,40,600,72", help="OSD crop x,y,w,h at --scale-w")
    ap.add_argument("--scale-w", type=int, default=1920)
    ap.add_argument("--full-frame", action="store_true")
    ap.add_argument("--speed", default="1", help="playback speed; faster is fine for --keyframes")
    ap.add_argument("--keyframes", action="store_true", help="only report keyframe spacing (no OSD work)")
    ap.add_argument("--no-calibrate", action="store_true")
    ap.add_argument("--real-history", action="store_true",
                    help="copy the real install's calibration history (a_const/time rows only) into the scratch DB, "
                         "so the reader labels frames exactly as the app would")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if ROOT in out.resolve().parents:
        raise SystemExit("--out must be outside the repository (footage must never land in it)")
    guard_ok()
    db.init()   # the scratch database: only this run's fresh calibration goes in it

    s = cfg.Settings.model_validate_json((REAL_DATA / "settings.json").read_text())
    conn = h.conn_of({"connection": s.connection.model_dump()})
    api = isapi.Isapi(s.connection.host, s.connection.username, s.connection.password, s.connection.http_port)
    tz = events.tz_local(api)
    guard_ok()
    print(f"recorder UTC offset: {tz}")
    box = tuple(int(v) for v in a.box.split(","))
    now = datetime.datetime.now(UTC).replace(microsecond=0)
    times = [psess.parse_utc(t) for t in a.times.split(",") if t] or [now - datetime.timedelta(minutes=10)]
    results = []
    for ch in [int(c) for c in a.channels.split(",")]:
        c = next(c for c in s.channels if c.channel == ch)
        hist = real_history(ch)
        if a.real_history:
            for r in hist:
                db.set_calibration(ch, r["a_const"], r["error_estimate"], "osd_tick", r["measured_utc"])
        fresh = None
        if not a.no_calibrate:
            r = timebase.calibrate_channel(conn, api, ch, h.stream_path(ch, "sub", c.sub_path))
            guard_ok()
            if "a_const" in r:
                fresh = r["a_const"]
                db.set_calibration(ch, fresh, r["error_estimate"], r["method"])
                print(f"ch{ch}: fresh a_const mod P = {fresh % PERIOD:.3f}  (err {r['error_estimate']})")
            else:
                print(f"ch{ch}: calibration failed: {r.get('error')}")
        a_use = fresh if fresh is not None else (nearest(hist, now.timestamp()) or {}).get("a_const")
        if a_use is None:
            print(f"ch{ch}: no calibration at all — skipped")
            continue
        path = h.playback_path(ch, c.playback_path)
        for t_req in times:
            guard_ok()
            frames, codec, seg = capture(conn, ch, path, a_use, t_req, tz, a.seconds, a.speed)
            if not frames:
                print(f"ch{ch} {t_req.isoformat()}: no frames")
                continue
            if a.keyframes:
                kt = [f[0] for f in frames if f[2]]
                print(f"ch{ch} {t_req.isoformat()}: {len(frames)} frames over {frames[-1][0] - frames[0][0]:.1f} s, "
                      f"keyframe spacing (s): {[round(b - x, 2) for x, b in zip(kt, kt[1:])]}")
                continue
            blob = b"".join(f[3] for f in frames)
            tag = f"ch{ch}_{t_req.strftime('%Y%m%dT%H%M%S')}"
            if a.full_frame:
                save_png(blob, codec, 0, None, a.scale_w, out / f"{tag}_full.png")
                print(f"saved {out / (tag + '_full.png')}")
                continue
            gray = decode_gray(blob, codec, box, a.scale_w)
            tk = ticks(gray)
            rtp0 = frames[0][1]
            row = {"channel": ch, "requested_utc": t_req.isoformat(), "requested_local": t_req.astimezone(tz).isoformat(),
                   "codec": codec, "frames": len(frames), "decoded": len(gray),
                   "first_is_key": frames[0][2], "keys": [i for i, f in enumerate(frames) if f[2]][:6],
                   "label_first": frames[0][0], "label_minus_T": round(frames[0][0] - t_req.timestamp(), 3),
                   "time_source": seg["time_source"], "bound_s": seg["bound_s"], "rtp0": rtp0}
            if fresh is not None:
                row["fresh_cal_time"] = timebase.abs_time(fresh, rtp0, t_req.timestamp())
            if tk:
                i = tk[0]
                row["tick_index"] = i
                row["tick_span_s"] = ((frames[i][1] - rtp0) % 2 ** 32) / RTP_HZ
                save_png(blob, codec, i, box, a.scale_w, out / f"{tag}_tick.png")
                save_png(blob, codec, 0, box, a.scale_w, out / f"{tag}_first.png")
                row["tick_png"] = str(out / f"{tag}_tick.png")
            near = nearest(hist, t_req.timestamp())
            if near:
                row["hist_nearest"] = {"measured_utc": near["measured_utc"],
                                       "time": psess._abs_time(near["a_const"], rtp0, t_req.timestamp())}
            # Every distinct regime in the history (a_const mod the wrap period, clustered to 5 s): which of
            # them puts the first frame within a plausible window of the request.
            regimes = {}
            for hr in hist:
                k = round((hr["a_const"] % PERIOD) / 5)
                regimes.setdefault(k, []).append(hr)
            row["regimes_in_window"] = []
            for k, rows in regimes.items():
                rr = nearest(rows, t_req.timestamp())
                t_at = psess._abs_time(rr["a_const"], rtp0, t_req.timestamp())
                if -60 <= t_at - t_req.timestamp() <= 60:
                    row["regimes_in_window"].append({"nearest_measured": rr["measured_utc"], "n": len(rows),
                                                     "delta_vs_T": round(t_at - t_req.timestamp(), 3)})
            results.append(row)
            print(json.dumps(row, default=str))
    (out / "results.json").write_text(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    try:
        main()
    except Abort as e:
        print(f"ABORTED: {e}")
        sys.exit(2)
