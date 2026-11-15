"""Recorder account-lockout breaker (app/recorder_guard.py) and the clients that honour it, against fake
HTTP-digest and RTSP servers on localhost (no recorder):

- one ISAPI call with a wrong password sends the password once (the stdlib handler used to resend it ~6 times)
- that rejection trips the breaker; the normal challenge-then-success and a stale nonce don't
- while tripped, guarded ISAPI and RTSP clients fail fast without connecting; the admin tools don't trip it
- an RTSP rejection after the challenge trips it; CR/LF in a range or speed is refused before connecting
- a live relay process (hikrelay.py stream) finds the marker next to its --settings file and doesn't log in

   .venv/bin/python3 tools/test_recorder_guard.py
"""
import http.server
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-guard-")
sys.path.insert(0, "app")
import hikrelay
import isapi
import recorder_guard

PASS = []


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


# --------------------------------------------------------------------------- fake HTTP digest server

class Digest(http.server.BaseHTTPRequestHandler):
    mode = "reject"        # reject: every credentialed request 401s | accept: any credentials accepted | stale
    seen = {"plain": 0, "creds": 0}
    stale_sent = False

    def log_message(self, *a):
        pass

    def _challenge(self, stale=False):
        self.send_response(401)
        nonce = os.urandom(8).hex()   # a fresh nonce each time, like the recorder
        self.send_header("WWW-Authenticate", f'Digest realm="DVR", nonce="{nonce}", qop="auth"' + (", stale=TRUE" if stale else ""))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _ok(self):
        body = b"<Time><localTime>2026-11-15T10:00:00+05:30</localTime></Time>"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _any(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if not self.headers.get("Authorization"):
            Digest.seen["plain"] += 1
            return self._challenge()
        Digest.seen["creds"] += 1
        if Digest.mode == "accept":
            return self._ok()
        if Digest.mode == "stale" and not Digest.stale_sent:
            Digest.stale_sent = True
            return self._challenge(stale=True)
        if Digest.mode == "stale":
            return self._ok()
        return self._challenge()

    do_GET = do_POST = do_PUT = _any


def http_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Digest)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def reset_http(mode):
    Digest.mode, Digest.stale_sent = mode, False
    Digest.seen.update(plain=0, creds=0)


# --------------------------------------------------------------------------- fake RTSP server

class Rtsp:
    """Answers DESCRIBE with a digest challenge, then 401 again to any credentialed DESCRIBE."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self.requests = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            c, _ = self.sock.accept()
            self.connections += 1
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, c):
        buf = b""
        try:
            while True:
                d = c.recv(4096)
                if not d:
                    return
                buf += d
                while b"\r\n\r\n" in buf:
                    head, buf = buf.split(b"\r\n\r\n", 1)
                    head = head.decode()
                    self.requests.append(head)
                    cseq = next((l.split(":", 1)[1].strip() for l in head.split("\r\n") if l.lower().startswith("cseq")), "1")
                    extra = "" if "Authorization" in head else 'WWW-Authenticate: Digest realm="DVR", nonce="abc123"\r\n'
                    c.sendall(f"RTSP/1.0 401 Unauthorized\r\nCSeq: {cseq}\r\n{extra}\r\n".encode())
        except OSError:
            pass
        finally:
            c.close()


# --------------------------------------------------------------------------- checks

def guard_basics():
    recorder_guard.clear()
    check("guard: clear by default", not recorder_guard.tripped())
    check("guard: marker lives in the data dir (SENTINEL_DATA here)",
          str(recorder_guard.marker_path()).startswith(os.environ["SENTINEL_DATA"]), recorder_guard.marker_path())
    fp = recorder_guard.fingerprint("h", "u", "secret pw")
    recorder_guard.trip(fp, "test")
    text = recorder_guard.marker_path().read_text()
    check("guard: tripped for those credentials", recorder_guard.tripped(fp) and recorder_guard.tripped())
    check("guard: never stores the password", "secret pw" not in text, text)
    mode = stat.S_IMODE(os.stat(recorder_guard.marker_path()).st_mode)
    check("guard: the marker is owner-only (0600), like settings.json", mode == 0o600, oct(mode))
    check("guard: other credentials (saved since) aren't blocked by a stale rejection",
          not recorder_guard.tripped(recorder_guard.fingerprint("h", "u", "new pw")))
    try:
        recorder_guard.check(fp)
        check("guard: check() raises the user-safe message", False)
    except recorder_guard.RecorderAuthBlocked as e:
        check("guard: check() raises the user-safe message", str(e) == recorder_guard.MESSAGE)
    check("guard: clear() reports it was tripped, and lifts it", recorder_guard.clear() and not recorder_guard.tripped())
    check("guard: clear() when already clear is harmless", recorder_guard.clear() is False)


def isapi_checks():
    srv = http_server()
    port = srv.server_address[1]
    api = isapi.Isapi("127.0.0.1", "admin", "wrong", port, timeout=5)

    reset_http("accept")
    st, body = api.get("/ISAPI/System/time")
    check("isapi: the normal challenge-then-success works and doesn't trip", st == 200 and not recorder_guard.tripped(),
          (st, Digest.seen))
    reset_http("stale")
    st, _ = api.get("/ISAPI/System/time")
    check("isapi: a stale-nonce challenge is answered once more, not treated as a rejection",
          st == 200 and not recorder_guard.tripped(), (st, Digest.seen))

    reset_http("reject")
    try:
        api.get("/ISAPI/System/time")
        check("isapi: a credentialed 401 raises RecorderAuthBlocked", False)
    except recorder_guard.RecorderAuthBlocked:
        check("isapi: a credentialed 401 raises RecorderAuthBlocked", True)
    check("isapi: the wrong password was sent once, not ~6 times", Digest.seen["creds"] == 1, Digest.seen)
    check("isapi: ...and tripped the breaker", recorder_guard.tripped(api.fp))
    before = dict(Digest.seen)
    for fn in (lambda: api.get("/ISAPI/System/time"), lambda: api.open_stream("/ISAPI/Event/notification/alertStream"),
               lambda: api.picture(1)):
        try:
            fn()
            check("isapi: blocked calls fail fast", False)
        except recorder_guard.RecorderAuthBlocked:
            pass
    check("isapi: while tripped, nothing reaches the recorder (call, alertStream, picture)", Digest.seen == before, Digest.seen)

    recorder_guard.clear()
    reset_http("reject")
    r = hikrelay.isapi_channels({"host": "127.0.0.1", "http_port": port, "user": "admin", "pw": "wrong"})
    check("discover's camera-name lookup: password sent once, no trip (admin tool)",
          r == {} and Digest.seen["creds"] == 1 and not recorder_guard.tripped(), (r, Digest.seen))
    srv.shutdown()


def rtsp_checks():
    recorder_guard.clear()
    fake = Rtsp()
    mk = lambda **kw: hikrelay.RtspClient("127.0.0.1", fake.port, "admin", "wrong", "/Streaming/Channels/102", timeout=3, **kw)
    try:
        mk(guarded=False).open()
        check("rtsp (admin tool): rejection reported, breaker untouched", False)
    except hikrelay.RelayError as e:
        check("rtsp (admin tool): rejection reported, breaker untouched", "Authentication failed" in str(e) and not recorder_guard.tripped(), e)
    fake.requests.clear()
    try:
        mk().open()
        check("rtsp: a rejection after the challenge trips the breaker", False)
    except hikrelay.RelayError as e:
        creds = sum("Authorization" in r for r in fake.requests)
        check("rtsp: a rejection after the challenge trips the breaker",
              str(e) == recorder_guard.MESSAGE and recorder_guard.tripped() and creds == 1, (e, creds))
    n = fake.connections
    try:
        mk().open()
    except hikrelay.RelayError as e:
        check("rtsp: while tripped, a guarded client doesn't even connect", fake.connections == n and str(e) == recorder_guard.MESSAGE, e)
    try:
        mk(guarded=False).open()
    except hikrelay.RelayError as e:
        check("rtsp: the admin tools still reach the recorder while tripped", fake.connections == n + 1, e)
    recorder_guard.clear()

    n = fake.connections
    for bad in ({"play_range": "clock=20260101T000000Z-\r\nX-Evil: 1"}, {"scale": "1\r\nX-Evil: 1"}, {"scale": "2\n"}):
        try:
            mk().open(**bad)
            check(f"rtsp: CR/LF refused {bad}", False)
        except hikrelay.RelayError as e:
            check(f"rtsp: CR/LF refused before connecting {list(bad)}", "Invalid" in str(e) and fake.connections == n, e)
    c = mk()
    try:
        c.play("npt=0-", "1\r\nX: y")
        check("rtsp: play() refuses CR/LF too", False)
    except hikrelay.RelayError:
        check("rtsp: play() refuses CR/LF too", True)
    for path in ("/Streaming/Channels/101 RTSP/1.0", "/a\r\nX: y"):
        try:
            hikrelay.RtspClient("127.0.0.1", fake.port, "admin", "pw", path)
            check(f"rtsp: unsafe path refused {path!r}", False)
        except hikrelay.RelayError:
            check(f"rtsp: unsafe path refused {path!r}", True)


def relay_process_honours_marker():
    recorder_guard.clear()
    fake = Rtsp()
    d = tempfile.mkdtemp(prefix="se-guard-relay-")
    settings = {"connection": {"host": "127.0.0.1", "rtsp_port": fake.port, "http_port": 80, "username": "admin",
                               "password": "wrong", "encrypted": False, "key": ""},
                "channels": [{"id": "c1", "channel": 1, "sub_path": "", "main_path": "", "sub_fps": "auto"}]}
    with open(os.path.join(d, "settings.json"), "w") as f:
        json.dump(settings, f)
    recorder_guard.configure(d)
    try:
        recorder_guard.trip(recorder_guard.fingerprint("127.0.0.1", "admin", "wrong"), "test")
    finally:
        recorder_guard._dir = None
    env = {**os.environ, "SENTINEL_DATA": tempfile.mkdtemp(prefix="se-guard-other-")}   # must not be what it reads
    t0 = time.time()
    r = subprocess.run([sys.executable, "app/hikrelay.py", "stream", "--settings", os.path.join(d, "settings.json"),
                        "--channel-id", "c1", "--kind", "sub", "--out", "rtsp://127.0.0.1:1/x"],
                       capture_output=True, text=True, timeout=30, env=env)
    check("relay: finds the marker next to its --settings file and exits without logging in",
          r.returncode == 1 and recorder_guard.MESSAGE in r.stderr and fake.connections == 0, (r.returncode, r.stderr[-200:], fake.connections))
    check("relay: pauses before exiting, so go2rtc's re-spawns aren't a tight loop", time.time() - t0 >= 4)

    os.unlink(os.path.join(d, recorder_guard.MARKER_NAME))
    r = subprocess.run([sys.executable, "app/hikrelay.py", "stream", "--settings", os.path.join(d, "settings.json"),
                        "--channel-id", "c1", "--kind", "sub", "--out", "rtsp://127.0.0.1:1/x"],
                       capture_output=True, text=True, timeout=30, env=env)
    check("relay: a rejection trips the marker in the settings dir",
          r.returncode == 1 and os.path.exists(os.path.join(d, recorder_guard.MARKER_NAME)) and fake.connections == 1,
          (r.returncode, r.stderr[-200:], fake.connections))


def relay_burst_costs_one_login():
    """Saving a wrong password restarts go2rtc and every watched stream re-spawns its relay at once: the login
    lock must let only the first one send the password; the rest see the tripped breaker and never log in."""
    recorder_guard.clear()
    fake = Rtsp()
    d = tempfile.mkdtemp(prefix="se-guard-burst-")
    settings = {"connection": {"host": "127.0.0.1", "rtsp_port": fake.port, "http_port": 80, "username": "admin",
                               "password": "wrong", "encrypted": False, "key": ""},
                "channels": [{"id": f"c{n}", "channel": n, "sub_path": "", "main_path": "", "sub_fps": "auto"} for n in range(1, 7)]}
    with open(os.path.join(d, "settings.json"), "w") as f:
        json.dump(settings, f)
    procs = [subprocess.Popen([sys.executable, "app/hikrelay.py", "stream", "--settings", os.path.join(d, "settings.json"),
                               "--channel-id", f"c{n}", "--kind", "sub", "--out", "rtsp://127.0.0.1:1/x"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for n in range(1, 7)]
    outs = [p.communicate(timeout=60) for p in procs]
    creds = sum("Authorization" in r for r in fake.requests)
    check("relay burst: 6 relays starting together send the wrong password once in total", creds == 1,
          (creds, fake.connections))
    check("relay burst: every relay stops with the fix-it message",
          all(p.returncode == 1 and recorder_guard.MESSAGE in o[1] for p, o in zip(procs, outs)), [o[1][-120:] for o in outs])


def main():
    guard_basics()
    isapi_checks()
    rtsp_checks()
    relay_process_honours_marker()
    relay_burst_costs_one_login()
    recorder_guard.clear()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
