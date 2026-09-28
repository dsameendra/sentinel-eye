"""Which H.264 encoder the live H.265 -> H.264 conversion uses: a GPU when there is one that works, else libx264.

Chosen once by the server at startup and handed to go2rtc and every hikrelay process through the environment
(export()), so relays never probe on their own. SENTINEL_HWACCEL forces a choice: auto (default), videotoolbox,
nvenc, vaapi, v4l2m2m or cpu. A forced engine that fails its test encode falls back to cpu.

Only encoding moves to the GPU. Decoding stays in software on purpose (hikrelay.ffmpeg_push_cmd): a hardware
H.265 decoder already failed on this DVR's stream once (VideoToolbox), and a stalled decode freezes the view.
"""
import glob, os, subprocess, sys

ENGINES = ("videotoolbox", "nvenc", "vaapi", "v4l2m2m", "cpu")
RESOLVED = "SENTINEL_HWACCEL_RESOLVED"   # "engine" or "engine:device", set by export()

_CODEC = {
    "videotoolbox": ["-c:v", "h264_videotoolbox", "-b:v", "5M", "-profile:v", "high", "-realtime", "1"],
    "nvenc": ["-c:v", "h264_nvenc", "-preset", "p2", "-tune", "ll", "-b:v", "5M", "-profile:v", "high"],
    "vaapi": ["-c:v", "h264_vaapi", "-b:v", "5M", "-profile:v", "high"],
    "v4l2m2m": ["-c:v", "h264_v4l2m2m", "-b:v", "5M"],
    "cpu": ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "5M"],
}
# go2rtc does its own conversion for unencrypted streams; its engine names differ from ours. VideoToolbox keeps
# go2rtc's plain auto "#hardware", which is what it always used on macOS.
_GO2RTC = {"videotoolbox": "#hardware", "nvenc": "#hardware=cuda", "vaapi": "#hardware=vaapi",
           "v4l2m2m": "#hardware=v4l2m2m", "cpu": ""}


def encoder_args(engine, device=None):
    """ffmpeg arguments for one engine: `pre` goes before -i, `vf` is appended to the filter chain, `codec` after."""
    pre = ["-vaapi_device", device] if engine == "vaapi" else []
    vf = {"vaapi": ["format=nv12", "hwupload"], "v4l2m2m": ["format=yuv420p"]}.get(engine, [])
    return {"pre": pre, "vf": vf, "codec": list(_CODEC[engine])}


def go2rtc_hardware(engine):
    return _GO2RTC[engine]


def _render_nodes():
    return sorted(glob.glob("/dev/dri/renderD*"))


def works(engine, device=None, run=subprocess.run):
    """A real test encode of a few synthetic frames: an encoder being compiled into ffmpeg says nothing about
    whether the GPU, its driver, or access to /dev/dri are actually there."""
    a = encoder_args(engine, device)
    cmd = (["ffmpeg", "-v", "error", "-hide_banner"] + a["pre"] +
           ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10", "-frames:v", "5"] +
           (["-vf", ",".join(a["vf"])] if a["vf"] else []) + a["codec"] + ["-f", "null", "-"])
    try:
        return run(cmd, capture_output=True, text=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _try(engine, run, render_nodes):
    """(engine, device) if it works here, else None."""
    if engine == "vaapi":
        for node in render_nodes():
            if works("vaapi", node, run):
                return ("vaapi", node)
        return None
    return (engine, None) if works(engine, None, run) else None


def detect(env=os.environ, platform=sys.platform, run=subprocess.run, render_nodes=_render_nodes):
    """(engine, device-or-None). Reuses a choice already exported by the server; otherwise probes."""
    done = env.get(RESOLVED, "")
    if done:
        engine, _, device = done.partition(":")
        if engine in ENGINES:
            return (engine, device or None)
    want = env.get("SENTINEL_HWACCEL", "auto").strip().lower()
    if want == "cpu":
        return ("cpu", None)
    if want in ENGINES:
        got = _try(want, run, render_nodes)
        if got:
            return got
        print(f"hwaccel: SENTINEL_HWACCEL={want} failed its test encode, using the CPU", file=sys.stderr, flush=True)
        return ("cpu", None)
    order = ["videotoolbox"] if platform == "darwin" else ["nvenc", "vaapi", "v4l2m2m"]
    for engine in order:
        got = _try(engine, run, render_nodes)
        if got:
            return got
    return ("cpu", None)


def export(choice, env=os.environ):
    engine, device = choice
    env[RESOLVED] = f"{engine}:{device}" if device else engine


_current = None


def current():
    """The process-wide choice, detected (and exported for child processes) on first use."""
    global _current
    if _current is None:
        _current = detect()
        export(_current)
    return _current
