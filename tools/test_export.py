"""Checks for app/export.py without a recorder: synthetic H.264 and H.265 clips (ffmpeg testsrc2, Annex-B, split
into access units by the same playback_session.AccessUnits the reader uses) muxed incrementally and verified with
ffprobe/ffmpeg (codec, size, frame count, duration, a clean decode); a whole export through a stand-in reader —
pre-roll kept and declared, truncated captures refused and removed, cancel releasing the reader and removing
partial files; the signed package (manifest v2 fields, signature, key fingerprint, video stored uncompressed);
provenance lookups that never fail an export; and the job sweep pruning finished jobs.

   .venv/bin/python3 tools/test_export.py

Prints SKIP (and still exits 0) for a codec this ffmpeg can't encode.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-export-")
sys.path.insert(0, "app")
import db  # noqa: E402
import export  # noqa: E402
import playback_session as psess  # noqa: E402

PASS = []
UTC = datetime.timezone.utc
FPS = 15
SCRATCH = Path(tempfile.mkdtemp(prefix="se-export-clips-"))


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def skip(name, why):
    print(f"SKIP {name}  [{why}]")


ENCODERS = {"h264": ["-c:v", "libx264", "-bf", "0", "-g", "30", "-pix_fmt", "yuv420p"],
            "hevc": ["-c:v", "libx265", "-x265-params", "log-level=none:bframes=0:keyint=30", "-pix_fmt", "yuv420p"]}


def synthetic_aus(codec, seconds=4, size="320x240"):
    """Access units of a synthetic Annex-B clip, or None when this ffmpeg can't encode `codec`."""
    out = SCRATCH / f"src.{codec}"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={FPS}",
                        "-t", str(seconds), *ENCODERS[codec], "-f", codec, str(out)], capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        return None
    data = out.read_bytes()
    au = psess.AccessUnits(codec)
    units = []
    for nal in re.split(b"\x00\x00\x00\x01|\x00\x00\x01", data):
        if nal:
            got = au.feed(nal)
            if got:
                units.append(got)
    return units


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                        "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    s = (j.get("streams") or [{}])[0]
    return s, float((j.get("format") or {}).get("duration") or 0)


def mux_codec(codec):
    units = synthetic_aus(codec)
    if units is None:
        skip(f"{codec}: incremental mux", f"this ffmpeg has no {ENCODERS[codec][1]} encoder")
        return
    check(f"{codec}: synthetic clip split into access units", len(units) == 4 * FPS and units[0][0], len(units))
    out = SCRATCH / f"out_{codec}.mp4"
    m = export.IncrementalMux(out, codec)
    t0 = 1_792_000_000.0
    # A frame before the first keyframe can't be decoded: dropped, not buffered.
    m.add(t0 - 1, False, units[1][1])
    for i, (key, data) in enumerate(units):
        m.add(t0 + i / FPS, key, data)
    m.close()
    s, dur = probe(out)
    name = {"h264": "h264", "hevc": "hevc"}[codec]
    check(f"{codec}: codec in the container", s.get("codec_name") == name, s)
    check(f"{codec}: real picture size from the first keyframe", (s.get("width"), s.get("height")) == (320, 240) == (m.width, m.height), (s.get("width"), s.get("height")))
    check(f"{codec}: every frame, none extra", int(s.get("nb_read_frames") or 0) == len(units) == m.count, s.get("nb_read_frames"))
    check(f"{codec}: duration from the real timestamps", abs(dur - len(units) / FPS) < 0.15, dur)
    d = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
    check(f"{codec}: decodes cleanly from the MP4", d.returncode == 0 and not d.stderr.strip(), d.stderr[:200])
    box = b"avcC" if codec == "h264" else b"hvcC"
    check(f"{codec}: MP4 carries its {box.decode()} box", box in out.read_bytes())
    check(f"{codec}: first/last times kept", m.first_t == t0 and abs(m.last_t - (t0 + (len(units) - 1) / FPS)) < 1e-9)
    return units


# ------------------------------------------------------------------ a whole export, stand-in reader
class FakeReader:
    """Stands in for PlaybackReader: replays synthetic access units from the keyframe `preroll` s before the
    requested start, labelled like a calibrated segment, until `until` (or forever)."""
    units = None
    codec = "h264"
    preroll = 7.0
    until = None
    delay = 0.0
    instances = []

    def __init__(self, conn, channel, path, a_const, start_utc, tz, speed="1", adaptive_speeds=None):
        import queue
        self.q = queue.Queue(maxsize=200)
        self.speed = (adaptive_speeds or (speed,))[0]
        self.waiting_for_slot = False
        self.start_t = datetime.datetime.fromisoformat(start_utc).timestamp()
        self.stopped = threading.Event()
        self.seg = {"codec": FakeReader.codec, "time_source": "calibration", "approx": False, "target": self.start_t,
                    "display_from": self.start_t, "first_utc": self.start_t - FakeReader.preroll, "bound_s": 1.6,
                    "_a": 0.0, "_offset": 0.0, "_cal": {"a_const": 1.0, "measured_utc": "2026-10-14T00:00:00+00:00",
                                                         "method": "osd_tick", "error_estimate": 0.12}}
        FakeReader.instances.append(self)

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        t, i = self.seg["first_utc"], 0
        units = FakeReader.units
        while not self.stopped.is_set():
            if FakeReader.until is not None and t > FakeReader.until:
                self.q.put(None)
                return
            key, data = units[i % len(units)]
            self.q.put(psess.Frame(t, key, data, self.seg, t < self.start_t - 0.02))
            t += 1 / FPS
            i += 1
            if FakeReader.delay:
                time.sleep(FakeReader.delay)

    def stop(self):
        self.stopped.set()
        try:
            self.q.put_nowait(None)
        except Exception:
            pass


CONN_DICT = {"host": "10.0.0.9", "rtsp_port": 554, "http_port": 80, "username": "u", "password": "p", "encrypted": False, "key": ""}


def whole_export(units):
    db.init()
    db.set_calibration(1, 1.0, 0.12, "osd_tick")
    real = psess.PlaybackReader
    psess.PlaybackReader = FakeReader
    FakeReader.units, FakeReader.codec = units, "h264"
    start = datetime.datetime(2026, 11, 10, 8, 41, 47, tzinfo=UTC)
    end = start + datetime.timedelta(seconds=6)
    ch = {"id": "c1", "channel": 1, "name": "Front Gate", "_tz_offset_min": 330}
    try:
        job_dir = export.EXPORT_DIR / "t1"
        job_dir.mkdir(parents=True, exist_ok=True)
        FakeReader.until = None
        clip = export._export_one_channel(job_dir, ch, start.isoformat(), end.isoformat(), CONN_DICT)
        f = job_dir / clip["file"]
        check("export: clip written", f.exists() and clip["file"] == "clip_Front_Gate.mp4")
        check("export: SHA-256 of the file (hashed in chunks)", clip["sha256"] == export.hashlib.sha256(f.read_bytes()).hexdigest())
        check("export: starts at the keyframe pre-roll, declared", abs(clip["preroll_s"] - 7.0) < 0.07 and
              clip["dvr_time_range_utc"]["start"].startswith("2026-11-10T08:41:40"), (clip["preroll_s"], clip["dvr_time_range_utc"]))
        check("export: ends at the requested end", clip["dvr_time_range_utc"]["end"].startswith("2026-11-10T08:41:5"), clip["dvr_time_range_utc"])
        check("export: DVR-local times with the recorder's offset", clip["utc_offset_minutes"] == 330 and
              clip["dvr_time_range_local"]["start"].startswith("2026-11-10T14:11:40") and clip["dvr_time_range_local"]["start"].endswith("+05:30"), clip["dvr_time_range_local"])
        check("export: codec, size, frames", clip["codec"] == "H.264" and (clip["width"], clip["height"]) == (320, 240) and clip["frame_count"] == 13 * FPS + 1, (clip["codec"], clip["frame_count"]))
        check("export: time source and an honest accuracy statement", clip["time_source"] == "calibration" and clip["time_bound_s"] == 1.6
              and "±1.6 s" in clip["time_accuracy"] and "7.0 s before the requested start" in clip["time_accuracy"], clip["time_accuracy"])
        check("export: calibration recorded", clip["calibration"]["measured_utc"] == "2026-10-14T00:00:00+00:00")
        s, dur = probe(f)
        check("export: ffprobe agrees (h264, 320x240, 196 frames, 13 s)", s.get("codec_name") == "h264" and int(s.get("nb_read_frames", 0)) == 196 and abs(dur - 196 / FPS) < 0.15, (s, dur))

        # Truncated: the reader stops 4 s short of the end — refused, and nothing left behind.
        FakeReader.until = end.timestamp() - 4
        try:
            export._export_one_channel(job_dir, dict(ch, name="Short"), start.isoformat(), end.isoformat(), CONN_DICT)
            check("export: a truncated capture is refused", False)
        except RuntimeError as e:
            check("export: a truncated capture is refused", "stopped early" in str(e), e)
        check("export: ...and its partial file removed", not (job_dir / "clip_Short.mp4").exists())

        # Anchored footage at a time the coverage index says wasn't recorded: refused.
        FakeReader.until = None
        orig = FakeReader.__init__

        def anchored(self, *a, **k):
            orig(self, *a, **k)
            self.seg.update(time_source="anchor", approx=True, bound_s=None, first_utc=self.start_t, _cal={})
        FakeReader.__init__ = anchored
        db.write("INSERT INTO coverage_days(channel, day, spans_json, refreshed_utc) VALUES (?,?,?,?)",
                 (1, "2026-11-10", json.dumps([["2026-11-10T00:00:00+00:00", "2026-11-10T08:00:00+00:00"]]), "2026-11-11T00:00:00+00:00"))
        try:
            export._export_one_channel(job_dir, dict(ch, name="Gap"), start.isoformat(), end.isoformat(), CONN_DICT)
            check("export: anchored footage outside every recorded span is refused", False)
        except RuntimeError as e:
            check("export: anchored footage outside every recorded span is refused", "no recording at 2026-11-10 14:11:47" in str(e), e)
        db.write("UPDATE coverage_days SET spans_json=? WHERE channel=1",
                 (json.dumps([["2026-11-10T00:00:00+00:00", "2026-11-10T23:59:59+00:00"]]),))
        clip = export._export_one_channel(job_dir, dict(ch, name="Approx"), start.isoformat(), end.isoformat(), CONN_DICT)
        check("export: anchored footage inside coverage is exported, declared approximate",
              clip["time_source"] == "anchor" and clip["time_bound_s"] is None and clip["time_accuracy"].startswith("Approximate"), clip["time_accuracy"][:60])
        FakeReader.__init__ = orig
        shutil.rmtree(job_dir, ignore_errors=True)
    finally:
        psess.PlaybackReader = real


def signed_package(units):
    real_reader, real_info, real_ver = psess.PlaybackReader, export.recorder_info, export.app_version
    psess.PlaybackReader = FakeReader
    FakeReader.units, FakeReader.until, FakeReader.delay = units, None, 0.0
    export.recorder_info = lambda c: {"model": "DS-7208HQHI-K1", "serial": "SYNTHETIC0001", "firmware": "V4.25"}
    export.app_version = lambda: "v-test"
    start = datetime.datetime(2026, 11, 10, 8, 41, 47, tzinfo=UTC)
    chans = [{"id": "c1", "channel": 1, "name": "Front Gate", "_tz_offset_min": 330}]
    try:
        export.start_export("pkg1", chans, start.isoformat(), (start + datetime.timedelta(seconds=4)).isoformat(),
                            "signed", "opal", CONN_DICT)
        job = wait_job("pkg1")
        check("signed: job done", job["state"] == "done", job)
        check("signed: job status has no private fields", not any(k.startswith("_") for k in job), job)
        z = zipfile.ZipFile(export.EXPORT_DIR / job["download"])
        names = set(z.namelist())
        check("signed: package contents", {"clip_Front_Gate.mp4", "manifest.json", "signature.json", "verify.html"} <= names, names)
        info = {i.filename: i for i in z.infolist()}
        check("signed: the clip is stored, not deflated", info["clip_Front_Gate.mp4"].compress_type == zipfile.ZIP_STORED)
        check("signed: text files are deflated", info["manifest.json"].compress_type == zipfile.ZIP_DEFLATED)
        man_raw = z.read("manifest.json")
        man, sig = json.loads(man_raw), json.loads(z.read("signature.json"))
        check("manifest v2: version", man["manifest_version"] == 2)
        check("manifest v2: app", man["app"] == {"name": "Sentinel Eye", "version": "v-test"})
        check("manifest v2: recorder", man["recorder"]["model"] == "DS-7208HQHI-K1" and man["recorder"]["firmware"] == "V4.25")
        check("manifest v2: key fingerprint matches the signing key", man["signing_key_fingerprint"] == export.key_fingerprint(sig["public_key_hex"]))
        c = man["clips"][0]
        check("manifest v2: per-clip fields", all(k in c for k in ("codec", "width", "height", "dvr_time_range_local", "utc_offset_minutes",
                                                                    "time_source", "time_accuracy", "preroll_s", "dvr_time_range_utc", "sha256")), sorted(c))
        from Crypto.Signature import eddsa
        key = eddsa.import_public_key(bytes.fromhex(sig["public_key_hex"]))
        try:
            eddsa.new(key, "rfc8032").verify(man_raw, bytes.fromhex(sig["signature_hex"]))
            check("signed: Ed25519 signature verifies over manifest.json", True)
        except ValueError:
            check("signed: Ed25519 signature verifies over manifest.json", False)
        check("signed: clip hash matches the zipped clip", export.hashlib.sha256(z.read("clip_Front_Gate.mp4")).hexdigest() == c["sha256"])
        check("signed: per-job folder kept beside the zip until the sweep", (export.EXPORT_DIR / "pkg1").is_dir())
    finally:
        psess.PlaybackReader, export.recorder_info, export.app_version = real_reader, real_info, real_ver


def wait_job(jid, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = export.get_job(jid)
        if j["state"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.05)
    return export.get_job(jid)


def cancel(units):
    real = psess.PlaybackReader
    psess.PlaybackReader = FakeReader
    FakeReader.units, FakeReader.until, FakeReader.delay = units, None, 0.01   # ~1.5x real time: long enough to cancel
    start = datetime.datetime(2026, 11, 10, 8, 41, 47, tzinfo=UTC)
    chans = [{"id": "c1", "channel": 1, "name": "A", "_tz_offset_min": 330}, {"id": "c2", "channel": 1, "name": "B", "_tz_offset_min": 330}]
    try:
        n0 = len(FakeReader.instances)
        export.start_export("cx1", chans, start.isoformat(), (start + datetime.timedelta(seconds=120)).isoformat(), "signed", "opal", CONN_DICT)
        deadline = time.time() + 5
        while not (export.EXPORT_DIR / "cx1" / "clip_A.mp4").exists() and time.time() < deadline:
            time.sleep(0.02)
        check("cancel: running job has a partial clip", (export.EXPORT_DIR / "cx1" / "clip_A.mp4").exists())
        check("cancel: accepted while running", export.cancel_job("cx1") == "cancelling")
        job = wait_job("cx1")
        check("cancel: job ends cancelled", job["state"] == "cancelled", job)
        check("cancel: its reader was stopped", FakeReader.instances[n0].stopped.is_set())
        check("cancel: the remaining camera never started", len(FakeReader.instances) == n0 + 1, len(FakeReader.instances) - n0)
        check("cancel: partial files removed", not (export.EXPORT_DIR / "cx1").exists() and not (export.EXPORT_DIR / "cx1.zip").exists())
        check("cancel: a finished job can't be cancelled", export.cancel_job("cx1") == "cancelled" and export.cancel_job("pkg1") == "done")
        check("cancel: unknown job -> None", export.cancel_job("nope") is None)
    finally:
        psess.PlaybackReader = real
        FakeReader.delay = 0.0


def provenance():
    fp = export.key_fingerprint("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")   # RFC 8032 test 1
    want = "21FE 31DF A154 A261 626B F854 046F D227 1B7B ED4B 6ABE 45AA 5887 7EF4 7F97 21B9"
    check("fingerprint: fixed test vector", fp == want, fp)
    info = export.signing_key_info()
    check("signing key info: hex + fingerprint", len(info["public_key_hex"]) == 64 and info["fingerprint"] == export.key_fingerprint(info["public_key_hex"]))
    # verify.html computes the same thing in the browser (WebCrypto) — run its function under Node.
    html = (Path("app") / "export_assets" / "verify.html").read_text()
    fn = re.search(r"const fingerprint = (async \(pubHex\) => .*?;)\n", html)
    node = shutil.which("node")
    if fn and node:
        js = ("const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');\n"
              "const fromHex = (s) => { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };\n"
              "const sha256 = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf));\n"
              f"const fingerprint = {fn.group(1)}\n"
              "fingerprint('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a').then((v) => console.log(v));")
        r = subprocess.run([node, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=20)
        check("fingerprint: verify.html computes the same value", r.stdout.strip() == want, r.stdout.strip() or r.stderr[:200])
    else:
        skip("fingerprint: verify.html computes the same value", "no node" if not node else "function not found")

    xml = ("<DeviceInfo><deviceName>Embedded Net DVR</deviceName><model>DS-7208HQHI-K1</model><serialNumber>SYNTH123</serialNumber>"
           "<firmwareVersion>V4.25.005</firmwareVersion><firmwareReleasedDate>build 200101</firmwareReleasedDate></DeviceInfo>")
    check("deviceInfo parsed", export._parse_device_info(xml) == {"model": "DS-7208HQHI-K1", "serial": "SYNTH123",
                                                                  "firmware": "V4.25.005", "firmware_date": "build 200101"})
    calls = []

    class Boom:
        def __init__(self, *a, **k):
            calls.append(1)

        def get(self, path, **kw):
            raise OSError("unreachable")
    real = export.isapi.Isapi
    export.isapi.Isapi = Boom
    export._recorder_info.update(value=None, tried=0.0)
    try:
        check("recorder info: unreachable -> None, never raises", export.recorder_info(CONN_DICT) is None)
        export.recorder_info(CONN_DICT)
        check("recorder info: not retried at once (at most every 10 min)", len(calls) == 1, len(calls))
    finally:
        export.isapi.Isapi = real
    v = export.app_version()
    check("app version: a string, 'unknown' without git", isinstance(v, str) and v, v)
    check("deadline covers pre-roll at the granted speed", export.export_deadline_s(3600, "16") == (3600 + 60) / 16 * 3 + 60 and export.export_deadline_s(3600, "1") == (3600 + 60) * 3 + 60)


def job_queue(units):
    """Jobs run one at a time in request order, are listed with their place in the queue and progress, a queued
    one can be cancelled without ever reaching the recorder, and the list survives a restart."""
    real_reader, real_info, real_ver = psess.PlaybackReader, export.recorder_info, export.app_version
    psess.PlaybackReader = FakeReader
    FakeReader.units, FakeReader.until, FakeReader.delay = units, None, 0.01
    export.recorder_info = lambda c: None
    export.app_version = lambda: "v-test"
    start = datetime.datetime(2026, 11, 10, 8, 41, 47, tzinfo=UTC)
    end = (start + datetime.timedelta(seconds=120)).isoformat()
    short_end = (start + datetime.timedelta(seconds=4)).isoformat()
    chan = lambda name: [{"id": "c1", "channel": 1, "name": name, "_tz_offset_min": 330}]
    try:
        n0 = len(FakeReader.instances)
        export.start_export("q1", chan("First"), start.isoformat(), end, "plain", "opal", CONN_DICT)
        export.start_export("q2", chan("Second"), start.isoformat(), short_end, "plain", "opal", CONN_DICT)
        export.start_export("q3", chan("Third"), start.isoformat(), short_end, "plain", "ruby", CONN_DICT)
        deadline = time.time() + 5
        while export.get_job("q1")["state"] != "running" and time.time() < deadline:
            time.sleep(0.02)
        time.sleep(0.3)
        jobs = {j["id"]: j for j in export.list_jobs()}
        check("queue: first job runs, the others wait", (jobs["q1"]["state"], jobs["q2"]["state"], jobs["q3"]["state"]) == ("running", "queued", "queued"),
              [jobs[k]["state"] for k in ("q1", "q2", "q3")])
        check("queue: only one recorder session opened while others wait", len(FakeReader.instances) == n0 + 1, len(FakeReader.instances) - n0)
        check("queue: positions count from the front", (jobs["q1"]["position"], jobs["q2"]["position"], jobs["q3"]["position"]) == (None, 1, 2))
        ids = [j["id"] for j in export.list_jobs()]
        check("list: newest first", ids.index("q3") < ids.index("q2") < ids.index("q1"), ids)
        check("list: says what each job is", jobs["q3"]["cameras"] == ["Third"] and jobs["q3"]["operator"] == "ruby" and jobs["q3"]["package"] == "plain"
              and jobs["q3"]["start_utc"] == start.isoformat() and jobs["q3"]["created_utc"])
        check("list: no private fields", not any(k.startswith("_") for j in export.list_jobs() for k in j))
        deadline = time.time() + 5
        while not export.get_job("q1")["percent"] and time.time() < deadline:
            time.sleep(0.05)
        check("progress: a running job reports a percent", 0 < (export.get_job("q1")["percent"] or 0) < 100, export.get_job("q1")["percent"])
        saved = json.loads((export.EXPORT_DIR / "jobs.json").read_text())
        check("persisted: the list is written to exports/jobs.json", saved.get("q1", {}).get("state") == "running" and "q3" in saved)

        check("cancel queued: cancelled on the spot", export.cancel_job("q2") == "cancelled" and export.get_job("q2")["state"] == "cancelled")
        check("cancel queued: the job behind it moves up", {j["id"]: j["position"] for j in export.list_jobs()}["q3"] == 1)
        check("cancel running: accepted", export.cancel_job("q1") == "cancelling")
        check("cancel running: ends cancelled", wait_job("q1")["state"] == "cancelled")
        j3 = wait_job("q3")
        check("queue: the next waiting job then runs to the end", j3["state"] == "done" and j3["percent"] == 100, j3)
        check("queue: a cancelled queued job never opened a recorder session", len(FakeReader.instances) == n0 + 2, len(FakeReader.instances) - n0)
        check("done: size, finish time and expiry recorded", j3["size_bytes"] > 0 and j3["finished_utc"] and j3["expires_utc"] > j3["finished_utc"], j3)
        check("done: nothing left waiting", all(j["position"] is None for j in export.list_jobs()))

        # A restart: the saved list comes back; unfinished work is marked interrupted, missing files are dropped.
        time.sleep(0.2)   # the worker's final save
        saved = json.loads((export.EXPORT_DIR / "jobs.json").read_text())
        saved["r-run"] = {"state": "running", "cameras": ["X"], "_created": time.time(), "percent": 40}
        saved["r-wait"] = {"state": "queued", "cameras": ["Y"], "_created": time.time()}
        saved["r-gone"] = {"state": "done", "download": "r-gone.zip", "_created": time.time()}
        saved["../evil"] = {"state": "done", "download": "x", "_created": time.time()}
        (export.EXPORT_DIR / "r-run").mkdir()
        (export.EXPORT_DIR / "r-run" / "clip_X.mp4").write_bytes(b"partial")
        (export.EXPORT_DIR / "jobs.json").write_text(json.dumps(saved))
        with export._jobs_lock:
            export._jobs.clear()
            export._ctl.clear()
        export.load_jobs()
        back = {j["id"]: j for j in export.list_jobs()}
        check("restart: a finished export is still listed and downloadable", back.get("q3", {}).get("state") == "done"
              and (export.EXPORT_DIR / back["q3"]["download"]).exists())
        check("restart: running and queued jobs come back as interrupted", back["r-run"]["state"] == "interrupted" and back["r-wait"]["state"] == "interrupted"
              and "restarted" in back["r-run"]["error"])
        check("restart: an interrupted job's partial clip is removed", not (export.EXPORT_DIR / "r-run").exists())
        check("restart: a finished job whose file is gone is dropped", "r-gone" not in back)
        check("restart: a job id that isn't one of ours is ignored", "../evil" not in back)
        check("restart: an interrupted job can't be cancelled or downloaded", export.cancel_job("r-run") == "interrupted" and not back["r-run"]["download"])
        (export.EXPORT_DIR / "jobs.json").write_text("{not json")
        with export._jobs_lock:
            export._jobs.clear()
        export.load_jobs()
        check("restart: a corrupt jobs.json is ignored, not fatal", export.list_jobs() == [])
        export.start_export("q4", chan("After"), start.isoformat(), short_end, "plain", "opal", CONN_DICT)
        check("queue: still works after a reload", wait_job("q4")["state"] == "done")
    finally:
        psess.PlaybackReader, export.recorder_info, export.app_version = real_reader, real_info, real_ver
        FakeReader.delay = 0.0


def sweep():
    old = time.time() - export.JOB_TTL - 60
    export.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    (export.EXPORT_DIR / "oldjob").mkdir(exist_ok=True)
    (export.EXPORT_DIR / "oldjob.zip").write_bytes(b"PK")
    (export.EXPORT_DIR / "oldrunning").mkdir(exist_ok=True)
    for p in (export.EXPORT_DIR / "oldjob", export.EXPORT_DIR / "oldjob.zip", export.EXPORT_DIR / "oldrunning"):
        os.utime(p, (old, old))
    with export._jobs_lock:
        export._jobs["oldjob"] = {"state": "done", "_created": old}
        export._jobs["oldrunning"] = {"state": "running", "_created": old}
        export._ctl["oldjob"] = {"cancel": threading.Event(), "reader": None}
    export._sweep_old_jobs()
    check("sweep: old job folder and its zip removed", not (export.EXPORT_DIR / "oldjob").exists() and not (export.EXPORT_DIR / "oldjob.zip").exists())
    check("sweep: finished job forgotten, running one kept", "oldjob" not in export._jobs and "oldjob" not in export._ctl and "oldrunning" in export._jobs)
    check("sweep: a long-running export's folder is never swept", (export.EXPORT_DIR / "oldrunning").is_dir())
    import enhance_ai
    with enhance_ai._jobs_lock:
        enhance_ai._jobs["e-old"] = {"state": "done", "_created": old}
        enhance_ai._jobs["e-new"] = {"state": "done", "_created": time.time()}
    enhance_ai._sweep_old_jobs()
    check("sweep (enhancer): old finished job forgotten, recent kept", "e-old" not in enhance_ai._jobs and "e-new" in enhance_ai._jobs)
    check("enhancer job status has no private fields", "_created" not in enhance_ai.get_job("e-new"))


def main():
    try:
        units = mux_codec("h264")
        mux_codec("hevc")
        if units:
            whole_export(units)
            signed_package(units)
            cancel(units)
            job_queue(units)
        else:
            skip("whole export / signed package / cancel / job queue", "needs an H.264 encoder for the synthetic clip")
        provenance()
        sweep()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
