"""Zoom/pan checks (mouse wheel, ctrl+wheel pinch, Safari gesture events, touch pinch, drag, double-click, buttons, keys)."""
import asyncio, sys
sys.path.insert(0, "tools")
from cdp import Browser
BASE, SHOT = sys.argv[1].rstrip("/"), sys.argv[2]
res = []
def check(n, ok, x=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + n + (f"  [{x}]" if x else ""))
ST = "(sel)=>{const st=document.querySelector(sel+' .stage');const g=n=>parseFloat(st.style.getPropertyValue(n));return {s:g('--zs')||1,x:g('--zx')||0,y:g('--zy')||0}}"
async def st(b, sel): return await b.js(f"({ST})('{sel}')")
async def wheel(b, x, y, dy, mod=0):
    await b.send("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y, deltaX=0, deltaY=dy, modifiers=mod)
async def main():
    async with Browser() as b:
        # ---------- grid tile
        await b.goto(BASE + "/#/live"); await b.wait_for("document.querySelectorAll('.wall .tile:not(.empty) video').length>0", 30)
        await asyncio.sleep(2)
        r = await b.js("(()=>{const r=document.querySelector('.wall .tile:not(.empty)').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        cx, cy = r; T = ".wall .tile:not(.empty)"
        await wheel(b, cx, cy, -300); await asyncio.sleep(0.3)
        s1 = await st(b, T); check("grid: mouse wheel zooms in", s1["s"] > 1.3, f"{s1['s']:.2f}x")
        await wheel(b, cx, cy, 200); await asyncio.sleep(0.2)
        s2 = await st(b, T); check("grid: wheel back zooms out", s2["s"] < s1["s"])
        await wheel(b, cx, cy, -900, 2); await asyncio.sleep(0.3)   # ctrl+wheel = pinch on Chrome/Firefox trackpads
        s3 = await st(b, T); check("grid: ctrl+wheel (trackpad pinch) zooms", s3["s"] > s2["s"] + 0.5, f"{s3['s']:.2f}x")
        # drag pans
        await b.send("Input.dispatchMouseEvent", type="mousePressed", x=cx, y=cy, button="left", clickCount=1)
        for i in range(1, 9): await b.send("Input.dispatchMouseEvent", type="mouseMoved", x=cx - 8 * i, y=cy - 4 * i, button="left")
        await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=cx - 64, y=cy - 32, button="left", clickCount=1)
        await asyncio.sleep(0.3)
        s4 = await st(b, T); check("grid: dragging pans the zoomed picture", abs(s4["x"] - s3["x"]) > 20 or abs(s4["y"] - s3["y"]) > 10, f"dx={s4['x']-s3['x']:.0f} dy={s4['y']-s3['y']:.0f}")
        check("grid: a drag does not open the large view", await b.js("!document.querySelector('.focus')") and (await b.js("location.hash")) == "#/live")
        check("zoom tag visible with reset", await b.js("!document.querySelector('.tile .zoomtag').hidden"))
        # the reset button must be the topmost thing at its position, both while hovering the tile and when not
        top = "(()=>{const t=document.querySelector('.tile .zoomtag');const r=t.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===t})()"
        await b.send("Input.dispatchMouseEvent", type="mouseMoved", x=cx, y=cy); await asyncio.sleep(0.3)
        check("reset button is clickable while hovering the tile", await b.js(top))
        await b.send("Input.dispatchMouseEvent", type="mouseMoved", x=700, y=800); await asyncio.sleep(0.3)
        check("reset button is clickable when not hovering", await b.js(top))
        check("reset button is labelled", "Reset" in await b.js("document.querySelector('.tile .zoomtag').textContent"))
        await b.shot(f"{SHOT}/zoom_grid.png")
        await b.js("document.querySelector('.tile .zoomtag').click()"); await asyncio.sleep(0.5)
        s5 = await st(b, T); check("grid: reset returns to 1x and centered", s5["s"] == 1 and s5["x"] == 0 and s5["y"] == 0)
        await b.js("document.querySelector('.tile [data-a=zin]').click()"); await asyncio.sleep(0.4)
        check("grid: + button zooms", (await st(b, T))["s"] > 1.4)
        await b.js("document.querySelector('.tile [data-a=zout]').click()"); await asyncio.sleep(0.4)
        check("grid: - button zooms out", (await st(b, T))["s"] == 1)
        # Safari gesture events (not constructible natively in Chrome: dispatch look-alikes)
        await b.js(f"""(()=>{{const h=document.querySelector('.tile .hit');const mk=(t,sc)=>Object.assign(new Event(t,{{bubbles:true,cancelable:true}}),{{scale:sc,clientX:{cx},clientY:{cy}}});
            h.dispatchEvent(mk('gesturestart',1));h.dispatchEvent(mk('gesturechange',2.2));}})()""")
        await asyncio.sleep(0.3)
        sg = await st(b, T); check("grid: Safari gesture pinch zooms", 2.0 < sg["s"] < 2.4, f"{sg['s']:.2f}x")
        await b.js("document.querySelector('.tile .zoomtag').click()"); await asyncio.sleep(0.4)
        # plain click still opens the large view
        await b.send("Input.dispatchMouseEvent", type="mousePressed", x=cx, y=cy, button="left", clickCount=1)
        await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=cx, y=cy, button="left", clickCount=1)
        check("grid: a plain click still opens the large view", await b.wait_for("document.querySelector('.focus')", 5))
        # ---------- large view
        await b.wait_for("document.querySelector('.focus video')?.videoWidth>0", 30); await asyncio.sleep(1)
        F = ".focus"
        r = await b.js("(()=>{const r=document.querySelector('.hitzone').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,r.width,r.height]})()")
        fx, fy = r[0], r[1]
        await wheel(b, fx, fy, -400); await asyncio.sleep(0.3)
        f1 = await st(b, F); check("focus: wheel zooms", f1["s"] > 1.4, f"{f1['s']:.2f}x")
        check("focus: percent readout updates", (await b.js("document.querySelector('.focus .pct').textContent")) == f"{round(f1['s']*100)}%")
        # zoom keeps the point under the cursor fixed: zoom on the right side, picture should shift left
        await b.js("document.querySelector('.focus [data-a=zreset]').click()"); await asyncio.sleep(0.4)
        await wheel(b, fx + 300, fy, -500); await asyncio.sleep(0.3)
        f2 = await st(b, F); check("focus: zooms toward the cursor (picture shifts opposite)", f2["x"] < -40, f"x={f2['x']:.0f}")
        # pan limits: cannot drag the picture away
        await b.send("Input.dispatchMouseEvent", type="mousePressed", x=fx, y=fy, button="left", clickCount=1)
        for i in range(1, 30): await b.send("Input.dispatchMouseEvent", type="mouseMoved", x=fx + 60 * i, y=fy, button="left")
        await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=fx + 1800, y=fy, button="left", clickCount=1)
        f3 = await st(b, F)
        lim = await b.js("(()=>{const p=document.querySelector('.focus cam-player'),s=document.querySelector('.focus .stage');return (p.offsetWidth*%s - s.clientWidth)/2})()" % f3["s"])
        check("focus: panning is clamped to the picture edge", f3["x"] <= lim + 1, f"x={f3['x']:.0f} limit={lim:.0f}")
        # touch pinch
        await b.js("document.querySelector('.focus [data-a=zreset]').click()"); await asyncio.sleep(0.4)
        async def touch(t, pts): await b.send("Input.dispatchTouchEvent", type=t, touchPoints=[{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)])
        await touch("touchStart", [(fx - 40, fy), (fx + 40, fy)])
        for k in range(1, 12): await touch("touchMove", [(fx - 40 - 12 * k, fy), (fx + 40 + 12 * k, fy)])
        await touch("touchEnd", []); await asyncio.sleep(0.3)
        ft = await st(b, F); check("focus: two-finger touch pinch zooms in", ft["s"] > 1.8, f"{ft['s']:.2f}x")
        await touch("touchStart", [(fx, fy)])
        for k in range(1, 10): await touch("touchMove", [(fx - 10 * k, fy)])
        await touch("touchEnd", []); await asyncio.sleep(0.3)
        ft2 = await st(b, F); check("focus: one-finger drag pans", abs(ft2["x"] - ft["x"]) > 20, f"dx={ft2['x']-ft['x']:.0f}")
        # keys + double click
        await b.js("document.querySelector('.focus [data-a=zreset]').click()"); await asyncio.sleep(0.4)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'+'}))"); await asyncio.sleep(0.4)
        check("focus: + key zooms", (await st(b, F))["s"] > 1.4)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'0'}))"); await asyncio.sleep(0.4)
        check("focus: 0 key resets", (await st(b, F))["s"] == 1)
        for _ in range(2):
            await b.send("Input.dispatchMouseEvent", type="mousePressed", x=fx, y=fy, button="left", clickCount=1)
            await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=fx, y=fy, button="left", clickCount=1)
            await asyncio.sleep(0.08)
        await asyncio.sleep(0.4)
        d1 = await st(b, F); check("focus: double click zooms in", d1["s"] > 2.0, f"{d1['s']:.2f}x")
        vid_playing = await b.js("(()=>{const v=document.querySelector('.focus video');return !v.paused&&v.currentTime>0})()")
        check("zooming never pauses the video", vid_playing)
        await b.shot(f"{SHOT}/zoom_focus.png")
        for _ in range(2):
            await b.send("Input.dispatchMouseEvent", type="mousePressed", x=fx, y=fy, button="left", clickCount=1)
            await b.send("Input.dispatchMouseEvent", type="mouseReleased", x=fx, y=fy, button="left", clickCount=1)
            await asyncio.sleep(0.08)
        await asyncio.sleep(0.4)
        check("focus: double click again resets", (await st(b, F))["s"] == 1)
        await b.js("document.querySelector('.focus [data-a=zin]').click()"); await asyncio.sleep(0.4)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await asyncio.sleep(0.5)
        check("Esc resets zoom first, then closes", await b.js("!!document.querySelector('.focus')") and (await st(b, F))["s"] == 1)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await asyncio.sleep(0.6)
        check("second Esc closes the large view", await b.js("!document.querySelector('.focus')"))
        probs = [l for l in b.logs if "favicon" not in l]
        check("no console errors", not probs, "; ".join(probs)[:200])
    print(f"\n{sum(res)}/{len(res)} zoom checks passed"); sys.exit(0 if all(res) else 1)
asyncio.run(main())
