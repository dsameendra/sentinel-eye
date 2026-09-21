"""End-to-end UI check. Usage: e2e_ui.py BASE_URL SHOT_DIR   (run against a scratch instance, it edits settings)."""
import asyncio, json, sys, urllib.request
sys.path.insert(0, "tools")
from cdp import Browser

BASE, SHOT = sys.argv[1].rstrip("/"), sys.argv[2]
results = []

def check(name, ok, extra=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))

def api(path, method="GET", body=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))

PLAYING = "[...document.querySelectorAll('.wall .tile:not(.empty) video')].filter(v=>v.readyState>=2&&v.currentTime>0&&!v.paused).length"
TILES = "document.querySelectorAll('.wall .tile:not(.empty)').length"
NAMES = "[...document.querySelectorAll('.wall .tile:not(.empty) .name')].map(e=>e.textContent).join(',')"
SET = "(sel,val)=>{const e=document.querySelector(sel);e.value=val;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}"
DRAG = """(a,b)=>{const f=document.querySelector(`.tile[data-id=${a}]`),t=document.querySelector(`.tile[data-id=${b}]`);const dt=new DataTransfer();
 f.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));t.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
 t.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));f.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}))}"""

async def main():
    async with Browser() as b:
        await b.goto(BASE + "/#/live")
        await b.wait_for(f"{TILES} > 0", 20)
        n = await b.js(TILES)
        await b.wait_for(f"{PLAYING} >= {n}", 40)
        check("live: all tiles play", await b.js(PLAYING) == n and n > 0, f"{await b.js(PLAYING)}/{n}")
        await b.shot(f"{SHOT}/ui_live_3x3.png")

        # ---- layouts
        async def layout(lid):
            await b.js("document.querySelector('[data-a=layout]').click()")
            await b.js(f"document.querySelector('[data-l=\"{lid}\"]').click()")
            await asyncio.sleep(0.8)
        await layout("1+5")
        cells = await b.js("document.querySelectorAll('.wall > .tile').length")
        check("layout 1+5 has 6 cells", cells == 6, str(cells))
        big = await b.js("(()=>{const t=document.querySelector('.wall > .tile');return t.style.gridColumn+'|'+t.style.gridRow})()")
        check("1+5 big cell spans 2x2", "span 2" in big and big.count("span 2") == 2, big)
        await b.wait_for(f"{PLAYING} >= {n}", 40)
        await asyncio.sleep(8)   # let the big tile upgrade to HD
        kinds = await b.js("[...document.querySelectorAll('.wall .tile:not(.empty) .kind')].map(e=>e.textContent).join(',')")
        check("auto quality: big tile HD, small tiles SD", kinds.split(",")[0] == "HD" and set(kinds.split(",")[1:]) <= {"SD"}, kinds)
        await b.shot(f"{SHOT}/ui_live_1plus5.png")
        check("layout persisted on server", api("/api/settings")["display"]["layout"] == "1+5")

        await layout("1x1")
        pager = await b.js("document.querySelector('.pager span')?.textContent")
        check("1x1: 3 pages", pager and pager.strip() == "1 / 3", pager)
        nm1 = await b.js(NAMES)
        await b.js("document.querySelector('[data-a=next]').click()"); await asyncio.sleep(0.6)
        nm2 = await b.js(NAMES)
        check("next page shows another camera", nm1 != nm2, f"{nm1} -> {nm2}")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}))"); await asyncio.sleep(0.6)
        check("arrow key goes back a page", await b.js(NAMES) == nm1)

        # ---- arrange (drag & drop)
        await layout("3x3")
        await b.wait_for(f"{PLAYING} >= {n}", 30)
        before = api("/api/settings")["display"]["order"]
        await b.js("document.querySelector('[data-a=edit]').click()")
        check("arrange mode on", await b.js("document.querySelector('.wall').classList.contains('editing')"))
        await b.js(f"({DRAG})('{before[0]}','{before[2]}')")
        await asyncio.sleep(1.2)
        after = api("/api/settings")["display"]["order"]
        check("drag reorders and saves", after == [before[1], before[2], before[0]], f"{before} -> {after}")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
        check("Esc leaves arrange mode", not await b.js("document.querySelector('.wall').classList.contains('editing')"))
        api("/api/display", "PUT", {**api("/api/settings")["display"], "order": before})   # restore

        # ---- focus view
        await b.js("location.reload()"); await b.wait_for(f"{PLAYING} >= {n}", 40)
        await b.js("document.querySelector('.wall .tile .hit').click()")
        opened = await b.wait_for("document.querySelector('.focus')", 8)
        hsh = await b.js("location.hash")
        check("click tile opens large view", opened and "/live/" in hsh, f"focus={opened} hash={hsh}")
        if not opened:
            print("   DEBUG logs:", b.logs[-5:])
            print("   DEBUG dom:", await b.js("JSON.stringify({wallKids:document.querySelector('.wall')?.children.length,liveHTML:document.querySelector('#view')?.innerHTML.slice(0,200),focusCount:document.querySelectorAll('.focus').length})"))
        first = await b.wait_for("(()=>{const v=document.querySelector('.focus video');return v&&v.readyState>=2&&v.currentTime>0})()", 10)
        check("large view shows a picture immediately (SD first)", first)
        ok = await b.wait_for("(()=>{const v=document.querySelector('.focus video');return v&&v.videoWidth>=1280})()", 40)
        check("large view plays (HD)", ok, await b.js("(()=>{const v=document.querySelector('.focus video');return v?v.videoWidth+'x'+v.videoHeight:'-'})()"))
        box = await b.js("(()=>{const v=document.querySelector('.focus video').getBoundingClientRect();return [v.width,v.height]})()")
        check("large view video is actually visible (big on screen)", box[0] > 600 and box[1] > 300, str(box))
        t0 = await b.js("document.querySelector('.focus video').currentTime")
        await b.send("Input.dispatchMouseEvent", type="mousePressed", x=700, y=450, button="left", clickCount=1)
        await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=700, y=450, button="left", clickCount=1)
        await asyncio.sleep(2)
        r = await b.js("(()=>{const v=document.querySelector('.focus video');return [v.paused,v.currentTime]})()")
        check("clicking the video does NOT pause it", r[0] is False and r[1] - t0 > 1.0, f"paused={r[0]} advanced={r[1]-t0:.1f}s")
        nm = await b.js("document.querySelector('.focus h2').textContent")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))"); await asyncio.sleep(1.5)
        check("→ opens next camera", await b.js("document.querySelector('.focus h2').textContent") != nm)
        await b.js("document.querySelector('.focus [data-k=sub]').click()")
        await b.wait_for("document.querySelector('.focus .stat').textContent.includes('960')", 20)
        check("SD toggle switches stream", "960" in await b.js("document.querySelector('.focus .stat').textContent"), await b.js("document.querySelector('.focus .stat').textContent"))
        sd_box = await b.js("(()=>{const r=document.querySelector('.focus video').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()")
        await b.js("document.querySelector('.focus [data-k=main]').click()")
        await b.wait_for("document.querySelector('.focus video')?.videoWidth>=1280", 40); await asyncio.sleep(1)
        hd_box = await b.js("(()=>{const r=document.querySelector('.focus video').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()")
        check("SD and HD are shown in the same shape (no stretch on switch)", abs(sd_box[0]-hd_box[0]) <= 2 and abs(sd_box[1]-hd_box[1]) <= 2, f"SD {sd_box} HD {hd_box}")
        await b.shot(f"{SHOT}/ui_focus.png")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await asyncio.sleep(1)
        check("Esc closes large view", await b.js("!document.querySelector('.focus')") and (await b.js("location.hash")) == "#/live")

        # ---- settings: connection
        await b.js("location.hash='#/settings/connection'"); await asyncio.sleep(0.8)
        check("key disabled while encryption off", await b.js("document.querySelector('#f-key').disabled"))
        await b.js("document.querySelector('[data-b=\"connection.encrypted\"]').click()"); await asyncio.sleep(0.3)
        check("toggle on enables the code field", not await b.js("document.querySelector('#f-key').disabled"))
        check("save blocked without a code", await b.js("!!document.querySelector('#save')?.disabled") and "Enter the verification code" in await b.js("document.querySelector('[data-err=\"connection.key\"]').textContent"))
        await b.js(f"({SET})('#f-key','abc123')"); await asyncio.sleep(0.2)
        check("code accepted", await b.js("!document.querySelector('#save')?.disabled"))
        await b.js("document.querySelector('[data-b=\"connection.encrypted\"]').click()"); await asyncio.sleep(0.3)
        check("toggle off disables the code field again", await b.js("document.querySelector('#f-key').disabled"))
        await b.js(f"({SET})('#f-host','http://bad host')"); await asyncio.sleep(0.2)
        check("host validation", "no http" in (await b.js("document.querySelector('[data-err=\"connection.host\"]').textContent")).lower() or "address" in (await b.js("document.querySelector('[data-err=\"connection.host\"]').textContent")).lower())
        await b.js(f"({SET})('#f-host','127.0.0.1')"); await b.js(f"({SET})('#f-port','70000')"); await asyncio.sleep(0.2)
        check("port validation", await b.js("!document.querySelector('[data-err=\"connection.rtsp_port\"]').hidden"))
        await b.js(f"({SET})('#f-port','8654')"); await asyncio.sleep(0.2)
        await b.shot(f"{SHOT}/ui_settings_connection.png")
        await b.js("document.querySelector('#discard').click()"); await asyncio.sleep(0.4)
        check("discard resets the form", await b.js("document.querySelector('#f-host').value") == "127.0.0.1" and await b.js("document.querySelector('.savebar').hidden"))
        await b.js("document.querySelector('#t-run').click()")
        await b.wait_for("document.querySelector('.result')", 30)
        res = await b.js("document.querySelector('.result')?.textContent")
        check("test connection reports the stream", res and "readable" in res.lower(), (res or "")[:80])
        await b.shot(f"{SHOT}/ui_settings_test.png")

        # ---- settings: channels
        await b.js("location.hash='#/settings/channels'"); await asyncio.sleep(0.8)
        rows = await b.js("document.querySelectorAll('tr[data-row]').length")
        await b.js("document.querySelector('#add-ch').click()"); await asyncio.sleep(0.4)
        check("add channel adds a row", await b.js("document.querySelectorAll('tr[data-row]').length") == rows + 1)
        newrow = await b.js("[...document.querySelectorAll('tr[data-row]')].pop().dataset.row")
        await b.js(f"({SET})('[data-b=\"ch.{newrow}.sub_fps\"]','abc')"); await asyncio.sleep(0.2)
        check("fps validation", await b.js("!!document.querySelector('#save').disabled"))
        await b.js(f"({SET})('[data-b=\"ch.{newrow}.sub_fps\"]','7.5')"); await asyncio.sleep(0.2)
        check("fps override accepted", not await b.js("document.querySelector('#save').disabled"))
        await b.js(f"document.querySelector('[data-del=\"{newrow}\"]').click()"); await asyncio.sleep(0.4)
        check("delete asks for confirmation", await b.js("!!document.querySelector('.dialog')"))
        await b.js("document.querySelector('[data-x=\"1\"]').click()"); await asyncio.sleep(0.4)
        check("confirmed delete removes the row", await b.js("document.querySelectorAll('tr[data-row]').length") == rows)
        await b.js("document.querySelector('#detect').click()"); await b.wait_for("document.querySelector('.result')", 30)
        check("detect channels reports a result", await b.js("!!document.querySelector('.result')"))
        await b.js("document.querySelector('[data-test=\"t1\"]').click()")
        await b.wait_for("document.querySelector('.rowtest')", 40)
        rt = await b.js("document.querySelector('.rowtest')?.textContent") or ""
        check("per-channel test shows SD and HD info", "SD" in rt and "HD" in rt and "fps" in rt, rt.strip()[:100])
        # rename + save + persist
        await b.js(f"({SET})('[data-b=\"ch.t1.name\"]','Renamed cam')"); await asyncio.sleep(0.2)
        await b.js("document.querySelector('#save').click()")
        await b.wait_for("document.querySelector('.toast')", 20)
        await asyncio.sleep(6)
        check("save persists to server", api("/api/settings")["channels"][0]["name"] == "Renamed cam")
        await b.shot(f"{SHOT}/ui_settings_channels.png")

        # ---- display + status
        await b.js("location.hash='#/settings/display'"); await asyncio.sleep(0.6)
        await b.js("document.querySelector('[data-o=\"theme:light\"]').click()"); await asyncio.sleep(0.3)
        check("theme previews immediately", await b.js("document.documentElement.dataset.theme") == "light")
        await b.shot(f"{SHOT}/ui_settings_display_light.png")
        await b.js("document.querySelector('#discard').click()"); await asyncio.sleep(0.3)
        check("discard reverts the theme", await b.js("document.documentElement.dataset.theme") is None)
        await b.js("location.hash='#/settings/status'"); await asyncio.sleep(1.5)
        check("status tab lists streams", await b.js("document.querySelectorAll('#status-card tbody tr').length") >= 3)
        # leaving with unsaved changes asks first
        await b.js("location.hash='#/settings/connection'"); await asyncio.sleep(0.5)
        await b.js(f"({SET})('#f-user','someone')"); await asyncio.sleep(0.2)
        await b.js("location.hash='#/live'"); await asyncio.sleep(0.6)
        check("leaving with unsaved edits asks first", await b.js("!!document.querySelector('.dialog')"))
        await b.js("document.querySelector('[data-x=\"0\"]').click()"); await asyncio.sleep(0.5)
        check("cancel stays in settings", "settings" in await b.js("location.hash"))
        api("/api/settings")  # sanity
        probs = [l for l in b.logs if "favicon" not in l and "Video error" not in l]
        check("no console errors", not probs, "; ".join(probs)[:200])
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
