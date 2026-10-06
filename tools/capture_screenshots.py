"""Automated screenshot capture pipeline for Sentinel Eye.

Generates 14 showcase screenshots across Desktop, TV, iPad, and iPhone form factors
using purely synthetic vector camera feeds. Zero real footage, zero network requests,
zero writes to persistent configuration.

Usage:
    .venv/bin/python3 tools/capture_screenshots.py
"""
import asyncio
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from cdp import Browser

SCREENSHOTS_DIR = ROOT / "docs" / "screenshots"
PORT = 8083
BASE_URL = f"http://127.0.0.1:{PORT}"

SPECS = [
    {
        "name": "live-grid.jpg",
        "url": f"{BASE_URL}/?signed=1&capture=1&scene=1#/live",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".wall .tile:not(.empty) img.synthetic-feed",
        "wait_sec": 1.6,
    },
    {
        "name": "focus.jpg",
        "url": f"{BASE_URL}/?signed=1&capture=1&scene=1#/live/test1",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".focus img.synthetic-feed",
        "wait_sec": 1.6,
    },
    {
        "name": "playback.jpg",
        "url": f"{BASE_URL}/?signed=1&demo=1&capture=1&scene=1#/playback/test1,test2/1791142902",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".pb-pane canvas[data-synthetic-painted]",
        "wait_sec": 1.8,
    },
    {
        "name": "events.jpg",
        "url": f"{BASE_URL}/?signed=1&demo=1&capture=1#/events",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".ev-card .ev-thumb img",
        "wait_sec": 1.6,
    },
    {
        "name": "light-events.jpg",
        "url": f"{BASE_URL}/?signed=1&demo=1&capture=1&theme=light#/events",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".ev-card .ev-thumb img",
        "wait_sec": 1.6,
    },
    {
        "name": "enhancer.jpg",
        "url": f"{BASE_URL}/?screen=enhancer&capture=1&demo=1#/playback",
        "width": 1440, "height": 900, "mobile": False,
        "ready": ".enh2-ocrcrop img",
        "wait_sec": 2.5,
    },
    {
        "name": "settings.jpg",
        "url": f"{BASE_URL}/?signed=1&capture=1#/settings/display",
        "width": 1440, "height": 900, "mobile": False,
        "ready": "#view .layout-grid",
        "wait_sec": 1.4,
    },
    {
        "name": "tv-mode.jpg",
        "url": f"{BASE_URL}/?tv=1&overview=1&signed=1&capture=1&scene=1#/live",
        "width": 1920, "height": 1080, "mobile": False,
        "ready": "html.tv-mode .overview-tile img.synthetic-feed",
        "post_js": """
            document.querySelector('.liveview')?.classList.add('immersive');
            document.querySelector('.liveview')?.classList.add('tv-awake');
            const fsBtn = document.querySelector('[data-a=tvfs]');
            if (fsBtn) {
                fsBtn.setAttribute('aria-label', 'Exit full screen');
                fsBtn.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M4 14h6v6m10-10h-6V4m0 6l7-7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Exit full screen</span>';
            }
            document.querySelector('.tv-nav [href="#/playback"]')?.focus();
        """,
        "wait_sec": 1.8,
    },
    {
        "name": "mobile-live.jpg",
        "url": f"{BASE_URL}/?pwa=1&apple=1&top=59&bottom=34&signed=1&capture=1&scene=1#/live",
        "width": 390, "height": 844, "mobile": True,
        "ready": ".wall .tile img.synthetic-feed",
        "crop_top": 59,
        "wait_sec": 1.5,
    },
    {
        "name": "phone-landscape-playback.jpg",
        "url": f"{BASE_URL}/?pwa=1&apple=1&bottom=12&signed=1&demo=1&capture=1&scene=1#/playback",
        "width": 844, "height": 390, "mobile": True,
        "ready": ".pb-pane canvas[data-synthetic-painted]",
        "wait_sec": 1.8,
    },
    {
        "name": "ipad-playback.jpg",
        "url": f"{BASE_URL}/?pwa=1&apple=1&top=24&bottom=20&signed=1&demo=1&capture=1&scene=1#/playback",
        "width": 1180, "height": 820, "mobile": True,
        "ready": ".pb-pane canvas[data-synthetic-painted]",
        "crop_top": 24,
        "wait_sec": 1.8,
    },
    {
        "name": "mobile-settings.jpg",
        "url": f"{BASE_URL}/?pwa=1&apple=1&top=59&bottom=34&signed=1&capture=1#/settings",
        "width": 390, "height": 844, "mobile": True,
        "ready": "#view .settings-section",
        "crop_top": 59,
        "wait_sec": 1.2,
    },
    {
        "name": "login-phone.jpg",
        "url": f"{BASE_URL}/login?pwa=1&apple=1&top=59&bottom=34&capture=1",
        "width": 390, "height": 844, "mobile": True,
        "ready": "form.login-card",
        "wait_sec": 1.2,
    },
    {
        "name": "export-landscape.jpg",
        "url": f"{BASE_URL}/?pwa=1&apple=1&bottom=12&screen=export&capture=1&signed=1#/playback",
        "width": 844, "height": 390, "mobile": True,
        "ready": ".export-dialog",
        "wait_sec": 1.5,
    },
]


async def capture_one(spec):
    name = spec["name"]
    print(f"Capturing {name:30} ({spec['width']}x{spec['height']})...", end="", flush=True)
    out_path = SCREENSHOTS_DIR / name

    async with Browser(width=spec["width"], height=spec["height"]) as b:
        await b.send(
            "Emulation.setDeviceMetricsOverride",
            width=spec["width"],
            height=spec["height"],
            deviceScaleFactor=1.0,
            mobile=spec["mobile"],
        )
        await b.goto(spec["url"])

        # Wait for ready selector
        ready_sel = spec["ready"]
        ok = await b.wait_for(f"document.querySelector('{ready_sel}')", timeout=12)
        if not ok:
            print(f" [WARN: selector '{ready_sel}' timeout, capturing anyway]", end="", flush=True)

        if spec.get("post_js"):
            try:
                await b.js(spec["post_js"])
            except Exception as e:
                pass

        await asyncio.sleep(spec["wait_sec"])

        # Capture PNG via CDP
        r = await b.send("Page.captureScreenshot", format="png")
        import base64
        raw_png = base64.b64decode(r["data"])

        # Convert to progressive JPEG using Pillow
        im = Image.open(io.BytesIO(raw_png)).convert("RGB")
        if spec.get("crop_top"):
            cy = spec["crop_top"]
            im = im.crop((0, cy, im.width, im.height))
        im.save(out_path, "JPEG", quality=86, optimize=True, progressive=True)

    size_kb = out_path.stat().st_size / 1024
    print(f" Done ({size_kb:.1f} KB)")


def start_preview_server():
    cmd = [sys.executable, str(ROOT / "tools" / "pwa_preview.py"), "--port", str(PORT)]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        try:
            urllib.request.urlopen(f"{BASE_URL}/api/settings", timeout=1)
            return p
        except Exception:
            time.sleep(0.2)
    p.kill()
    raise RuntimeError(f"Failed to start preview server on port {PORT}")


async def main():
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    server_proc = start_preview_server()
    print(f"Preview server started on {BASE_URL}")

    try:
        for spec in SPECS:
            await capture_one(spec)
    finally:
        server_proc.kill()
        print("Preview server stopped.")

    print("\n--- Screenshot Asset Summary ---")
    total_bytes = 0
    for spec in SPECS:
        f = SCREENSHOTS_DIR / spec["name"]
        sz = f.stat().st_size
        total_bytes += sz
        im = Image.open(f)
        print(f"  {spec['name']:30} {im.size[0]:4}x{im.size[1]:4}  {sz/1024:6.1f} KB")
    print(f"Total size: {total_bytes / (1024 * 1024):.2f} MB")


if __name__ == "__main__":
    asyncio.run(main())
