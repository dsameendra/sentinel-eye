"""Tiny Chrome DevTools driver for end-to-end checks (headless Chrome, real time)."""
import asyncio, base64, json, os, shutil, subprocess, tempfile, time, urllib.request
import websockets


def find_chrome() -> str:
    """Locate a Chrome/Chromium binary. Override with $CHROME when it lives somewhere unusual."""
    override = os.environ.get("CHROME")
    if override:
        return override
    candidates = [
        # macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        # Linux — PATH lookups cover Debian, Fedora and the snap/flatpak shims, then fall back to paths
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
        # Windows
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    raise RuntimeError(
        "No Chrome/Chromium found — install it, or set $CHROME to the browser binary."
    )


CHROME = find_chrome()


class Browser:
    def __init__(self, width=1440, height=900, port=None, headed=False):
        import socket
        if port is None:   # a free port, so a leftover Chrome from an earlier run can never block this one
            with socket.socket() as s0:
                s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]
        self.w, self.h, self.port, self.headed = width, height, port, headed
        self.logs = []

    async def __aenter__(self):
        args = [CHROME] + ([] if self.headed else ["--headless=new"]) + [f"--remote-debugging-port={self.port}",
            f"--user-data-dir={tempfile.mkdtemp()}", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
            f"--window-size={self.w},{self.h}", "about:blank"]
        if os.geteuid() == 0 or os.environ.get("CHROME_NO_SANDBOX"):
            # In a container or as root, Chrome's sandbox cannot start without --no-sandbox.
            args.insert(1, "--no-sandbox")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tabs = None
        for _ in range(60):
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
