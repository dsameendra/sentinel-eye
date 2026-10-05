"""Synthetic UI preview for adaptive/PWA checks. No recorder, credentials, disk writes or real footage.

Run: .venv/bin/python tools/pwa_preview.py
Open /?pwa=1&top=59 to simulate installed iPhone geometry; /?pwa=1&top=24 for iPad.
Omit both parameters for native device signals. Bind --host 0.0.0.0 only for a local device comparison.
This tests page layout, not Apple's native status-bar compositor.
"""
import argparse
import json
import datetime as dt
import copy
import base64
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))
from settings import Settings, Connection, Channel, Display

S = Settings(connection=Connection(host="synthetic.invalid"),
             channels=[Channel(id=f"test{i}", channel=i, name=f"Synthetic camera {i}") for i in range(1, 5)],
             display=Display(order=[f"test{i}" for i in range(1, 5)], layout="2x2", theme="dark")).model_dump()
PREVIEW_IMAGE = None

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
// Deterministic captures can enter an overlay without leaving test controls in the image.
const screen = new URLSearchParams(location.search).get('screen');
if (screen) window.addEventListener('load', () => {
  const open = () => {
    if (!document.querySelector('#view .appbar')) { setTimeout(open, 50); return; }
    if (screen === 'export' && !playback) { setTimeout(open, 50); return; }
    document.querySelector(`[data-test=${screen}]`)?.click();
  };
  open();
});
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
        if url.path.startswith('/api/timeline/events/') and url.path.endswith('/thumbnail'):
            image = b'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#304768"/><path d="M0 90h320M160 0v180" stroke="#607895"/><text x="24" y="48" fill="white" font-family="sans-serif" font-size="18">Synthetic event preview</text></svg>'
            self.send_response(200)
            self.send_header('Content-Type', 'image/svg+xml')
            self.send_header('Content-Length', str(len(image)))
            self.end_headers()
            self.wfile.write(image)
            return
        if url.path in ("/api/enhance/preview/source", "/api/enhance/preview/result") and PREVIEW_IMAGE:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PREVIEW_IMAGE)))
            self.end_headers()
            self.wfile.write(PREVIEW_IMAGE)
            return
        if url.path in ("/", "/index.html", "/login", "/pair"):
            entry = {"/login": "login", "/pair": "pair"}.get(url.path, "index")
            html = (ROOT / "web" / f"{entry}.html").read_text()
            setup = """<script>
window.addEventListener('error', e => { if (e.target instanceof HTMLMediaElement) return; /* no recorder in this fixture */ const p=document.createElement('pre'); p.id='preview-error'; p.textContent=e.message || `Failed resource: ${e.target?.src || e.target?.href || 'unknown'}`; (document.body || document.documentElement).append(p); }, true);
window.addEventListener('unhandledrejection', e => { const p=document.createElement('pre'); p.id='preview-error'; p.textContent=String(e.reason?.stack || e.reason); document.body.append(p); });
</script>"""
            if "pwa" in q:
                enabled = q["pwa"][0] == "1"
                setup += f'<script>Object.defineProperty(navigator,"standalone",{{value:{str(enabled).lower()},configurable:true}});</script>'
            if "tv" in q:
                setup += '<script>document.documentElement.classList.add("tv-mode"); localStorage.setItem("sentinel-eye-tv-mode","1");</script>'
            else:
                setup += '<script>localStorage.removeItem("sentinel-eye-tv-mode"); document.documentElement.classList.remove("tv-mode");</script>'
            if "theme" in q:
                theme = "light" if q["theme"][0] == "light" else "dark"
                setup += f'<script>localStorage.setItem("sentinel-eye-tv-theme","{theme}"); document.documentElement.dataset.theme="{theme}";</script>'
            if "capture" in q:
                setup += '<style>#preview-controls{display:none!important}</style>'
            if "unsupported" in q:
                setup += '<script>delete window.VideoDecoder;</script>'
            if "top" in q:
                top = max(0, min(100, float(q["top"][0])))
                setup += f'<style>:root {{ --safe-top: {top}px; }}</style>'
            if "bottom" in q:
                bottom = max(0, min(100, float(q["bottom"][0])))
                setup += f'<style>html:root {{ --safe-bottom-raw: {bottom}px; }}</style>'
            if "gap" in q:
                gap = max(0, min(40, float(q["gap"][0])))
                setup += f'<style>html.ios-pwa {{ --pwa-blur-gap: {gap}px; }}</style>'
            html = html.replace('<script src="js/pwa.js">', setup + '<script src="js/pwa.js">')
            if entry == "index":
                html = html.replace('<script type="module" src="js/main.js"></script>', CONTROLS + """<script type="module">
import('/js/main.js').catch(e => { const p=document.createElement('pre'); p.id='preview-error'; p.textContent=String(e.stack || e); document.body.append(p); });
</script>""")
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
                "/api/auth/admin/users": [], "/api/auth/sessions": [], "/api/auth/admin/sessions": [],
                "/api/auth/admin/config": {"auth_enabled": False},
                "/api/auth/admin/devices": [], "/api/auth/admin/audit": [],
                "/api/enhance/models": {"combos": [], "upscalers": [], "faces": [], "plates": [], "text": [{"label": "Synthetic text reader", "about": "Preview fixture", "state": "unavailable", "reason": "Synthetic preview"}]},
            }
            # Separate entry points need a synthetic signed-out/admin state to stay on their forms.
            reference = urlparse(self.headers.get("Referer", ""))
            refq = parse_qs(reference.query)
            values["/api/settings"] = copy.deepcopy(S)
            values["/api/settings"]["display"]["theme"] = "light" if refq.get("theme") == ["light"] else "dark"
            values["/api/settings"]["connection"]["channel_zero"] = "overview" in refq
            entry = reference.path
            if "signed" in refq:
                values["/api/auth/me"] = {"auth_enabled": True, "via": "session", "role": "admin", "limited": False, "session_id": "synthetic-session", "user": {"id": 1, "kind": "person", "username": "Demo", "role": "admin", "has_totp": False, "avatar": {"kind": "initial", "color": "#0074e8"}}}
                values["/api/auth/admin/config"] = {"auth_enabled": True, "require_2fa_admin": False, "bypass_cidrs": [], "bypass_role": "viewer", "trusted_proxies": [], "session_hours": 12, "remember_days": 30, "warnings": []}
                values["/api/auth/admin/users"] = [{"id":1,"username":"Demo","role":"admin","kind":"person","has_totp":False}]
                role = refq.get("role", ["admin"])[0]
                if role in ("viewer", "operator", "admin"):
                    values["/api/auth/me"]["role"] = role
                    values["/api/auth/me"]["user"]["role"] = role
                if "device" in refq:
                    values["/api/auth/me"]["user"].update(kind="device", label="Synthetic screen")
            if "demo" in refq:
                at = dt.datetime.now(dt.timezone.utc)
                values["/api/timeline/events"] = [{"id":i,"channel":i%4+1,"kind":["motion","line","bookmark","tamper"][i%4],"start_utc":(at-dt.timedelta(minutes=5*i)).isoformat(),"end_utc":(at-dt.timedelta(minutes=5*i,seconds=-8)).isoformat(),"attrs_json":"{}"} for i in range(1,9)]
            if url.path.startswith("/api/enhance/preview"):
                values[url.path] = {"state": "done", "faces_found": 0, "models": {"upscaler": "Synthetic preview", "face": "None"}}
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
        global PREVIEW_IMAGE
        # In-memory UI fixtures only, explicitly selected by the preview URL. No AI or recorder work.
        refq = parse_qs(urlparse(self.headers.get("Referer", "")).query)
        path = urlparse(self.path).path
        if path == "/api/auth/pair/start":
            self.send_json({"device_code":"synthetic", "user_code":"DEMO-1234", "expires_in":600})
            return
        if path == "/api/auth/pair/poll":
            self.send_json({"status":"pending"})
            return
        if path == "/api/auth/login" and "twofactor" in refq:
            self.send_json({"totp_required":True,"challenge":"synthetic"})
            return
        if urlparse(self.path).path == "/api/enhance" and "demo" in refq:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            PREVIEW_IMAGE = base64.b64decode(payload["images"][0].split(",")[-1])
            self.send_json({"job_id": "preview"})
            return
        self.send_json({"detail": "Synthetic preview: no jobs or writes"}, 503)

    do_PUT = do_POST
    do_DELETE = do_POST


class PreviewServer(ThreadingHTTPServer):
    # Browser reloads fetch the complete ES-module graph concurrently. Avoid the default five-slot
    # development-server backlog dropping transient connections during a broad viewport sweep.
    request_queue_size = 128


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--host", default="127.0.0.1")
    args.add_argument("--port", type=int, default=8082)
    opt = args.parse_args()
    server = PreviewServer((opt.host, opt.port), Preview)
    print(f"Synthetic PWA preview: http://{opt.host}:{opt.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
