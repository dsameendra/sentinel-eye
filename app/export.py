"""Clip export (spec section 10). Every export is a stream copy of decrypted DVR footage — reuses the same
PlaybackReader used for live review, so it goes through psess.pool exactly like a playback pane (it IS one).

Frame timing: naive `ffmpeg -c copy` on this DVR's raw Annex-B stream silently guesses a wrong framerate
(measured: produced a clip at exactly half the real duration). Muxing here instead assigns each access unit
its own real PTS via PyAV (verified: frame-identical duration and frame count against the source's own
timestamps). See docs/SPEC.md section 10 and the M4 export commit for the measurement. Frames are muxed as they
arrive (IncrementalMux), so memory stays flat however long the clip — only the frames before the first keyframe
are ever held, and the stream is only created once that keyframe gives the real picture size. H.265 and H.264
recordings are both supported (the codec comes from the recorder's own SDP, per session).

The clip starts at the keyframe before the requested start (a stream copy can't start anywhere else; on this
recorder that is up to a keyframe interval — measured up to ~50 s — early), and every frame keeps the time the
reader labelled it with: the recorder's clock calibration when one can be trusted for that footage, otherwise
anchored to the request and declared approximate (playback_session / timebase.choose_label).

Package "signed evidence" (recommended, option 1): clip(s) + manifest.json (manifest_version 2: camera, codec,
picture size, the first and last frame's recorded time in UTC and DVR-local time with the recorder's UTC offset,
where those times come from and how accurate they are, the clock-calibration value used, operator, per-file
SHA-256, this app's version, the recorder's model/serial/firmware when it answers, the signing key's
fingerprint, and — when there are any — the bookmarks on those cameras inside the range) + an Ed25519 signature over manifest.json's raw bytes + the public key + an offline verify.html
(WebCrypto, no server, no bundled crypto library — works from file:// as verified directly). The signature
attests that the manifest (and therefore the clip bytes it hashes) is exactly what this install exported and
hasn't been altered since; it does NOT independently prove the DVR's footage itself is authentic — verify.html
says this explicitly, and asks the recipient to compare the key fingerprint with the one the exporting install
shows in Settings (anyone can sign with a key of their own). Version 1 packages (no manifest_version) still
verify the same way.

Package "plain": just the clip file(s), no manifest, no signature.

Several cuts at once: the Playback view's multi-cut clip list runs one export job per cut (web/js/playback.js).
Jobs run one at a time in request order (see "job tracking" below) and are listed, with their place in the
queue and progress, by list_jobs. A queued or running job can be cancelled (cancel_job): its reader is stopped
and its partial files removed.
Not implemented yet: package "original DVR file" (option 3, ISAPI native passthrough) — deferred, not stubbed.
"""
import datetime
import fractions
import hashlib
import json
import queue
import re
import shutil
import subprocess
import threading
import time
import zipfile
from pathlib import Path

import av

import coverage
import db
import hikrelay as h
import isapi
import playback_session as psess
import timebase
from settings import DATA, ROOT

EXPORT_DIR = DATA / "exports"
JOB_TTL = 2 * 3600  # exports are downloads, not an archive — swept after this long (advisor: no growing archive)
KEY_FILE = DATA / "export_signing_key.pem"
MANIFEST_VERSION = 2

_jobs = {}
_ctl = {}           # job_id -> {"cancel": Event, "reader": PlaybackReader | None}; never sent to the browser
_jobs_lock = threading.Lock()


class Cancelled(Exception):
    pass


def _sweep_old_jobs():
    """Remove exports older than JOB_TTL — the per-job folders and the zips beside them — and forget finished
    jobs whose files are gone, so _jobs can't grow for as long as the server runs."""
    cutoff = time.time() - JOB_TTL
    with _jobs_lock:
        # A long export (hours at 1x beside a busy review) writes its clip in place: never sweep a live one.
        live = {j for j, v in _jobs.items() if v.get("state") in ("queued", "running", "cancelling")}
        before = len(_jobs)
    if EXPORT_DIR.exists():
        for d in EXPORT_DIR.iterdir():
            try:
                if d.stat().st_mtime >= cutoff or (d.stem if d.suffix == ".zip" else d.name) in live:
                    continue
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)
                elif d.suffix == ".zip":
                    d.unlink(missing_ok=True)
            except OSError:
                pass
    with _jobs_lock:
        for jid in [j for j, v in _jobs.items()
                    if v.get("state") in ("done", "error", "cancelled", "interrupted") and v.get("_created", 0) < cutoff]:
            _jobs.pop(jid, None)
            _ctl.pop(jid, None)
        changed = len(_jobs) != before
    if changed:
        _save_jobs()


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


def key_fingerprint(public_key_hex_str):
    """SHA-256 of the raw 32-byte Ed25519 public key, upper-case hex in groups of four — the same thing
    verify.html computes from signature.json, so a recipient can compare it with what Settings shows."""
    digest = hashlib.sha256(bytes.fromhex(public_key_hex_str)).hexdigest().upper()
    return " ".join(digest[i:i + 4] for i in range(0, len(digest), 4))


def signing_key_info():
    pub = public_key_hex()
    return {"algorithm": "Ed25519", "public_key_hex": pub, "fingerprint": key_fingerprint(pub)}


def _sign(data: bytes) -> str:
    from Crypto.Signature import eddsa
    key = _signing_key()
    return eddsa.new(key, "rfc8032").sign(data).hex()


# ------------------------------------------------------------------ provenance (manifest v2)
_app_version = None
_recorder_info = {"value": None, "tried": 0.0}
_RECORDER_RETRY_S = 600


def app_version():
    """`git describe` of this checkout, once per process; "unknown" without git or a repository (Docker)."""
    global _app_version
    if _app_version is None:
        try:
            r = subprocess.run(["git", "-C", str(ROOT), "describe", "--always", "--dirty", "--tags"],
                               capture_output=True, text=True, timeout=3)
            _app_version = r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "unknown"
        except (OSError, subprocess.SubprocessError):
            _app_version = "unknown"
    return _app_version


def _parse_device_info(xml):
    out = {}
    for key, tag in (("model", "model"), ("serial", "serialNumber"), ("firmware", "firmwareVersion"),
                     ("firmware_date", "firmwareReleasedDate")):
        m = re.search(rf"<{tag}>([^<]*)</{tag}>", xml or "")
        if m and m.group(1).strip():
            out[key] = m.group(1).strip()
    return out


def recorder_info(connection_dict):
    """Model / serial / firmware from ISAPI deviceInfo, fetched once and cached; None when the recorder doesn't
    answer (retried at most every 10 minutes). Never raises — an export must not fail over its provenance."""
    if _recorder_info["value"] is not None:
        return _recorder_info["value"]
    if time.time() - _recorder_info["tried"] < _RECORDER_RETRY_S:
        return None
    _recorder_info["tried"] = time.time()
    try:
        c = connection_dict
        st, body = isapi.Isapi(c["host"], c["username"], c["password"], c.get("http_port", 80), timeout=6) \
            .get("/ISAPI/System/deviceInfo")
        info = _parse_device_info(body) if st == 200 else {}
        if info:
            _recorder_info["value"] = info
            return info
    except Exception:
        pass
    return None


# ------------------------------------------------------------------ job tracking
#
# Jobs run one at a time, in the order they were requested, on a single worker thread. They used to each start
# their own thread at once: several exports then competed for the recorder's four playback sessions (and its
# speed budget) and any that waited longer than the pool's timeout simply failed. Queued here instead, each one
# gets the recorder's full export speed in turn, a batch keeps going after the browser tab that started it is
# closed, and the queue can be shown to the operator (list_jobs) with an honest position.
#
# The job list is also written to exports/jobs.json, so finished exports are still listed (and downloadable,
# until JOB_TTL sweeps them) after a restart. A job that was queued or running when the server stopped can't be
# resumed — its recorder session and partial clip are gone — so it comes back as "interrupted".
ACTIVE = ("queued", "running", "cancelling")
_PUBLIC = ("state", "progress", "percent", "error", "download", "package", "cameras", "start_utc", "end_utc",
           "operator", "created_utc", "started_utc", "finished_utc", "size_bytes", "expires_utc")
_queue = queue.Queue()
_worker = None


def _jobs_file():
    return EXPORT_DIR / "jobs.json"   # read at call time: tests point EXPORT_DIR at a scratch dir


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _public(job_id, j):
    d = {k: j.get(k) for k in _PUBLIC}
    d["id"] = job_id
    return d


def get_job(job_id):
    with _jobs_lock:
        j = _jobs.get(job_id)
        return _public(job_id, j) if j is not None else None


MAX_ACTIVE_JOBS = 50   # waiting + running: far beyond any real batch, and a bound on what one click-loop can queue


def active_count():
    with _jobs_lock:
        return sum(1 for j in _jobs.values() if j.get("state") in ACTIVE)


def list_jobs():
    """Every export this install still knows about, newest first; queued ones carry their place in the queue
    (1 = next). What the Exports panel shows."""
    with _jobs_lock:
        jobs = sorted(_jobs.items(), key=lambda kv: kv[1].get("_created", 0))
        waiting = [jid for jid, j in jobs if j.get("state") == "queued"]
        out = []
        for jid, j in jobs:
            d = _public(jid, j)
            d["position"] = waiting.index(jid) + 1 if jid in waiting else None
            out.append(d)
    return out[::-1]


def _save_jobs():
    """Persist the job list (atomically; best effort — the list is a convenience, never the evidence)."""
    with _jobs_lock:
        data = {jid: {**{k: j.get(k) for k in _PUBLIC}, "_created": j.get("_created", 0)} for jid, j in _jobs.items()}
    try:
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _jobs_file().with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(_jobs_file())
    except OSError:
        pass


def load_jobs():
    """Once at start-up: bring back the saved job list. Finished exports whose file is still there stay
    downloadable; anything that was still queued or running is marked interrupted and its partial files removed."""
    try:
        data = json.loads(_jobs_file().read_text())
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    with _jobs_lock:
        for jid, j in data.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(jid)) or not isinstance(j, dict) or jid in _jobs:
                continue
            if j.get("state") in ACTIVE:
                j.update(state="interrupted", progress="", percent=None, download=None, finished_utc=_now_iso(),
                         error="The server restarted before this export finished — export it again")
                _remove_job_files(jid)
            elif j.get("state") == "done" and not (j.get("download") and (EXPORT_DIR / j["download"]).exists()):
                continue   # its file was swept or removed: nothing left to offer
            _jobs[jid] = j
    _save_jobs()


def _ensure_worker():
    global _worker
    with _jobs_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, daemon=True)
            _worker.start()


def _work():
    while True:
        args = _queue.get()
        try:
            _run_export(*args)
        finally:
            _save_jobs()


def start_export(job_id, channels, start_utc, end_utc, package, operator, connection_dict):
    """channels: list of {id, channel, name} (our config's channel dicts). Queued; the worker runs it in turn."""
    _sweep_old_jobs()
    now = time.time()
    with _jobs_lock:
        _jobs[job_id] = {"state": "queued", "progress": "", "percent": None, "error": None, "download": None,
                         "package": package, "operator": operator, "start_utc": start_utc, "end_utc": end_utc,
                         "cameras": [c.get("name") or f"Channel {c['channel']}" for c in channels],
                         "created_utc": _now_iso(), "started_utc": None, "finished_utc": None, "size_bytes": None,
                         "expires_utc": None, "_created": now}
        _ctl[job_id] = {"cancel": threading.Event(), "reader": None}
    _save_jobs()
    _queue.put((job_id, channels, start_utc, end_utc, package, operator, connection_dict))
    _ensure_worker()


def cancel_job(job_id):
    """Cancel a queued or running export. A queued one is cancelled on the spot (the worker skips it when its
    turn comes); a running one has its reader stopped (releasing its recorder session) and the worker removes
    the partial files. Returns the job's state afterwards, or None for an unknown job."""
    with _jobs_lock:
        j, c = _jobs.get(job_id), _ctl.get(job_id)
        if j is None:
            return None
        if j["state"] not in ("queued", "running") or c is None:
            return j["state"]
        c["cancel"].set()
        if j["state"] == "queued":
            j.update(state="cancelled", progress="cancelled", finished_utc=_now_iso())
            reader = None
        else:
            j["state"] = "cancelling"
            reader = c["reader"]
        state = j["state"]   # as of this call: the worker may finish cancelling before we return
    if reader is not None:
        reader.stop()
    _save_jobs()
    return state


def _set(job_id, **kw):
    with _jobs_lock:
        _jobs[job_id].update(kw)


def _check_cancel(job_id):
    c = _ctl.get(job_id)
    if c is not None and c["cancel"].is_set():
        raise Cancelled()


def _run_export(job_id, channels, start_utc, end_utc, package, operator, connection_dict):
    job_dir = EXPORT_DIR / job_id
    with _jobs_lock:
        if job_id not in _jobs or _jobs[job_id]["state"] != "queued":
            return   # cancelled while it waited (or swept): never contact the recorder for it
        _jobs[job_id].update(state="running", progress=f"0/{len(channels)} cameras", percent=0,
                             started_utc=_now_iso())
    _save_jobs()
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        _check_cancel(job_id)
        clips = []
        for i, ch in enumerate(channels):
            _check_cancel(job_id)
            _set(job_id, progress=f"{i}/{len(channels)} cameras — exporting {ch.get('name') or 'channel ' + str(ch['channel'])}")
            # Share of the whole job done so far: finished cameras plus how far through this one's range the
            # frames have got (the last few percent are left for packaging).
            on_progress = lambda frac, i=i: _set(job_id, percent=min(97, int(97 * (i + frac) / len(channels))))
            clip = _export_one_channel(job_dir, ch, start_utc, end_utc, connection_dict, job_id, on_progress)
            clips.append(clip)
        _check_cancel(job_id)
        _set(job_id, progress=f"{len(channels)}/{len(channels)} cameras — packaging", percent=98)

        if package == "signed":
            out_path = _package_signed(job_dir, job_id, clips, operator, start_utc, end_utc, connection_dict,
                                       bookmarks=bookmarks_for_manifest(channels, start_utc, end_utc))
        else:
            out_path = _package_plain(job_dir, job_id, clips)
        size = out_path.stat().st_size
        expires = datetime.datetime.fromtimestamp(time.time() + JOB_TTL, datetime.timezone.utc).isoformat()
        with _jobs_lock:   # atomically with the cancel flag: a cancel that lands now still wins
            if _ctl.get(job_id, {}).get("cancel") is not None and _ctl[job_id]["cancel"].is_set():
                raise Cancelled()
            _jobs[job_id].update(state="done", progress="done", percent=100, size_bytes=size, expires_utc=expires,
                                 finished_utc=_now_iso(), download=str(out_path.relative_to(EXPORT_DIR)))
    except Cancelled:
        _remove_job_files(job_id)
        _set(job_id, state="cancelled", progress="cancelled", percent=None, finished_utc=_now_iso())
    except Exception as e:
        _remove_job_files(job_id)
        _set(job_id, state="error", error=f"{type(e).__name__}: {e}", percent=None, finished_utc=_now_iso())
    finally:
        with _jobs_lock:
            if job_id in _ctl:
                _ctl[job_id]["reader"] = None


def _remove_job_files(job_id):
    """Partial or abandoned output never lingers until the sweep (a cut-off clip must not be downloadable)."""
    shutil.rmtree(EXPORT_DIR / job_id, ignore_errors=True)
    (EXPORT_DIR / f"{job_id}.zip").unlink(missing_ok=True)


# ------------------------------------------------------------------ capture + incremental mux
def _probe_dimensions(sample_au, codec="hevc"):
    """PyAV's MP4 muxer writes the container's own hvcC/avcC/stsd box from the stream's declared width/height —
    it does NOT infer them from the packet bytes. Leaving those at their unset default silently produced a
    640x480 container box around a genuinely-1920x1080 bitstream (caught by comparing an exported clip
    against a live probe of the same channel, not assumed). Get the real dimensions the same proven way
    hikrelay.probe() does: let ffprobe parse the actual SPS (raw Annex-B, so the format must be named)."""
    import tempfile
    fmt = "h264" if codec == "h264" else "hevc"
    with tempfile.NamedTemporaryFile(suffix="." + fmt, delete=False) as f:
        f.write(sample_au)
        tmp = f.name
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-f", fmt, "-i", tmp,
                            "-show_entries", "stream=width,height", "-of", "json"],
                           capture_output=True, text=True, timeout=10)
        info = (json.loads(r.stdout or "{}").get("streams") or [{}])[0]
        return info.get("width"), info.get("height")
    except Exception:
        return None, None
    finally:
        Path(tmp).unlink(missing_ok=True)


class IncrementalMux:
    """Writes access units into an MP4 as they arrive — stream copy, one packet per access unit, each with its
    own real PTS (microseconds since the first frame). Nothing is buffered beyond the frames before the first
    keyframe, which can't be decoded and are dropped (StartGate makes the first frame a keyframe in practice)."""

    def __init__(self, path, codec):
        self.path, self.codec = Path(path), codec
        self.output = self.stream = None
        self.first_t = self.last_t = None
        self.count = 0
        self.width = self.height = None
        self._last_pts = -1
        self._tb = fractions.Fraction(1, 1_000_000)

    def _open(self, key_au):
        self.width, self.height = _probe_dimensions(key_au, self.codec)
        self.output = av.open(str(self.path), mode="w", format="mp4")
        # A mux-only stream: no encoder is opened for a stream copy (add_stream opened a real libx265/libx264
        # encoder, threads and all, for every export, and needs that encoder to exist in PyAV's build at all).
        # The MP4 muxer builds hvcC/avcC from the first keyframe's in-band parameter sets (verified with ffprobe
        # and a clean ffmpeg decode, tools/test_export.py); the size must still be given explicitly.
        self.stream = self.output.add_mux_stream("h264" if self.codec == "h264" else "hevc", rate=90000,
                                                 width=self.width or 0, height=self.height or 0)
        self.stream.time_base = self._tb

    def add(self, t, is_key, au):
        if self.output is None:
            if not is_key:
                return
            self._open(au)
            self.first_t = t
        pts = int(round((t - self.first_t) * 1_000_000))
        if pts <= self._last_pts:
            pts = self._last_pts + 1   # never equal/backwards: the muxer rejects non-increasing DTS
        self._last_pts = pts
        pkt = av.Packet(au)
        pkt.pts = pkt.dts = pts
        pkt.time_base = self._tb
        pkt.stream = self.stream
        if is_key:
            pkt.is_keyframe = True
        self.output.mux(pkt)
        self.last_t = t
        self.count += 1

    def close(self):
        if self.output is not None:
            self.output.close()
            self.output = None


def _sha256_file(path, chunk=1 << 20):
    d = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            d.update(b)
    return d.hexdigest()


def export_deadline_s(span_s, speed):
    """Generous capture deadline: the span plus the keyframe pre-roll before it, at the granted speed, x3, plus
    a minute for connecting/queueing/the near-live backoff. web/js/playback.js and eventPreview.js mirror it."""
    return max(60.0, (span_s + timebase.PREROLL_MAX_S) / psess.units(speed) * 3 + 60)


def _distance(seconds):
    if seconds < 3600:
        return "under an hour"
    if seconds < 2 * 86400:
        return f"{seconds / 3600:.0f} hours"
    return f"{seconds / 86400:.1f} days"


def _time_accuracy(seg, preroll_s):
    if seg["time_source"] == "calibration":
        lead = (f" The clip begins at the keyframe {preroll_s:.1f} s before the requested start, because a stream "
                "copy can only start on a keyframe.") if preroll_s > 0.05 else ""
        near = ""
        m = (seg.get("_cal") or {}).get("measured_utc")
        if m is not None:
            near = f" (the nearest measurement is {_distance(abs(seg['first_utc'] - timebase._epoch(m)))} from this footage)"
        return ("Frame times come from a clock calibration — the recorder's stream clock measured against its "
                "on-screen clock — taken within the same recorder clock period as this footage" + near +
                f", and are accurate to about ±{seg['bound_s']:g} s." + lead)
    return ("Approximate. No clock calibration covers the time this footage was recorded, so its first frame is "
            "labelled with the requested start time. The recorder actually starts at the keyframe before that "
            "instant, so the true recorded times are earlier than labelled by up to one keyframe interval "
            "(measured on this recorder: up to about 50 s). The recorder's on-screen clock in the picture is "
            "the reference.")


def _export_one_channel(job_dir, ch, start_utc, end_utc, connection_dict, job_id=None, on_progress=None):
    conn = h.conn_of({"connection": connection_dict})
    # The recording-track override, never the live main_path one: a live path here would silently export live
    # video instead of the requested range (see hikrelay.playback_path).
    path = h.playback_path(ch["channel"], ch.get("playback_path", ""))
    a_const = psess.calibration_for_time(ch["channel"], start_utc)
    if a_const is None:
        raise RuntimeError(f"Channel {ch['channel']} has no clock calibration yet — try again shortly")
    # The recorder's own UTC offset is required: guessing one (this used to default to India's +05:30) exports
    # the wrong hours of footage, signed, on any recorder anywhere else.
    tz_offset = ch.get("_tz_offset_min")
    if tz_offset is None:
        raise RuntimeError("The recorder's clock isn't known yet — try again shortly")
    tz = datetime.timezone(datetime.timedelta(minutes=tz_offset))

    start_dt = datetime.datetime.fromisoformat(start_utc)
    end_dt = datetime.datetime.fromisoformat(end_utc)
    span = (end_dt - start_dt).total_seconds()
    # Export at the DVR's fast-playback speed rather than 1x — measured directly (not assumed): at
    # scale=16 the DVR still delivers every frame (fps stayed ~15.0 constant across 1x/4x/8x/16x, not
    # dropped to keyframes-only the way many DVRs' visual fast-forward does), just compressed into 1/16th
    # the wall-clock time. This is the same scale value already relied on for playback's fast-scrub speed.
    EXPORT_SCALE = "16"
    # Fastest the recorder's speed budget allows right now: 16x when nothing else is playing, slower (not
    # refused) while someone is reviewing — see playback_session.SPEED_BUDGET.
    reader = psess.PlaybackReader(conn, ch["channel"], path, a_const, start_utc, tz, EXPORT_SCALE, adaptive_speeds=("16", "8", "4", "2", "1"))
    if job_id is not None:
        with _jobs_lock:
            if job_id in _ctl:
                _ctl[job_id]["reader"] = reader
        _check_cancel(job_id)   # cancelled between cameras: don't even queue for a session
    reader.start()

    safe_name = "".join(cc if cc.isalnum() or cc in "-_" else "_" for cc in (ch.get("name") or f"ch{ch['channel']}"))
    out_file = job_dir / f"clip_{safe_name}.mp4"
    mux = None
    seg = None
    ok = False
    try:
        # Deadline generously covers: capture time at EXPORT_SCALE, queueing behind the DVR's 4-session
        # pool, the keyframe pre-roll and the near-live-edge retry backoff — scaled to the requested span, with
        # a floor so short clips still get real time to connect. A flat deadline here silently truncated any
        # export past it (found by an outside review, not by testing: every export tried so far was short
        # enough to miss it) — never let this regress to a constant.
        deadline = time.time() + export_deadline_s(span, EXPORT_SCALE)
        rescaled = False
        while time.time() < deadline:
            try:
                item = reader.q.get(timeout=30)
            except queue.Empty:
                raise RuntimeError("The recorder stopped sending video")
            if job_id is not None:
                _check_cancel(job_id)
            if item is None:
                break
            if not rescaled and not reader.waiting_for_slot:
                # The speed actually granted (adaptive — maybe slower than 16x): size the deadline to it.
                deadline = time.time() + export_deadline_s(span, reader.speed)
                rescaled = True
            if item[0] == "error":
                raise RuntimeError(item[1])
            if not psess.is_frame(item):
                # A note about the feed (auto-paused while this loop was slow to read, then resumed): it carried
                # on from the next frame, nothing was lost. Reading it as a frame failed the whole export.
                continue
            if seg is None:
                seg = item.seg
                if seg["time_source"] == "anchor" and coverage.not_recorded(ch["channel"], start_dt, tz):
                    # The recorder serves the next footage it has (days later, before its oldest recording) and
                    # nothing here can tell how much later — never sign that as the requested time.
                    raise RuntimeError(f"There is no recording at {start_dt.astimezone(tz):%Y-%m-%d %H:%M:%S} "
                                       f"on {ch.get('name') or 'channel ' + str(ch['channel'])}")
            elif item.seg is not seg:
                raise RuntimeError("The recorder restarted the stream mid-export — try again")
            if item.t > end_dt.timestamp():
                break
            if mux is None:
                mux = IncrementalMux(out_file, seg["codec"])
            mux.add(item.t, item.key, item.data)
            if on_progress is not None and mux.count % 30 == 0 and span > 0:
                on_progress(min(1.0, max(0.0, (item.t - start_dt.timestamp()) / span)))
        if job_id is not None:
            _check_cancel(job_id)
        if mux is None or mux.count == 0:
            raise RuntimeError(f"No footage decoded for channel {ch['channel']} in that range")
        # A truncated capture (deadline hit, DVR disconnect, etc.) must never get signed as if it were
        # complete — a partial "evidence package" that looks whole is worse than an outright failure.
        if mux.last_t < end_dt.timestamp() - 2.0:
            got_until = datetime.datetime.fromtimestamp(mux.last_t, datetime.timezone.utc).isoformat()
            raise RuntimeError(f"Export stopped early — only got footage through {got_until}, requested until {end_utc}")
        mux.close()
        ok = True
    finally:
        reader.stop()
        if mux is not None:
            try:
                mux.close()
            except Exception:
                pass
        if not ok:
            out_file.unlink(missing_ok=True)

    first_abs, last_abs = mux.first_t, mux.last_t
    to_utc = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc)
    preroll = max(0.0, start_dt.timestamp() - first_abs)
    cal = seg.get("_cal") or {}
    return {
        "channel": ch["channel"], "camera_name": ch.get("name") or f"Channel {ch['channel']}",
        "file": out_file.name, "sha256": _sha256_file(out_file), "frame_count": mux.count,
        "duration_s": round(last_abs - first_abs, 3),
        "codec": "H.264" if seg["codec"] == "h264" else "H.265",
        "width": mux.width, "height": mux.height,
        # The first and last frame actually in the file (the first is the keyframe before the requested start).
        "dvr_time_range_utc": {"start": to_utc(first_abs).isoformat(), "end": to_utc(last_abs).isoformat()},
        "dvr_time_range_local": {"start": to_utc(first_abs).astimezone(tz).isoformat(),
                                 "end": to_utc(last_abs).astimezone(tz).isoformat()},
        "utc_offset_minutes": tz_offset,
        "preroll_s": round(preroll, 3),
        "time_source": seg["time_source"],
        "time_bound_s": seg["bound_s"],
        "time_accuracy": _time_accuracy(seg, preroll),
        "calibration": {"a_const": cal.get("a_const"), "measured_utc": cal.get("measured_utc"),
                        "method": cal.get("method"), "error_estimate": cal.get("error_estimate")},
    }


VERIFY_HTML = (Path(__file__).parent / "export_assets" / "verify.html")


def bookmarks_for_manifest(channels, start_utc, end_utc):
    """The bookmarks on these cameras (channel dicts, as passed to start_export) inside the exported range, for
    the signed manifest — what the operators noted about this footage, attested with it. Additive to manifest
    v2: a package without bookmarks simply has no "bookmarks" key."""
    names = {c["channel"]: c.get("name") or f"Camera {c['channel']}" for c in channels}
    offset = channels[0].get("_tz_offset_min") if channels else None
    out = []
    for b in db.bookmarks_in_range(list(names), start_utc, end_utc):
        t = datetime.datetime.fromisoformat(b["time_utc"])
        item = {"id": b["id"], "time_utc": b["time_utc"], "cameras": [names[c] for c in b["channels"] if c in names],
                "title": b["title"] or "", "severity": b["severity"] or "info", "note": b["note"] or "",
                "author": b["author"] or "", "created_utc": b["created_utc"]}
        if offset is not None:
            local = t.astimezone(datetime.timezone(datetime.timedelta(minutes=offset)))
            item["time_local"] = local.isoformat(timespec="milliseconds")
        if b.get("edited_utc"):
            item["edited_by"], item["edited_utc"] = b.get("edited_by") or "", b["edited_utc"]
        out.append(item)
    return out


def _package_signed(job_dir, job_id, clips, operator, start_utc, end_utc, connection_dict=None, bookmarks=None):
    key = signing_key_info()
    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "export_id": job_id,
        "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "operator": operator,
        "requested_range_utc": {"start": start_utc, "end": end_utc},
        "clips": clips,
        "app": {"name": "Sentinel Eye", "version": app_version()},
        "signing_key_fingerprint": key["fingerprint"],
        "note": "The signature attests this manifest (and the clip bytes it hashes) was produced by this "
                "Sentinel Eye install and is unaltered since export. It does not, by itself, independently "
                "prove the DVR's footage was authentic — see verify.html.",
    }
    rec = recorder_info(connection_dict) if connection_dict else None
    if rec:
        manifest["recorder"] = rec
    if bookmarks:
        manifest["bookmarks"] = bookmarks
    manifest_path = job_dir / "manifest.json"
    manifest_path.write_bytes(json.dumps(manifest, indent=2, sort_keys=True).encode())

    sig = {
        "algorithm": "Ed25519",
        "signature_hex": _sign(manifest_path.read_bytes()),
        "public_key_hex": key["public_key_hex"],
        "signed_file": "manifest.json",
    }
    (job_dir / "signature.json").write_bytes(json.dumps(sig, indent=2).encode())
    if VERIFY_HTML.exists():
        shutil.copy(VERIFY_HTML, job_dir / "verify.html")

    zip_path = EXPORT_DIR / f"{job_id}.zip"
    _zip(zip_path, [(f, f.name) for f in sorted(job_dir.iterdir())])
    return zip_path


def _zip(zip_path, entries):
    """Video is already compressed: storing it (ZIP_STORED) is as small and far faster than deflating gigabytes;
    the small text files are still deflated."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for src, name in entries:
            z.write(src, name, compress_type=zipfile.ZIP_STORED if name.lower().endswith(".mp4") else zipfile.ZIP_DEFLATED)


def _package_plain(job_dir, job_id, clips):
    if len(clips) == 1:
        return job_dir / clips[0]["file"]
    zip_path = EXPORT_DIR / f"{job_id}.zip"
    _zip(zip_path, [(job_dir / c["file"], c["file"]) for c in clips])
    return zip_path
