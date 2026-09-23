"""Stress the REAL recorder: Always-HD on big layouts. Restores the previous display settings afterwards."""
import asyncio, json, subprocess, sys, time, urllib.request
sys.path.insert(0, "tools")
from cdp import Browser
BASE = "http://127.0.0.1:8007"
def api(path, method="GET", body=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))
PLAYING = "[...document.querySelectorAll('.wall .tile:not(.empty) video')].filter(v=>v.readyState>=2&&v.currentTime>0&&!v.paused).length"
HDKINDS = "[...document.querySelectorAll('.wall .tile:not(.empty) .kind')].filter(e=>e.textContent==='HD').length"

def cpu():
    out = subprocess.run("top -l 2 -n 12 -o cpu -stats command,cpu | tail -13", shell=True, capture_output=True, text=True).stdout
    return " | ".join(l.strip() for l in out.splitlines()[1:8])

async def scenario(b, layout, quality, secs):
    d = api("/api/settings")["display"]
    api("/api/display", "PUT", {**d, "layout": layout, "quality": quality})
    await b.goto(BASE + "/#/live"); await b.js("location.reload()")
    await b.wait_for("document.querySelectorAll('.wall .tile:not(.empty)').length>0", 20)
    n = await b.js("document.querySelectorAll('.wall .tile:not(.empty)').length")
    t0 = time.time(); first_all = None; worst = n
    while time.time() - t0 < secs:
        p = await b.js(PLAYING)
        if p >= n and first_all is None: first_all = time.time() - t0
        if first_all is not None: worst = min(worst, p)
        await asyncio.sleep(2)
    hd = await b.js(HDKINDS)
    st = api("/api/status")["streams"]
    prod = {k: v["consumers"] for k, v in st.items() if v["consumers"] and "_main" in k}
    print(f"[{layout} / {quality}] tiles={n} playing={await b.js(PLAYING)} HD-tagged={hd} first-all-playing={'%.0fs' % first_all if first_all else 'NEVER'} min-playing-after={worst}")
    print("   HD streams with viewers:", len(prod), "| CPU:", cpu())

async def main():
    saved = api("/api/settings")["display"]
    try:
        async with Browser() as b:
            for layout, quality, secs in [("3x3", "main", 60), ("2+8", "auto", 45), ("1+7", "auto", 40)]:
                await scenario(b, layout, quality, secs)
            print("console problems:", [l for l in b.logs if "favicon" not in l][:5])
    finally:
        api("/api/display", "PUT", saved)
        print("display settings restored:", saved["layout"], saved["quality"])
    log = open("data/go2rtc.log").read().splitlines()[-400:]
    bad = [l for l in log if "i/o timeout" in l or " ERR " in l]
    print("go2rtc timeouts/errors during test:", len(bad)); [print("  ", l[:170]) for l in bad[-4:]]
asyncio.run(main())
