"""Drive headless Chrome via CDP: load the dashboard, wait, report each <video>'s playback state."""
import asyncio, json, subprocess, sys, time, urllib.request, base64, tempfile
import websockets
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:1984/"
WAIT = int(sys.argv[2]) if len(sys.argv) > 2 else 15
SHOT = sys.argv[3] if len(sys.argv) > 3 else "shot.png"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
prof = tempfile.mkdtemp()
p = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9333", f"--user-data-dir={prof}",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1400,800", "--no-first-run", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json")); break
        except Exception: time.sleep(0.3)
    ws_url = [t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"]
    async def main():
        async with websockets.connect(ws_url, max_size=50_000_000) as ws:
            n = 0; logs = []
            async def call(m, **params):
                nonlocal n; n += 1; i = n
                await ws.send(json.dumps({"id": i, "method": m, "params": params}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == i: return msg.get("result")
                    if msg.get("method") == "Runtime.consoleAPICalled":
                        logs.append(" ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"]["args"])[:300])
                    if msg.get("method") == "Runtime.exceptionThrown":
                        logs.append("EXC " + json.dumps(msg["params"]["exceptionDetails"])[:300])
            await call("Runtime.enable"); await call("Page.enable")
            await call("Page.navigate", url=URL)
            await asyncio.sleep(WAIT)
            js = """JSON.stringify([...document.querySelectorAll('video')].map(v=>({t:v.currentTime,rs:v.readyState,w:v.videoWidth,h:v.videoHeight,paused:v.paused,err:v.error&&v.error.message})))"""
            r = await call("Runtime.evaluate", expression=js)
            print("videos:", r["result"]["value"])
            st = await call("Runtime.evaluate", expression="""JSON.stringify([...document.querySelectorAll('video-stream')].map(e=>({src:e.wsURL,ws:e.wsState,pc:e.pcState,pcc:e.pc&&e.pc.connectionState,ice:e.pc&&e.pc.iceConnectionState,mode:e.mode,status:e.querySelector('.status')&&e.querySelector('.status').innerText,m:e.querySelector('.mode')&&e.querySelector('.mode').innerText})))""")
            print("players:", st["result"]["value"])
            print("console:", *sorted(set(logs)), sep="\n  ")
            s = await call("Page.captureScreenshot", format="png")
            open(SHOT, "wb").write(base64.b64decode(s["data"]))
    asyncio.run(main())
finally:
    p.kill()
