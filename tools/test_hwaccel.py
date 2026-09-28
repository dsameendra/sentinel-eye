"""Encoder selection checks for app/hwaccel.py, with ffmpeg and /dev/dri faked out (no GPU needed).

   .venv/bin/python3 tools/test_hwaccel.py
"""
import subprocess
import sys

sys.path.insert(0, "app")
import hwaccel

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def fake_run(working):
    """An ffmpeg stand-in: a test encode succeeds only for the encoders in `working`. Records every call."""
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        enc = cmd[cmd.index("-c:v") + 1]
        return subprocess.CompletedProcess(cmd, 0 if enc in working else 1, "", "")
    run.calls = calls
    return run


def detect(env=None, platform="linux", working=(), nodes=()):
    run = fake_run(working)
    return hwaccel.detect(env=env or {}, platform=platform, run=run, render_nodes=lambda: list(nodes)), run


def main():
    got, run = detect(platform="darwin", working={"h264_videotoolbox"})
    check("macOS picks VideoToolbox", got == ("videotoolbox", None), got)

    got, _ = detect(working={"h264_nvenc", "h264_vaapi"}, nodes=["/dev/dri/renderD128"])
    check("NVENC wins over VA-API", got == ("nvenc", None), got)

    got, _ = detect(working={"h264_vaapi"}, nodes=["/dev/dri/renderD128", "/dev/dri/renderD129"])
    check("VA-API on the first render node that works", got == ("vaapi", "/dev/dri/renderD128"), got)

    got, run = detect(working={"h264_vaapi"}, nodes=[])
    check("no render node: VA-API never tried", got == ("cpu", None) and
          not any("h264_vaapi" in c for c in run.calls), got)

    got, _ = detect(working={"h264_v4l2m2m"})
    check("V4L2 M2M when that's all there is", got == ("v4l2m2m", None), got)

    got, _ = detect(working={"libx264"})
    check("nothing works: CPU", got == ("cpu", None), got)

    got, run = detect(env={"SENTINEL_HWACCEL": "cpu"}, working={"h264_nvenc"})
    check("SENTINEL_HWACCEL=cpu skips probing", got == ("cpu", None) and not run.calls, got)

    got, _ = detect(env={"SENTINEL_HWACCEL": "vaapi"}, working={"h264_nvenc", "h264_vaapi"},
                    nodes=["/dev/dri/renderD128"])
    check("forced engine is used even when a preferred one exists", got == ("vaapi", "/dev/dri/renderD128"), got)

    got, _ = detect(env={"SENTINEL_HWACCEL": "nvenc"}, working=set())
    check("forced engine that fails falls back to CPU", got == ("cpu", None), got)

    got, _ = detect(env={"SENTINEL_HWACCEL": "bogus"}, working={"h264_nvenc"})
    check("unknown value is treated as auto", got == ("nvenc", None), got)

    # The command the relay runs must be the same shape the probe validated.
    a = hwaccel.encoder_args("vaapi", "/dev/dri/renderD128")
    check("VA-API uploads frames to the device", a["pre"] == ["-vaapi_device", "/dev/dri/renderD128"] and
          a["vf"][-2:] == ["format=nv12", "hwupload"] and a["codec"][:2] == ["-c:v", "h264_vaapi"], a)
    check("CPU keeps libx264 low-latency settings", hwaccel.encoder_args("cpu")["codec"][:2] == ["-c:v", "libx264"] and
          "zerolatency" in hwaccel.encoder_args("cpu")["codec"])

    check("go2rtc: explicit engines", [hwaccel.go2rtc_hardware(e) for e in ("nvenc", "vaapi", "v4l2m2m", "cpu")] ==
          ["#hardware=cuda", "#hardware=vaapi", "#hardware=v4l2m2m", ""])
    check("go2rtc: VideoToolbox keeps plain #hardware (unchanged macOS behaviour)",
          hwaccel.go2rtc_hardware("videotoolbox") == "#hardware")

    # Resolved once by the server, inherited by every relay process through the environment.
    env = {}
    hwaccel.export(("vaapi", "/dev/dri/renderD128"), env)
    got, run = detect(env=env, working=set())
    check("exported choice is reused without probing", got == ("vaapi", "/dev/dri/renderD128") and not run.calls, got)

    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
