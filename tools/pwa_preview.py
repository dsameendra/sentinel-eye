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
sys.path.insert(0, str(ROOT / "tools"))

from settings import Settings, Connection, Channel, Display
from synthetic_scenes import (
    SCENES, SCENE_DRIVEWAY_SVG, SCENE_FRONTDOOR_SVG, SCENE_BACKYARD_SVG, SCENE_SIDEGATE_SVG,
    SCENE_CHAN0_SVG, make_synthetic_plate_png, make_synthetic_plate_crop_png
)

CHANNELS = [
    Channel(id="test1", channel=1, name="Driveway"),
    Channel(id="test2", channel=2, name="Front Door"),
    Channel(id="test3", channel=3, name="Backyard"),
    Channel(id="test4", channel=4, name="Side Gate"),
]

S = Settings(
    connection=Connection(host="synthetic.invalid"),
    channels=CHANNELS,
    display=Display(order=[c.id for c in CHANNELS], layout="2x2", theme="dark")
).model_dump()

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
  const frame = document.createElement('canvas'); frame.width = 1280; frame.height = 720;
  const c = frame.getContext('2d');
  c.fillStyle = '#27272a'; c.fillRect(0, 0, 1280, 720);
  openEnhancePopup({
    frames: [frame], pausedIndex: 0, camName: 'Driveway', channel: 1,
    atUtc: '2026-10-04T08:45:59Z', tzOffsetMin: 330, defaultMode: 'plate',
    roi: [420, 470, 440, 110]
  });
};
document.querySelector('[data-test=export]').onclick = () => playback?.openExportDialog();
document.querySelector('[data-test=dialog]').onclick = () => confirmDialog({ title: 'Synthetic dialog', body: 'Header layering check' });
document.querySelector('[data-test=toast]').onclick = () => toast('Synthetic notification');
document.querySelector('[data-test=theme]').onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  window.SentinelPWA.syncTheme();
};

const screen = new URLSearchParams(location.search).get('screen');
if (screen) window.addEventListener('load', () => {
  const open = () => {
    if (!document.querySelector('#view .appbar')) { setTimeout(open, 50); return; }
    if (screen === 'export' && !playback) { setTimeout(open, 50); return; }
    document.querySelector(`[data-test=${screen}]`)?.click();
    if (screen === 'enhancer') {
      setTimeout(() => {
        document.querySelector('.enh2-go')?.click();
        const checkDone = () => {
          const saveBtn = document.querySelector('[data-x=save]');
          if (saveBtn && !saveBtn.disabled) {
            document.querySelector('[data-x=ocr-mark]')?.click();
            setTimeout(() => {
              document.querySelector('[data-x=ocr-read]')?.click();
            }, 120);
          } else {
            setTimeout(checkDone, 50);
          }
        };
        setTimeout(checkDone, 300);
      }, 350);
    }
  };
  open();
});
</script>
"""

SCENE_INJECTION_SCRIPT = """<script>
(() => {
  const scenes = {
    test1: '/api/camera/test1/scene.svg',
    test2: '/api/camera/test2/scene.svg',
    test3: '/api/camera/test3/scene.svg',
    test4: '/api/camera/test4/scene.svg',
    chan0: '/api/camera/chan0/scene.svg',
  };

  const paint = () => {
    // 1. Live grid tiles
    document.querySelectorAll('.wall .tile:not(.empty)').forEach((t) => {
      const id = t.dataset.id || (t.classList.contains('overview-tile') ? 'chan0' : 'test1');
      const stage = t.querySelector('.stage');
      if (stage && !stage.querySelector('img.synthetic-feed')) {
        const img = document.createElement('img');
        img.className = 'synthetic-feed';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;pointer-events:none;';
        img.src = scenes[id] || scenes.test1;
        stage.appendChild(img);
      }
      const veil = t.querySelector('.veil');
      if (veil) veil.hidden = true;
      const dot = t.querySelector('.pill.tile-status .dot');
      if (dot) dot.className = 'dot live';
      const stat = t.querySelector('.stat');
      if (stat && !stat.textContent) {
        const kind = t.querySelector('.tag.kind')?.textContent || 'HD';
        stat.textContent = kind === 'HD' ? '1920×1080 · 15 fps · WebRTC' : '960×480 · 12 fps · WebRTC';
      }
    });

    // 2. Focus view
    const focus = document.querySelector('.focus');
    if (focus) {
      const stage = focus.querySelector('.stage');
      if (stage && !stage.querySelector('img.synthetic-feed')) {
        const img = document.createElement('img');
        img.className = 'synthetic-feed';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;pointer-events:none;';
        img.src = scenes.test1;
        stage.appendChild(img);
      }
      const veil = focus.querySelector('.veil');
      if (veil) veil.hidden = true;
      const stat = focus.querySelector('.stat');
      if (stat) stat.textContent = '1920×1080 · 15 fps · WebRTC';
      const dot = focus.querySelector('.pill .dot');
      if (dot) dot.className = 'dot live';
    }

    // 3. Playback panes
    document.querySelectorAll('.pb-pane').forEach((pane, idx) => {
      const id = pane.dataset.id || (idx === 0 ? 'test1' : idx === 1 ? 'test2' : idx === 2 ? 'test3' : 'test4');
      const canvas = pane.querySelector('canvas:not(.enh-canvas)');
      if (canvas && !canvas.dataset.syntheticPainted) {
        canvas.dataset.syntheticPainted = '1';
        const img = new Image();
        img.onload = () => {
          canvas.width = 1280; canvas.height = 720;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 1280, 720);
        };
        img.src = scenes[id] || scenes.test1;
      }
      const veil = pane.querySelector('.pb-veil');
      if (veil) veil.hidden = true;
      const time = pane.querySelector('.pb-pane-time');
      if (time) time.textContent = '07:43:31';
    });
  };

  setInterval(paint, 150);
})();
</script>"""


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

        # 1. Camera scene SVGs
        if url.path.startswith("/api/camera/") and url.path.endswith("/scene.svg"):
            cam_id = url.path.split("/")[3]
            svg_data = (SCENES.get(cam_id) or SCENE_DRIVEWAY_SVG).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(svg_data)))
            self.end_headers()
            self.wfile.write(svg_data)
            return

        # 2. Event thumbnails (rich SVGs mapped to camera scenes)
        if url.path.startswith('/api/timeline/events/') and url.path.endswith('/thumbnail'):
            ev_id = url.path.split('/')[4]
            try:
                ev_int = int(ev_id)
            except ValueError:
                ev_int = 1
            cam_id = f"test{(ev_int - 1) % 4 + 1}"
            svg_data = (SCENES.get(cam_id) or SCENE_DRIVEWAY_SVG).encode("utf-8")
            self.send_response(200)
            self.send_header('Content-Type', 'image/svg+xml')
            self.send_header('Content-Length', str(len(svg_data)))
            self.end_headers()
            self.wfile.write(svg_data)
            return

        # 3. AI Enhancer preview source and result images
        if url.path == "/api/enhance/preview/source":
            data = make_synthetic_plate_png(crisp=False)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if url.path == "/api/enhance/preview/result":
            data = make_synthetic_plate_png(crisp=True)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # 4. Timeline coverage spans
        if url.path.startswith("/api/timeline/coverage"):
            at = dt.datetime.now(dt.timezone.utc)
            days = [(at - dt.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]
            self.send_json({d: [[f"{d}T00:00:00Z", f"{d}T23:59:59Z"]] for d in days})
            return

        # 5. HTML entry pages
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
            if q.get("apple") == ["1"]:
                setup += '<script>Object.defineProperty(navigator,"userAgent",{value:"iPad",configurable:true});Object.defineProperty(navigator,"maxTouchPoints",{value:5,configurable:true});</script>'
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
            if "scene" in q or "capture" in q:
                setup += SCENE_INJECTION_SCRIPT

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

        # 6. API routes
        if url.path.startswith("/api/"):
            reference = urlparse(self.headers.get("Referer", ""))
            refq = parse_qs(reference.query)

            values = {
                "/api/auth/me": {"auth_enabled": False, "via": "none", "role": "admin", "user": None},
                "/api/settings": copy.deepcopy(S),
                "/api/status": {"go2rtc": False, "streams": {}},
                "/api/timeline/tz": {"offset_min": 330},
                "/api/timeline/events": [],
                "/api/bookmarks": [],
                "/api/timeline/calibration": {},
                "/api/playback/pool": {"busy": 0, "limit": 4},
                "/api/auth/admin/users": [],
                "/api/auth/sessions": [],
                "/api/auth/admin/sessions": [],
                "/api/auth/admin/config": {"auth_enabled": False},
                "/api/auth/admin/devices": [],
                "/api/auth/admin/audit": [],
                "/api/enhance/models": {
                    "combos": [],
                    "upscalers": [],
                    "faces": [],
                    "plates": [],
                    "text": [{"label": "Plate reader", "about": "License plates in Read text", "state": "ready"}]
                },
            }

            values["/api/settings"]["display"]["theme"] = "light" if refq.get("theme") == ["light"] else "dark"
            values["/api/settings"]["connection"]["channel_zero"] = "overview" in refq

            entry = reference.path
            if "signed" in refq:
                values["/api/auth/me"] = {
                    "auth_enabled": True, "via": "session", "role": "admin", "limited": False,
                    "session_id": "synthetic-session",
                    "user": {"id": 1, "kind": "person", "username": "Demo", "role": "admin", "has_totp": False, "avatar": {"kind": "initial", "color": "#0074e8"}}
                }
                values["/api/auth/admin/config"] = {
                    "auth_enabled": True, "require_2fa_admin": False, "bypass_cidrs": [],
                    "bypass_role": "viewer", "trusted_proxies": [], "session_hours": 12, "remember_days": 30, "warnings": []
                }
                values["/api/auth/admin/users"] = [{"id": 1, "username": "Demo", "role": "admin", "kind": "person", "has_totp": False}]
                role = refq.get("role", ["admin"])[0]
                if role in ("viewer", "operator", "admin"):
                    values["/api/auth/me"]["role"] = role
                    values["/api/auth/me"]["user"]["role"] = role
                if "device" in refq:
                    values["/api/auth/me"]["user"].update(kind="device", label="Synthetic screen")

            if "demo" in refq:
                at = dt.datetime.now(dt.timezone.utc)
                def iso(m_back, dur_s=25):
                    s = at - dt.timedelta(minutes=m_back)
                    e = s + dt.timedelta(seconds=dur_s)
                    return s.isoformat(), e.isoformat()
                values["/api/timeline/events"] = [
                    {"id": 1, "channel": 1, "kind": "motion", "start_utc": iso(8)[0], "end_utc": iso(8, 23)[1], "attrs_json": "{}"},
                    {"id": 2, "channel": 2, "kind": "intrusion", "start_utc": iso(14)[0], "end_utc": iso(14, 17)[1], "attrs_json": "{}"},
                    {"id": 3, "channel": 1, "kind": "bookmark", "start_utc": iso(25)[0], "end_utc": iso(25, 5)[1], "attrs_json": json.dumps({"note": "Delivery van at gate"})},
                    {"id": 4, "channel": 3, "kind": "line", "start_utc": iso(42)[0], "end_utc": iso(42, 38)[1], "attrs_json": "{}"},
                    {"id": 5, "channel": 4, "kind": "tamper", "start_utc": iso(58)[0], "end_utc": iso(58, 8)[1], "attrs_json": "{}"},
                    {"id": 6, "channel": 2, "kind": "motion", "start_utc": iso(75)[0], "end_utc": iso(75, 22)[1], "attrs_json": "{}"},
                    {"id": 7, "channel": 1, "kind": "motion", "start_utc": iso(95)[0], "end_utc": iso(95, 30)[1], "attrs_json": "{}"},
                    {"id": 8, "channel": 3, "kind": "line", "start_utc": iso(120)[0], "end_utc": iso(120, 20)[1], "attrs_json": "{}"},
                ]

            if url.path.startswith("/api/enhance/preview"):
                values[url.path] = {
                    "state": "done",
                    "faces_found": 0,
                    "models": {"upscaler": "Real-ESRGAN", "face": "None"},
                    "plates": [{"box": [250, 180, 390, 220], "text": "CAB 4821", "confidence": 1.0}],
                }

            if url.path == "/api/auth/me" and entry in ("/login", "/pair"):
                values[url.path] = {
                    "auth_enabled": True, "via": "session" if entry == "/pair" else "none", "role": "admin",
                    "user": {"kind": "person", "username": "synthetic"} if entry == "/pair" else None
                }

            self.send_json(values.get(url.path, {}))
            return

        if url.path == "/sw.js":
            self.send_error(404)
            return

        if url.path.startswith("/ws"):
            self.send_error(503, "No video source in the synthetic preview")
            return

        super().do_GET()

    def do_POST(self):
        global PREVIEW_IMAGE
        refq = parse_qs(urlparse(self.headers.get("Referer", "")).query)
        path = urlparse(self.path).path
        if path == "/api/auth/pair/start":
            self.send_json({"device_code": "synthetic", "user_code": "DEMO-1234", "expires_in": 600})
            return
        if path == "/api/auth/pair/poll":
            self.send_json({"status": "pending"})
            return
        if path == "/api/auth/login" and "twofactor" in refq:
            self.send_json({"totp_required": True, "challenge": "synthetic"})
            return
        if urlparse(self.path).path == "/api/enhance":
            self.send_json({"job_id": "preview"})
            return
        if path == "/api/enhance/preview/ocr":
            import base64
            crop_png = make_synthetic_plate_crop_png()
            self.send_json({
                "lines": [{"text": "CAB 4821", "confidence": 100.0}],
                "crop": "data:image/png;base64," + base64.b64encode(crop_png).decode("ascii"),
                "engine": "plate"
            })
            return
        self.send_json({"detail": "Synthetic preview: no jobs or writes"}, 503)

    do_PUT = do_POST
    do_DELETE = do_POST


class PreviewServer(ThreadingHTTPServer):
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
