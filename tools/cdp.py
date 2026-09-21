"""Tiny Chrome DevTools driver for end-to-end checks (headless Chrome, real time)."""
import asyncio, base64, json, subprocess, tempfile, time, urllib.request
import websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class Browser:
    def __init__(self, width=1440, height=900, port=9444, headed=False):
        self.w, self.h, self.port, self.headed = width, height, port, headed
        self.logs = []

    async def __aenter__(self):
        self.proc = subprocess.Popen([CHROME] + ([] if self.headed else ["--headless=new"]) + [f"--remote-debugging-port={self.port}",
            f"--user-data-dir={tempfile.mkdtemp()}", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
            f"--window-size={self.w},{self.h}", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json")); break
            except Exception:
                await asyncio.sleep(0.25)
        url = [t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"]
        self.ws = await websockets.connect(url, max_size=64_000_000)
        self.n = 0
        self.pending = {}
        self.reader = asyncio.create_task(self._read())
        await self.send("Runtime.enable"); await self.send("Page.enable")
        await self.send("Emulation.setDeviceMetricsOverride", width=self.w, height=self.h, deviceScaleFactor=1, mobile=False)
        return self

    async def __aexit__(self, *a):
        self.reader.cancel()
        await self.ws.close()
        self.proc.kill()

    async def _read(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if "id" in m and m["id"] in self.pending:
                self.pending.pop(m["id"]).set_result(m)
            elif m.get("method") == "Runtime.consoleAPICalled" and m["params"]["type"] in ("error", "warning"):
                self.logs.append(m["params"]["type"] + ": " + " ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"])[:300])
            elif m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                self.logs.append("EXCEPTION: " + (d.get("exception", {}).get("description") or d.get("text", ""))[:300])

    async def send(self, method, **params):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        return (await fut).get("result", {})

    async def goto(self, url):
        await self.send("Page.navigate", url=url)

    async def js(self, expr):
        r = await self.send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", "js error"))
        return r["result"].get("value")

    async def wait_for(self, expr, timeout=20, every=0.4):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if await self.js(f"!!({expr})"):
                    return True
            except RuntimeError:
                pass
            await asyncio.sleep(every)
        return False

    async def shot(self, path):
        r = await self.send("Page.captureScreenshot", format="png")
        open(path, "wb").write(base64.b64decode(r["data"]))
