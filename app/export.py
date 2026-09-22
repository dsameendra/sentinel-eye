"""Clip export (spec section 10). Every export is a stream copy of decrypted DVR footage — reuses the same
PlaybackReader used for live review, so it goes through psess.pool exactly like a playback pane (it IS one).

Frame timing: naive `ffmpeg -c copy` on this DVR's raw Annex-B stream silently guesses a wrong framerate
(measured: produced a clip at exactly half the real duration). Muxing here instead assigns each access unit
its own real PTS via PyAV (verified: frame-identical duration and frame count against the source's own
timestamps). See docs/playback-spec.md section 10 and the M4 export commit for the measurement.

Package "signed evidence" (recommended, option 1): clip(s) + manifest.json (camera, exact DVR time range in
both UTC and DVR-local, the clock-calibration value used, operator, per-file SHA-256) + an Ed25519 signature
over manifest.json's raw bytes + the public key + an offline verify.html (WebCrypto, no server, no bundled
crypto library — works from file:// as verified directly). The signature attests that the manifest (and
therefore the clip bytes it hashes) is exactly what this install exported and hasn't been altered since;
it does NOT independently prove the DVR's footage itself is authentic — verify.html says this explicitly.

Package "plain": just the clip file(s), no manifest, no signature.

Not implemented yet: package "original DVR file" (option 3, ISAPI native passthrough) and the multi-cut
batch clipper UI — both deferred, not stubbed.
"""
import datetime
import fractions
import hashlib
import json
import shutil
import threading
import time
import zipfile
from pathlib import Path

import av

import db
import hikrelay as h
import playback_session as psess
from settings import DATA

EXPORT_DIR = DATA / "exports"
JOB_TTL = 2 * 3600  # exports are downloads, not an archive — swept after this long (advisor: no growing archive)
KEY_FILE = DATA / "export_signing_key.pem"

_jobs = {}
_jobs_lock = threading.Lock()


def _sweep_old_jobs():
    if not EXPORT_DIR.exists():
        return
    cutoff = time.time() - JOB_TTL
    for d in EXPORT_DIR.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ------------------------------------------------------------------ signing key
def _signing_key():
    from Crypto.PublicKey import ECC
    DATA.mkdir(exist_ok=True)
    if KEY_FILE.exists():
        return ECC.import_key(KEY_FILE.read_text())
    key = ECC.generate(curve="Ed25519")
    KEY_FILE.write_text(key.export_key(format="PEM"))
    try:
        KEY_FILE.chmod(0o600)
    except OSError:
        pass
    return key


def public_key_hex():
    return _signing_key().public_key().export_key(format="raw").hex()


def _sign(data: bytes) -> str:
    from Crypto.Signature import eddsa
    key = _signing_key()
    return eddsa.new(key, "rfc8032").sign(data).hex()


# ------------------------------------------------------------------ job tracking
def get_job(job_id):
    with _jobs_lock:
        return dict(_jobs.get(job_id, {})) if job_id in _jobs else None


def start_export(job_id, channels, start_utc, end_utc, package, operator, connection_dict):
    """channels: list of {id, channel, name} (our config's channel dicts). Runs in a background thread."""
    _sweep_old_jobs()
    with _jobs_lock:
        _jobs[job_id] = {"state": "queued", "progress": "", "error": None, "download": None, "package": package}
    t = threading.Thread(target=_run_export, args=(job_id, channels, start_utc, end_utc, package, operator, connection_dict), daemon=True)
    t.start()


def _set(job_id, **kw):
    with _jobs_lock:
        _jobs[job_id].update(kw)


def _run_export(job_id, channels, start_utc, end_utc, package, operator, connection_dict):
    job_dir = EXPORT_DIR / job_id
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        _set(job_id, state="running", progress=f"0/{len(channels)} cameras")
        clips = []
        for i, ch in enumerate(channels):
            _set(job_id, progress=f"{i}/{len(channels)} cameras — exporting {ch.get('name') or 'channel ' + str(ch['channel'])}")
            clip = _export_one_channel(job_dir, ch, start_utc, end_utc, connection_dict)
            clips.append(clip)
        _set(job_id, progress=f"{len(channels)}/{len(channels)} cameras — packaging")

        if package == "signed":
            out_path = _package_signed(job_dir, job_id, clips, operator, start_utc, end_utc)
        else:
            out_path = _package_plain(job_dir, job_id, clips)

        _set(job_id, state="done", progress="done", download=str(out_path.relative_to(EXPORT_DIR)))
    except Exception as e:
        _set(job_id, state="error", error=f"{type(e).__name__}: {e}")


def _export_one_channel(job_dir, ch, start_utc, end_utc, connection_dict):
    conn = h.conn_of({"connection": connection_dict})
    path = h.playback_path(ch["channel"], ch.get("main_path", ""))
    a_const = psess.calibration_for(ch["channel"])
    cal = db.get_calibration(ch["channel"]) or {}
    if a_const is None:
        raise RuntimeError(f"Channel {ch['channel']} has no clock calibration yet — try again shortly")
    tz_offset = ch.get("_tz_offset_min", 330)
    tz = datetime.timezone(datetime.timedelta(minutes=tz_offset))

    start_dt = datetime.datetime.fromisoformat(start_utc)
    end_dt = datetime.datetime.fromisoformat(end_utc)
    span = (end_dt - start_dt).total_seconds()
    # Export at the DVR's fast-playback speed rather than 1x — measured directly (not assumed): at
    # scale=16 the DVR still delivers every frame (fps stayed ~15.0 constant across 1x/4x/8x/16x, not
    # dropped to keyframes-only the way many DVRs' visual fast-forward does), just compressed into 1/16th
    # the wall-clock time. This is the same scale value already relied on for playback's fast-scrub speed.
    EXPORT_SCALE = "16"
    reader = psess.PlaybackReader(conn, ch["channel"], path, a_const, start_utc, tz, EXPORT_SCALE)
    reader.start()

    items = []
    try:
        # Deadline generously covers: capture time at EXPORT_SCALE, queueing behind the DVR's 4-session
        # pool, and the near-live-edge retry backoff — scaled to the requested span, with a floor so short
        # clips still get real time to connect. A flat deadline here silently truncated any export past it
        # (found by an outside review, not by testing: every export tried so far was short enough to miss
        # it) — never let this regress to a constant.
        deadline = time.time() + max(60.0, span / int(EXPORT_SCALE) * 3 + 60)
        while time.time() < deadline:
            item = reader.q.get(timeout=15)
            if item is None:
                break
            if item[0] == "error":
                raise RuntimeError(item[1])
            abs_t = item[0]
            if datetime.datetime.fromtimestamp(abs_t, datetime.timezone.utc) > end_dt:
                break
            items.append(item)
    finally:
        reader.stop()

    if not items:
        raise RuntimeError(f"No footage decoded for channel {ch['channel']} in that range")
    # A truncated capture (deadline hit, DVR disconnect, etc.) must never get signed as if it were
    # complete — a partial "evidence package" that looks whole is worse than an outright failure.
    if items[-1][0] < end_dt.timestamp() - 2.0:
        got_until = datetime.datetime.fromtimestamp(items[-1][0], datetime.timezone.utc).isoformat()
        raise RuntimeError(f"Export stopped early — only got footage through {got_until}, requested until {end_utc}")

    safe_name = "".join(cc if cc.isalnum() or cc in "-_" else "_" for cc in (ch.get("name") or f"ch{ch['channel']}"))
    out_file = job_dir / f"clip_{safe_name}.mp4"
    first_abs, last_abs = items[0][0], items[-1][0]
    _mux(out_file, items, first_abs)

    sha256 = hashlib.sha256(out_file.read_bytes()).hexdigest()
    return {
        "channel": ch["channel"], "camera_name": ch.get("name") or f"Channel {ch['channel']}",
        "file": out_file.name, "sha256": sha256, "frame_count": len(items),
        "duration_s": round(last_abs - first_abs, 3),
        "dvr_time_range_utc": {
            "start": datetime.datetime.fromtimestamp(first_abs, datetime.timezone.utc).isoformat(),
            "end": datetime.datetime.fromtimestamp(last_abs, datetime.timezone.utc).isoformat(),
        },
        "calibration": {"a_const": cal.get("a_const"), "method": cal.get("method"), "error_estimate": cal.get("error_estimate")},
    }


def _probe_dimensions(sample_nal):
    """PyAV's MP4 muxer writes the container's own hvcC/stsd box from stream.codec_context.width/height —
    it does NOT infer them from the packet bytes. Leaving those at their unset default silently produced a
    640x480 container box around a genuinely-1920x1080 bitstream (caught by comparing an exported clip
    against a live probe of the same channel, not assumed). Get the real dimensions the same proven way
    hikrelay.probe() does: let ffprobe parse the actual SPS."""
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".hevc", delete=False) as f:
        f.write(sample_nal)
        tmp = f.name
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-f", "hevc", "-i", tmp,
                             "-show_entries", "stream=width,height", "-of", "json"],
                            capture_output=True, text=True, timeout=10)
        info = json.loads(r.stdout or "{}").get("streams", [{}])[0]
        return info.get("width"), info.get("height")
    except Exception:
        return None, None
    finally:
        Path(tmp).unlink(missing_ok=True)


def _mux(out_path, items, first_abs):
    """One packet per access unit, explicit real PTS (microseconds since clip start) — see module docstring."""
    key_sample = next((nal for _, is_key, nal in items if is_key), items[0][2])
    width, height = _probe_dimensions(key_sample)

    output = av.open(str(out_path), mode="w")
    tb = fractions.Fraction(1, 1_000_000)
    stream = output.add_stream("hevc", rate=90000)
    stream.time_base = tb
    stream.codec_context.pix_fmt = "yuv420p"
    if width and height:
        stream.codec_context.width = width
        stream.codec_context.height = height
    try:
        for abs_t, is_key, nal in items:
            pkt = av.Packet(nal)
            pts = int(round((abs_t - first_abs) * 1_000_000))
            pkt.pts = pts
            pkt.dts = pts
            pkt.time_base = tb
            pkt.stream = stream
            if is_key:
                pkt.is_keyframe = True
            output.mux(pkt)
    finally:
        output.close()


VERIFY_HTML = (Path(__file__).parent / "export_assets" / "verify.html")


def _package_signed(job_dir, job_id, clips, operator, start_utc, end_utc):
    manifest = {
        "export_id": job_id,
        "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "operator": operator,
        "requested_range_utc": {"start": start_utc, "end": end_utc},
        "clips": clips,
        "note": "The signature attests this manifest (and the clip bytes it hashes) was produced by this "
                "Sentinel Eye install and is unaltered since export. It does not, by itself, independently "
                "prove the DVR's footage was authentic — see verify.html.",
    }
    manifest_path = job_dir / "manifest.json"
    manifest_path.write_bytes(json.dumps(manifest, indent=2, sort_keys=True).encode())

    sig = {
        "algorithm": "Ed25519",
        "signature_hex": _sign(manifest_path.read_bytes()),
        "public_key_hex": public_key_hex(),
        "signed_file": "manifest.json",
    }
    (job_dir / "signature.json").write_bytes(json.dumps(sig, indent=2).encode())
    if VERIFY_HTML.exists():
        shutil.copy(VERIFY_HTML, job_dir / "verify.html")

    zip_path = EXPORT_DIR / f"{job_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in job_dir.iterdir():
            z.write(f, f.name)
    return zip_path


def _package_plain(job_dir, job_id, clips):
    if len(clips) == 1:
        return job_dir / clips[0]["file"]
    zip_path = EXPORT_DIR / f"{job_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for c in clips:
            z.write(job_dir / c["file"], c["file"])
    return zip_path
