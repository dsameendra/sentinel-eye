"""HTTP + WebSocket checks for the optional sign-in, against server.app in-process (Starlette TestClient, no
lifespan: no go2rtc, no DVR). Handlers that need those may 500 — role checks only look at 401/403.

   pip install -r requirements-dev.txt
   .venv/bin/python3 tools/test_auth_http.py
"""
import contextlib
import os
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-auth-http-")
os.environ.pop("SENTINEL_ADMIN_PASSWORD", None)
sys.path.insert(0, "app")
import auth
import server
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

PASS = []
PW = "correct horse battery"


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class FakeGo2rtc:
    def status(self):
        return {"cam1": {"producers": []}}

    def up(self):
        return True


server.state["go2rtc"] = FakeGo2rtc()
server.db.init()   # normally done by PlaybackService at startup


class FakeUpstream:
    """Stands in for go2rtc's WebSocket: never sends, so the proxy just stays open."""
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        import asyncio
        await asyncio.sleep(3600)

    async def send(self, m):
        pass


server.websockets.connect = lambda *a, **kw: FakeUpstream()
server.desired_streams = lambda s: {"cam1": ""}


def client(ip="testclient"):
    return TestClient(server.app, client=(ip, 50000), follow_redirects=False, raise_server_exceptions=False)


def login(c, user, pw=PW, remember=False):
    r = c.post("/api/auth/login", json={"username": user, "password": pw, "remember": remember})
    assert r.status_code == 200, (user, r.status_code, r.text)
    return r


def ws_close_code(c, url, wait=0.0):
    """Close code the server sends, or None when it stays open for `wait` seconds."""
    try:
        with c.websocket_connect(url) as ws:
            if wait:
                return None
            msg = ws.receive()
            return msg.get("code")
    except WebSocketDisconnect as e:
        return e.code


def auth_off():
    c = client()
    r = c.get("/api/settings")
    check("auth off: settings full", r.status_code == 200 and "host" in r.json()["connection"], r.status_code)
    check("auth off: me disabled", c.get("/api/auth/me").json()["auth_enabled"] is False)
    check("auth off: foreign Origin on PUT refused",
          c.put("/api/display", json={}, headers={"Origin": "http://evil.example"}).status_code == 403)
    check("auth off: no Origin (script) allowed", c.put("/api/display", json=c.get("/api/settings").json()["display"]).status_code == 200)
    check("auth off: login refused", c.post("/api/auth/login", json={"username": "x", "password": "y"}).status_code == 409)
    check("auth off: pairing refused", c.post("/api/auth/pair/start").status_code == 409)


def enable_from_ui():
    c = client()
    r = c.post("/api/auth/admin/users", json={"username": "boss", "password": PW, "role": "viewer"})
    check("first account created from the UI", r.status_code == 200 and "se_session" in r.cookies, r.text[:200])
    me = c.get("/api/auth/me").json()
    check("…as admin, and this browser is signed in", me["via"] == "session" and me["role"] == "admin", me)
    check("anon now gets 401", client().get("/api/settings").status_code == 401)
    return c


def anonymous():
    c = client()
    r = c.get("/")
    check("anon GET / -> 302 /login?next=%2F", r.status_code == 302 and r.headers["location"] == "/login?next=%2F",
          r.headers.get("location"))
    r = c.get("/js/live.js")
    check("anon app JS -> redirect", r.status_code == 302)
    for path in ("/login", "/login.html", "/js/login.js", "/js/ui.js", "/css/app.css", "/manifest.json", "/sw.js"):
        r = c.get(path)
        check(f"anon {path} public", r.status_code == 200, r.status_code)
    r = c.get("/api/status")
    check("anon /api/status only says go2rtc", r.status_code == 200 and r.json() == {"go2rtc": True}, r.text)
    r = c.get("/api/settings")
    check("anon API -> 401 JSON", r.status_code == 401 and r.json()["code"] == "auth_required")
    check("anon /ws -> 4401", ws_close_code(c, "/ws?src=cam1") == 4401)


def role_matrix():
    for name, role in (("vic", "viewer"), ("opal", "operator"), ("ada", "admin")):
        auth.create_user(name, PW, role)
    clients = {}
    for name, role in (("vic", "viewer"), ("opal", "operator"), ("ada", "admin")):
        c = client()
        login(c, name)
        clients[role] = c
    cases = [  # method, path, body, minimum role
        ("GET", "/api/settings", None, "viewer"),
        ("GET", "/api/status", None, "viewer"),
        ("GET", "/api/auth/me", None, "viewer"),
        ("PUT", "/api/display", "display", "operator"),
        ("GET", "/api/timeline/events", None, "operator"),
        ("GET", "/api/timeline/coverage?channel=1&from_day=2026-01-01&to_day=2026-01-01", None, "operator"),
        ("GET", "/api/playback/pool", None, "operator"),
        ("GET", "/api/bookmarks", None, "operator"),
        ("POST", "/api/export", {"channels": ["zz"], "start_utc": "x", "end_utc": "y"}, "operator"),
        ("GET", "/api/enhance/abc", None, "operator"),
        ("PUT", "/api/settings", {"connection": {"host": "not a host!"}}, "admin"),   # 422: never saved
        ("POST", "/api/test", {}, "admin"),
        ("POST", "/api/discover", {}, "admin"),
        ("GET", "/api/auth/admin/users", None, "admin"),
        ("GET", "/api/auth/admin/audit", None, "admin"),
        ("POST", "/api/auth/pair/approve", {"code": "x"}, "admin"),
        ("GET", "/api/some-future-route", None, "admin"),   # fail closed
    ]
    display = clients["admin"].get("/api/settings").json()["display"]
    bad = []
    for method, path, body, need in cases:
        for role, c in clients.items():
            r = c.request(method, path, json=display if body == "display" else body)
            allowed = auth.rank(role) >= auth.rank(need)
            if allowed == (r.status_code in (401, 403)):
                bad.append(f"{role} {method} {path} -> {r.status_code}")
    check("role matrix (HTTP)", not bad, "; ".join(bad))
    s = clients["viewer"].get("/api/settings").json()
    check("viewer settings: no recorder details", set(s["connection"]) == {"channel_zero", "configured"}, s["connection"])
    check("viewer /ws allowed", ws_close_code(clients["viewer"], "/ws?src=cam1", wait=0.2) is None)
    check("viewer playback WS -> 4403", ws_close_code(clients["viewer"], "/api/playback/ws?channel=c1&start=x") == 4403)
    import datetime
    ago = lambda s: (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=s)).isoformat().replace("+00:00", "Z")
    check("viewer instant replay (10 s ago) admitted",
          ws_close_code(clients["viewer"], f"/api/playback/ws?channel=nope&start={ago(10)}") == 4404)
    check("viewer playback 10 min ago -> 4403",
          ws_close_code(clients["viewer"], f"/api/playback/ws?channel=nope&start={ago(600)}") == 4403)
    check("operator playback WS admitted (closes later for other reasons)",
          ws_close_code(clients["operator"], "/api/playback/ws?channel=nope&start=x") == 4404)
    r = clients["operator"].post("/api/bookmarks", json={"channels": ["c1"], "time_utc": "2026-09-28T10:00:00+00:00"})
    check("bookmark author is the user", r.status_code == 200 and r.json()["author"] == "opal", r.text[:200])
    return clients


def revocation_closes_ws(clients):
    c = client()
    login(c, "vic")
    uid = auth.get_user_by_name("vic")["id"]
    result = {}

    def watch():
        result["code"] = ws_close_code(c, "/ws?src=cam1")

    t = threading.Thread(target=watch)
    t.start()
    time.sleep(0.3)
    t0 = time.time()
    auth.revoke_user_sessions(uid)
    t.join(3)
    check("revoking a session closes its /ws within 1 s", result.get("code") == 4401 and time.time() - t0 < 1, result)


def login_flow():
    c = client()
    r1 = c.post("/api/auth/login", json={"username": "ada", "password": "wrong password"})
    r2 = c.post("/api/auth/login", json={"username": "ghost", "password": "wrong password"})
    check("wrong password and unknown user look the same", r1.status_code == r2.status_code == 401 and r1.json() == r2.json())
    for _ in range(5):
        c.post("/api/auth/login", json={"username": "limitme", "password": "wrong password"})
    r = c.post("/api/auth/login", json={"username": "limitme", "password": "wrong password"})
    check("6th fast failure -> 429 + Retry-After", r.status_code == 429 and int(r.headers["retry-after"]) >= 1, r.status_code)
    auth.login_limiter.ok(("ip", "testclient"))

    r = login(client(), "ada")
    cookie = r.headers["set-cookie"].lower()
    check("cookie flags", "httponly" in cookie and "samesite=strict" in cookie and "secure" not in cookie
          and "max-age" not in cookie, cookie)
    r = login(client(), "ada", remember=True)
    check("remember-me cookie persists", "max-age=2592000" in r.headers["set-cookie"].lower(), r.headers["set-cookie"])
    auth.set_config({"trusted_proxies": ["10.0.0.0/8"]})
    tc = client("10.0.0.9")
    r = tc.post("/api/auth/login", json={"username": "ada", "password": PW}, headers={"X-Forwarded-Proto": "https"})
    check("Secure cookie behind a trusted https proxy", "secure" in r.headers["set-cookie"].lower(), r.headers["set-cookie"])
    auth.set_config({"trusted_proxies": []})

    c = client()
    login(c, "ada")
    c.post("/api/auth/logout")
    check("logout ends the session", c.get("/api/settings").status_code == 401)

    a, b = client(), client()
    login(a, "opal")
    login(b, "opal")
    r = a.post("/api/auth/password", json={"current": PW, "new": "a brand new pass"})
    check("password change ok", r.status_code == 200, r.text)
    check("…keeps this session", a.get("/api/settings").status_code == 200)
    check("…signs out the others", b.get("/api/settings").status_code == 401)
    a.post("/api/auth/password", json={"current": "a brand new pass", "new": PW})


def totp_flow():
    c = client()
    login(c, "ada")
    secret = c.post("/api/auth/totp/begin").json()["secret"]
    codes = c.post("/api/auth/totp/confirm", json={"code": auth.totp_at(secret, int(time.time() // 30))}).json()["recovery_codes"]
    check("2FA enrolled", len(codes) == 10)
    c2 = client()
    r = c2.post("/api/auth/login", json={"username": "ada", "password": PW})
    ch = r.json().get("challenge")
    check("login asks for the code", r.json().get("totp_required") is True and bool(ch))
    check("wrong code -> 401", c2.post("/api/auth/login/totp", json={"challenge": ch, "code": "000000"}).status_code == 401
          or auth.totp_at(secret, int(time.time() // 30)) == "000000")
    r = c2.post("/api/auth/login/totp", json={"challenge": ch, "code": codes[0]})
    check("recovery code signs in", r.status_code == 200 and c2.get("/api/auth/me").json()["via"] == "session", r.text)
    c3 = client()
    ch = c3.post("/api/auth/login", json={"username": "ada", "password": PW}).json()["challenge"]
    check("recovery code only once", c3.post("/api/auth/login/totp", json={"challenge": ch, "code": codes[0]}).status_code == 401)
    c.post("/api/auth/totp/disable", json={"password": PW})

    auth.set_config({"require_2fa_admin": True})
    c = client()
    me = login(c, "ada").json()
    check("admin without 2FA gets a limited session", me["limited"] is True)
    r = c.get("/api/settings")
    check("…limited: other APIs 403 2fa_required", r.status_code == 403 and r.json()["code"] == "2fa_required")
    secret = c.post("/api/auth/totp/begin").json()["secret"]
    c.post("/api/auth/totp/confirm", json={"code": auth.totp_at(secret, int(time.time() // 30))})
    check("…after enrolling, full access without signing in again", c.get("/api/settings").status_code == 200)
    auth.set_config({"require_2fa_admin": False})
    auth.totp_disable(auth.get_user_by_name("ada")["id"])


def pairing(clients):
    tv, admin = client("192.168.1.80"), clients["admin"]
    p = tv.post("/api/auth/pair/start").json()
    check("pair start", "device_code" in p and "user_code" in p, p)
    check("poll pending", tv.post("/api/auth/pair/poll", json={"device_code": p["device_code"]}).json()["status"] == "pending")
    op = client()
    login(op, "opal")
    check("operator can't approve", op.post("/api/auth/pair/approve", json={"code": p["user_code"]}).status_code == 403)
    r = admin.post("/api/auth/pair/approve", json={"code": p["user_code"], "role": "viewer", "label": "Kitchen TV"})
    check("admin approves", r.status_code == 200, r.text)
    r = tv.post("/api/auth/pair/poll", json={"device_code": p["device_code"]})
    check("poll sets a device cookie", r.json()["status"] == "approved" and "max-age=31536000" in r.headers["set-cookie"].lower())
    s = tv.get("/api/settings")
    check("paired TV sees the live grid only", s.status_code == 200 and "host" not in s.json()["connection"])
    check("paired TV can't open playback", tv.get("/api/timeline/events").status_code == 403)
    devs = admin.get("/api/auth/admin/devices").json()
    dev = next(d for d in devs if d["label"] == "Kitchen TV")
    admin.delete(f"/api/auth/admin/devices/{dev['id']}")
    check("removed TV is signed out", tv.get("/api/settings").status_code == 401)
    check("admin can't approve admin role", admin.post("/api/auth/pair/approve", json={"code": "x", "role": "admin"}).status_code == 422)


def admin_api(clients):
    admin = clients["admin"]
    users = admin.get("/api/auth/admin/users").json()
    boss = next(u for u in users if u["username"] == "boss")
    ada = auth.get_user_by_name("ada")
    r = admin.patch(f"/api/auth/admin/users/{ada['id']}", json={"role": "viewer"})
    check("demoting one of two admins ok", r.status_code == 200)
    c = client()
    login(c, "boss")
    r = c.patch(f"/api/auth/admin/users/{boss['id']}", json={"role": "viewer"})
    check("last admin can't demote self -> 409", r.status_code == 409, r.text)
    auth.update_user(ada["id"], role="admin")
    r = admin.put("/api/auth/admin/config", json={"bypass_cidrs": ["127.0.0.0/8"]})
    check("loopback bypass warns", r.status_code == 200 and r.json()["warnings"], r.text)
    admin.put("/api/auth/admin/config", json={"bypass_cidrs": []})
    check("audit has entries", len(admin.get("/api/auth/admin/audit").json()) > 5)


def bypass():
    auth.set_config({"bypass_cidrs": ["192.168.1.0/24"], "bypass_role": "viewer"})
    lan = client("192.168.1.20")
    r = lan.get("/api/settings")
    check("LAN bypass: viewer access", r.status_code == 200 and "host" not in r.json()["connection"], r.status_code)
    check("LAN bypass: not operator", lan.get("/api/timeline/events").status_code == 403)
    check("LAN bypass: me says bypass", lan.get("/api/auth/me").json()["via"] == "bypass")
    r = lan.get("/api/settings", headers={"X-Forwarded-For": "8.8.8.8"})
    check("LAN peer with proxy headers: sign in", r.status_code == 401)
    check("loopback (tunnel) not bypassed", client("127.0.0.1").get("/api/settings").status_code == 401)
    check("bypass /ws allowed", ws_close_code(lan, "/ws?src=cam1", wait=0.2) is None)
    auth.set_config({"bypass_cidrs": []})


def main():
    auth_off()
    enable_from_ui()
    anonymous()
    clients = role_matrix()
    revocation_closes_ws(clients)
    login_flow()
    totp_flow()
    pairing(clients)
    admin_api(clients)
    bypass()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.stdout.flush()
    os._exit(0 if all(PASS) else 1)   # skip joining TestClient's portal threads


if __name__ == "__main__":
    main()
