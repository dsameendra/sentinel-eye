import asyncio, sys, json
sys.path.insert(0, "tools")
from cdp import Browser
S = sys.argv[1]
URL = "http://127.0.0.1:8080/"
PLAYING = "[...document.querySelectorAll('.wall .tile:not(.empty) video')].filter(v=>v.readyState>=2&&v.currentTime>0&&!v.paused).length"

async def main():
    async with Browser() as b:
        await b.goto(URL)
        ok = await b.wait_for(f"{PLAYING} >= 8", 40)
        print("grid: tiles playing =", await b.js(PLAYING), "of", await b.js("document.querySelectorAll('.wall .tile:not(.empty)').length"))
        await b.shot(f"{S}/e2e_grid.png")
        print("qualities:", await b.js("[...document.querySelectorAll('.wall .tile .kind')].map(e=>e.textContent).join(',')"))
        # --- focus view: click a tile, expect HD, then click video and verify it does not pause
        await b.js("document.querySelector('.wall .tile .hit').click()")
        await b.wait_for("document.querySelector('.focus')", 5)
        print("focus open:", await b.js("!!document.querySelector('.focus')"), "hash", await b.js("location.hash"))
        t_pic = __import__("time").time()
        await b.wait_for("(()=>{const v=document.querySelector('.focus video');return v&&v.readyState>=2&&v.currentTime>0&&v.videoWidth>0})()", 30)
        print("first picture after %.1fs" % (__import__("time").time() - t_pic))
        await b.wait_for("(()=>{const v=document.querySelector('.focus video');return v&&v.videoWidth>=1280})()", 40)
        print("focus video:", await b.js("(()=>{const v=document.querySelector('.focus video');return v?v.videoWidth+'x'+v.videoHeight+' t='+v.currentTime.toFixed(1):'none'})()"))
        await asyncio.sleep(2)
        await b.shot(f"{S}/e2e_focus.png")
        box = await b.js("(()=>{const v=document.querySelector('.focus video').getBoundingClientRect();return [Math.round(v.width),Math.round(v.height)]})()")
        print("focus video on screen:", box, "(must be large)"); assert box[0] > 600 and box[1] > 300, "large view video is not visible"
        t0 = await b.js("document.querySelector('.focus video').currentTime")
        # real mouse click in the middle of the picture
        await b.send("Input.dispatchMouseEvent", type="mousePressed", x=720, y=450, button="left", clickCount=1)
        await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=720, y=450, button="left", clickCount=1)
        await asyncio.sleep(2)
        r = await b.js("(()=>{const v=document.querySelector('.focus video');return {paused:v.paused,t:v.currentTime}})()")
        print("after click: paused =", r["paused"], "advanced =", round(r["t"] - t0, 1), "s  (must be false / ~2s)")
        print("console problems:", [l for l in b.logs if 'favicon' not in l][:8])

asyncio.run(main())
