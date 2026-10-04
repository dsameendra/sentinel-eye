"""Synthetic UI preview for PWA header checks. No recorder, credentials, writes or real footage.

Run: .venv/bin/python tools/pwa_preview.py
Open /?pwa=1&top=59 to simulate installed iPhone geometry; /?pwa=1&top=24 for iPad.
Omit both parameters for native device signals. Bind --host 0.0.0.0 only for a local device comparison.
This tests page layout, not Apple's native status-bar compositor.
"""
import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))
from settings import Settings, Connection, Channel, Display

S = Settings(connection=Connection(host="synthetic.invalid"),
             channels=[Channel(id="test1", channel=1, name="Synthetic camera")],
             display=Display(order=["test1"], layout="1x1", theme="dark")).model_dump()

CONTROLS = """
<aside id="preview-controls" style="position:fixed;bottom:110px;right:8px;z-index:300;max-width:150px;display:grid;gap:4px">
  <button class="btn" data-test="enhancer">Test enhancer</button>
  <button class="btn" data-test="export">Test export</button>
  <button class="btn" data-test="dialog">Test dialog</button>
  <button class="btn" data-test="toast">Test toast</button>
  <button class="btn" data-test="theme">Toggle theme</button>
</aside>
<script type="module">
import { openEnhancePopup } from '/js/enhancePopup.js';
import { PlaybackView } from '/js/playback.js';
import { confirmDialog, toast } from '/js/ui.js';
let playback;
const build = PlaybackView.prototype.build;
PlaybackView.prototype.build = function (...args) { playback = this; return build.apply(this, args); };
document.querySelector('[data-test=enhancer]').onclick = () => {
  const frame = document.createElement('canvas'); frame.width = 640; frame.height = 360;
  const c = frame.getContext('2d'); c.fillStyle = '#304768'; c.fillRect(0, 0, 640, 360);
  c.fillStyle = '#fff'; c.font = '28px sans-serif'; c.fillText('Synthetic frame', 30, 60);
  openEnhancePopup({ frames: [frame], pausedIndex: 0, camName: 'Synthetic camera' });
};
document.querySelector('[data-test=export]').onclick = () => playback?.openExportDialog();
document.querySelector('[data-test=dialog]').onclick = () => confirmDialog({ title: 'Synthetic dialog', body: 'Header layering check' });
document.querySelector('[data-test=toast]').onclick = () => toast('Synthetic notification');
document.querySelector('[data-test=theme]').onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  window.SentinelPWA.syncTheme();
};
</script>
"""


class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "web"), **kw)

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path in ("/", "/index.html", "/login", "/pair"):
            entry = {"/login": "login", "/pair": "pair"}.get(url.path, "index")
            html = (ROOT / "web" / f"{entry}.html").read_text()
            setup = ""
            if "pwa" in q:
                enabled = q["pwa"][0] == "1"
                setup += f'<script>Object.defineProperty(navigator,"standalone",{{value:{str(enabled).lower()},configurable:true}});</script>'
            if "top" in q:
                top = max(0, min(100, float(q["top"][0])))
                setup += f'<style>:root {{ --safe-top: {top}px; }}</style>'
            if "gap" in q:
                gap = max(0, min(40, float(q["gap"][0])))
                setup += f'<style>html.ios-pwa {{ --pwa-blur-gap: {gap}px; }}</style>'
            html = html.replace('<script src="js/pwa.js">', setup + '<script src="js/pwa.js">')
            if entry == "index":
                html = html.replace('<script type="module" src="js/main.js"></script>', CONTROLS + '<script type="module" src="js/main.js"></script>')
            data = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if url.path.startswith("/api/"):
            values = {
                "/api/auth/me": {"auth_enabled": False, "via": "none", "role": "admin", "user": None},
                "/api/settings": S,
                "/api/status": {"go2rtc": False, "streams": {}},
                "/api/timeline/tz": {"offset_min": 330},
                "/api/timeline/events": [], "/api/bookmarks": [],
                "/api/timeline/calibration": {}, "/api/playback/pool": {"busy": 0, "limit": 4},
                "/api/auth/admin/users": [], "/api/auth/sessions": [],
                "/api/auth/admin/config": {"auth_enabled": False},
            }
            # Separate entry points need a synthetic signed-out/admin state to stay on their forms.
            entry = urlparse(self.headers.get("Referer", "")).path
            if url.path == "/api/auth/me" and entry in ("/login", "/pair"):
                values[url.path] = {"auth_enabled": True, "via": "session" if entry == "/pair" else "none", "role": "admin",
                                    "user": {"kind": "person", "username": "synthetic"} if entry == "/pair" else None}
            if url.path.startswith("/api/timeline/coverage"):
                self.send_json([])
            else:
                self.send_json(values.get(url.path, {}))
            return
        if url.path == "/sw.js":
            # Do not install a worker for a temporary synthetic origin.
            self.send_error(404)
            return
        if url.path.startswith("/ws"):
            self.send_error(503, "No video source in the synthetic preview")
            return
        super().do_GET()

    def do_POST(self):
        self.send_json({"detail": "Synthetic preview: no jobs or writes"}, 503)

    do_PUT = do_POST
    do_DELETE = do_POST


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--host", default="127.0.0.1")
    args.add_argument("--port", type=int, default=8082)
    opt = args.parse_args()
    server = ThreadingHTTPServer((opt.host, opt.port), Preview)
    print(f"Synthetic PWA preview: http://{opt.host}:{opt.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
