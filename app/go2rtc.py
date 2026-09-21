"""Runs go2rtc as a child process and keeps its stream list in sync with our settings."""
import json, os, subprocess, sys, threading, time, urllib.parse, urllib.request
from pathlib import Path

from settings import DATA, ROOT, SETTINGS_FILE, Settings

API_PORT = int(os.environ.get("SENTINEL_API_PORT", 1984))
RTSP_PORT = int(os.environ.get("SENTINEL_RTSP_PORT", 8554))
WEBRTC_PORT = int(os.environ.get("SENTINEL_WEBRTC_PORT", 8555))
API = f"http://127.0.0.1:{API_PORT}"
BIN = ROOT / "bin" / "go2rtc"
CONFIG = DATA / "go2rtc.yaml"   # generated on every start
RELAY = ROOT / "app" / "hikrelay.py"


def stream_names(channel_id: str) -> dict:
    return {"sub": f"{channel_id}_sub", "main": f"{channel_id}_main", "main_h264": f"{channel_id}_main_h264"}


def source_for(s: Settings, ch, kind: str, transcode: bool = False) -> str:
    c = s.connection
    if c.encrypted:
        # our relay decrypts on demand; go2rtc starts it when a viewer connects and stops it when they leave
        return (f"exec:{sys.executable} {RELAY} stream --settings {SETTINGS_FILE} "
                f"--channel-id {ch.id} --kind {kind} --out {{output}}" + (" --transcode" if transcode else ""))
    path = (ch.main_path if kind == "main" else ch.sub_path) or \
        f"/Streaming/Channels/{ch.channel}{'01' if kind == 'main' else '02'}"
    cred = f"{urllib.parse.quote(c.username, safe='')}:{urllib.parse.quote(c.password, safe='')}@" if c.username else ""
    url = f"rtsp://{cred}{c.host}:{c.rtsp_port}{path}"
    return f"ffmpeg:{url}#video=h264#hardware" if transcode else url


def desired_streams(s: Settings) -> dict:
    out = {}
    if not s.connection.host:
        return out
    for ch in s.channels:
        if not ch.enabled:
            continue
        n = stream_names(ch.id)
        out[n["sub"]] = source_for(s, ch, "sub")
        out[n["main"]] = source_for(s, ch, "main")
        out[n["main_h264"]] = source_for(s, ch, "main", transcode=True)
    return out


BASE_CONFIG = f"""api:
  listen: "127.0.0.1:{API_PORT}"
rtsp:
  listen: "127.0.0.1:{RTSP_PORT}"
webrtc:
  listen: ":{WEBRTC_PORT}"
log:
  level: info
"""


def render_config(s: Settings) -> str:
    """go2rtc only accepts exec: sources from its config file (not its API), so we generate the file."""
    lines = [BASE_CONFIG, "streams:"]
    streams = desired_streams(s)
    if not streams:
        lines[-1] = "streams: {}"
    for name, src in streams.items():
        lines.append(f"  {name}: {json.dumps(src)}")   # a JSON string is a valid YAML scalar
    keep = [n for n in streams if n.endswith("_sub")]
    if keep:   # sub-streams stay connected so the grid starts instantly (and motion/AI can use them later)
        lines.append("preload:")
        lines += [f"  {n}: video" for n in keep]
    return "\n".join(lines) + "\n"


class Go2rtc:
    def __init__(self, get_settings):
        self.get_settings = get_settings
        self.proc = None
        self._stop = False
        self._lock = threading.Lock()

    def _spawn(self):
        DATA.mkdir(exist_ok=True)
        CONFIG.write_text(render_config(self.get_settings()))
        CONFIG.chmod(0o600)   # contains the recorder password when encryption is off
        log = open(DATA / "go2rtc.log", "ab")
        self.proc = subprocess.Popen([str(BIN), "-config", str(CONFIG)], stdout=log, stderr=subprocess.STDOUT)
        for _ in range(50):
            if self.up():
                return
            time.sleep(0.1)

    def _kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def start(self):
        with self._lock:
            self._spawn()
        threading.Thread(target=self._watchdog, daemon=True).start()

    def stop(self):
        self._stop = True
        self._kill()

    def sync(self):
        """Apply new settings: regenerate the config and restart go2rtc (viewers reconnect by themselves)."""
        with self._lock:
            self._kill()
            self._spawn()

    def _watchdog(self):
        while not self._stop:
            time.sleep(3)
            with self._lock:
                if self.proc and self.proc.poll() is not None and not self._stop:
                    self._spawn()

    # -- API (read-only)
    def _get(self, path, timeout=3):
        with urllib.request.urlopen(API + path, timeout=timeout) as r:
            return json.loads(r.read() or b"null")

    def up(self) -> bool:
        try:
            self._get("/api/streams", timeout=1)
            return True
        except Exception:
            return False

    def status(self) -> dict:
        try:
            streams = self._get("/api/streams") or {}
        except Exception:
            return {}
        return {n: {"producers": len(v.get("producers") or []), "consumers": len(v.get("consumers") or [])}
                for n, v in streams.items()}
