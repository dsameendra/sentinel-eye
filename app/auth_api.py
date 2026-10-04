"""HTTP side of the optional sign-in: who is asking (the principal), which role each route needs, the session
cookie, and the /api/auth/* endpoints. Storage and the security primitives live in auth.py.

With no accounts every request is an admin principal (via="none"), so routes never special-case "auth off"."""
import base64, math, re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote, urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import auth

COOKIE = "se_session"


@dataclass
class Principal:
    user_id: int | None
    username: str
    role: str                              # "" for anonymous
    via: Literal["session", "bypass", "none", "anon"]
    session: dict | None = None
    user: dict | None = None

    @property
    def session_hash(self) -> str | None:
        return self.session["token_hash"] if self.session else None

    @property
    def limited(self) -> bool:
        return bool(self.session and self.session["limited"])

    @property
    def author(self) -> str:
        """Name stamped on bookmarks and exports."""
        if self.via == "session":
            return self.user["label"] or self.username
        if self.via == "bypass":
            return f"LAN ({self.role})"
        return "Operator"

    def can(self, role: str) -> bool:
        return auth.rank(self.role) >= auth.rank(role)


def peer(conn) -> str:
    return conn.client.host if conn.client else ""


def ip_of(conn) -> str:
    return auth.client_ip(peer(conn), conn.headers, auth.get_config()["trusted_proxies"])


def principal_for(conn) -> Principal:
    """For a Request or a WebSocket: session cookie, else network bypass, else anonymous."""
    if not auth.enabled():
        return Principal(None, "Operator", "admin", "none")
    token = conn.cookies.get(COOKIE)
    if token:
        got = auth.lookup_session(token)
        if got:
            s, u = got
            return Principal(u["id"], u["username"], u["role"], "session", s, u)
    role = auth.bypass_role(peer(conn), conn.headers, auth.get_config())
    if role:
        return Principal(None, f"lan-{role}", role, "bypass")
    return Principal(None, "", "", "anon")


# ------------------------------------------------------------------ route roles

# First match wins; method "*" matches any. An /api/ path matching nothing needs admin (fail closed), so a
# route added later without an entry here is never accidentally open. Other paths (the app shell) need viewer.
ROUTE_ROLES = [(m, re.compile(rx), role) for m, rx, role in [
    ("GET", r"/api/settings", "viewer"),                  # handler redacts the connection for non-admins
    ("PUT", r"/api/display", "operator"),                 # shared layout/order: everyone's screens change
    ("*", r"/api/(settings|test|discover)", "admin"),
    ("*", r"/api/(timeline|playback|bookmarks|export|enhance)(/.*)?", "operator"),
    ("*", r"/api/auth/(admin/.*|pair/approve)", "admin"),
    ("*", r"/api/auth/.*", "viewer"),
]]
PUBLIC = re.compile(r"/(login|pair|login\.html|pair\.html|manifest\.json|sw\.js|favicon\.ico|css/app\.css"
                    r"|js/(login|pair|ui|api|qr|tvnav|pwa)\.js|vendor/qrcode\.js|icons/[^/]+"
                    r"|api/status|api/auth/(me|login|login/totp|logout|pair/start|pair/poll))")
LIMITED_OK = re.compile(r"/api/auth/(me|logout|password|totp/.*)")   # admin who must enrol 2FA first


def required_role(method: str, path: str) -> str | None:
    """Minimum role for a request, or None when it's public."""
    if PUBLIC.fullmatch(path):
        return None
    method = "GET" if method == "HEAD" else method
    for m, rx, role in ROUTE_ROLES:
        if (m == "*" or m == method) and rx.fullmatch(path):
            return role
    return "admin" if path.startswith("/api/") else "viewer"


def same_origin(conn) -> bool:
    """False only when the browser says the request comes from another site. Browsers always send Origin on
    cross-site POST/PUT/DELETE, so a missing header means a non-browser client (scripts in tools/), not CSRF."""
    src = conn.headers.get("origin") or conn.headers.get("referer")
    if not src:
        return True
    return urlparse(src).netloc == conn.headers.get("host")


def _deny(status: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "code": code}, status)


async def gate(request: Request, call_next):
    """HTTP middleware: CSRF origin check, principal, route role. WebSockets are checked in their handlers."""
    path = request.url.path
    if request.method not in ("GET", "HEAD", "OPTIONS") and not same_origin(request):
        return _deny(403, "Cross-site request refused", "cross_site")
    p = principal_for(request)
    request.state.principal = p
    need = required_role(request.method, path)
    if need is not None:
        if p.via == "anon":
            if path.startswith("/api/"):
                return _deny(401, "Sign in first", "auth_required")
            nxt = path + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse("/login?next=" + quote(nxt, safe=""), 302)
        if p.limited and path.startswith("/api/") and not LIMITED_OK.fullmatch(path):
            return _deny(403, "Set up two-factor authentication first", "2fa_required")
        if not p.can(need):
            return _deny(403, "Your account can't do that", "forbidden")
    resp = await call_next(request)
    s = p.session
    if s and s["slid"] and (s["remember"] or s["kind"] == "device") and COOKIE not in resp.headers.get("set-cookie", ""):
        set_cookie(resp, request, request.cookies[COOKIE], int(auth.session_ttl(s)))   # keep a persistent cookie alive
    return resp


def set_cookie(resp, conn, token: str, max_age: int | None) -> None:
    secure = auth.effective_scheme(conn.url.scheme, peer(conn), conn.headers,
                                   auth.get_config()["trusted_proxies"]) == "https"
    resp.set_cookie(COOKIE, token, max_age=max_age, httponly=True, samesite="strict", secure=secure, path="/")


def clear_cookie(resp) -> None:
    resp.delete_cookie(COOKIE, path="/", httponly=True, samesite="strict")


async def auth_error(request: Request, exc: auth.AuthError):
    return JSONResponse({"detail": str(exc)}, exc.status)


# ------------------------------------------------------------------ /api/auth

router = APIRouter(prefix="/api/auth")


def _p(request: Request) -> Principal:
    return request.state.principal


def _account(request: Request) -> Principal:
    """A signed-in person (not a bypass, not a device, not auth-off)."""
    p = _p(request)
    if p.via != "session" or p.user["kind"] != "person":
        raise HTTPException(400, "That needs a signed-in account")
    return p


def _me(p: Principal) -> dict:
    return {"auth_enabled": auth.enabled(), "via": p.via, "role": p.role or None, "limited": p.limited,
            "session_id": p.session_hash[:16] if p.session else None,
            "user": ({k: p.user.get(k) for k in ("id", "username", "kind", "label", "role", "has_totp", "avatar")}
                     if p.user else None)}


def _start_session(request: Request, user: dict, remember: bool, ip: str) -> JSONResponse:
    limited = user["role"] == "admin" and not user["has_totp"] and auth.get_config()["require_2fa_admin"]
    token = auth.create_session(user["id"], remember=remember, ip=ip, limited=limited,
                                ua=request.headers.get("user-agent", ""))
    auth.audit(user["username"], "login.ok", "", ip, remember=remember or None)
    s, u = auth.lookup_session(token)
    resp = JSONResponse(_me(Principal(u["id"], u["username"], u["role"], "session", s, u)))
    set_cookie(resp, request, token, int(auth.session_ttl(s)) if remember else None)
    return resp


def _too_many(wait: float) -> JSONResponse:
    secs = math.ceil(wait)
    return JSONResponse({"detail": f"Too many attempts; try again in {secs} s", "code": "rate_limited"}, 429,
                        headers={"Retry-After": str(secs)})


@router.get("/me")
def me(request: Request):
    return _me(_p(request))


class LoginReq(BaseModel):
    username: str
    password: str
    remember: bool = False


@router.post("/login")
async def login(req: LoginReq, request: Request):
    if not auth.enabled():
        raise HTTPException(409, "Sign-in is off")
    ip = ip_of(request)
    keys = (("ip", ip), ("user", req.username.strip().lower()))
    if wait := auth.login_limiter.check(*keys):
        return _too_many(wait)
    user = await run_in_threadpool(auth.authenticate, req.username, req.password)
    if user is None:
        auth.login_limiter.fail(*keys)
        auth.audit(req.username.strip()[:64], "login.fail", "", ip)
        raise HTTPException(401, "Wrong username or password")
    auth.login_limiter.ok(*keys)
    if user["has_totp"]:
        return {"totp_required": True, "challenge": auth.challenge_new(user["id"], req.remember)}
    return _start_session(request, user, req.remember, ip)


class TotpLoginReq(BaseModel):
    challenge: str
    code: str


@router.post("/login/totp")
async def login_totp(req: TotpLoginReq, request: Request):
    ip = ip_of(request)
    ch = auth.challenge_peek(req.challenge)
    if ch is None:
        raise HTTPException(401, "That sign-in took too long; start again")
    uid, remember = ch
    keys = (("ip", ip), ("uid", uid))
    if wait := auth.login_limiter.check(*keys):
        return _too_many(wait)
    code = req.code.strip()
    is_totp = re.fullmatch(r"\d{6}", code.replace(" ", "")) is not None
    ok = auth.totp_check(uid, code) if is_totp else auth.use_recovery_code(uid, code)
    user = auth.get_user(uid)
    if not ok or user is None or user["disabled"]:
        auth.login_limiter.fail(*keys)
        auth.audit(user["username"] if user else str(uid), "login.fail_2fa", "", ip)
        raise HTTPException(401, "That code isn't right")
    auth.login_limiter.ok(*keys)
    auth.challenge_take(req.challenge)
    if not is_totp:
        auth.audit(user["username"], "login.recovery_code", "", ip)
    return _start_session(request, user, remember, ip)


@router.post("/logout")
def logout(request: Request):
    p = _p(request)
    if p.session:
        auth.revoke_session(p.session_hash)
        auth.audit(p.username, "logout", "", ip_of(request))
    resp = JSONResponse({"ok": True})
    clear_cookie(resp)
    return resp


class PasswordReq(BaseModel):
    current: str
    new: str


@router.post("/password")
async def change_password(req: PasswordReq, request: Request):
    p = _account(request)
    await _recheck_password(p, req.current, request, "The current password isn't right")
    await run_in_threadpool(auth.set_password, p.user_id, req.new, except_hash=p.session_hash, ip=ip_of(request))
    return {"ok": True}


class ProfileReq(BaseModel):
    username: str
    password: str   # changing the name you sign in with asks for your password, like changing the password


@router.patch("/profile")
async def update_profile(req: ProfileReq, request: Request):
    p = _account(request)
    await _recheck_password(p, req.password, request)
    u = await run_in_threadpool(auth.rename_user, p.user_id, req.username, actor=p.username, ip=ip_of(request))
    return {"ok": True, "username": u["username"]}


class AvatarReq(BaseModel):
    kind: str | None = None
    color: str | None = None
    id: str | None = None
    photo: str | None = None   # data: URL of the browser-downscaled JPEG


@router.put("/avatar")
async def update_avatar(req: AvatarReq, request: Request):
    p = _account(request)
    photo = None
    if req.kind == "photo":
        try:
            photo = base64.b64decode((req.photo or "").split(",", 1)[-1], validate=True)
        except ValueError:
            raise HTTPException(422, "That photo couldn't be read")
    u = await run_in_threadpool(auth.set_avatar, p.user_id, {"kind": req.kind, "color": req.color, "id": req.id}, photo,
                                ip=ip_of(request))
    return {"ok": True, "avatar": u["avatar"]}


@router.get("/avatar/{user_id}")
def avatar_photo(user_id: int, request: Request):
    _p(request)   # anyone signed in sees people's pictures (the avatar in the bar, the accounts list)
    path = auth.avatar_photo_path(user_id)
    if not path.exists():
        raise HTTPException(404, "No photo")
    with open(path, "rb") as f:   # stored as sent: a JPEG from the app, or a PNG
        png = f.read(8) == b"\x89PNG\r\n\x1a\n"
    return FileResponse(path, media_type="image/png" if png else "image/jpeg", headers={"Cache-Control": "private, max-age=31536000"})


class CodeReq(BaseModel):
    code: str


class PasswordOnlyReq(BaseModel):
    password: str


@router.post("/totp/begin")
def totp_begin(request: Request):
    p = _account(request)
    secret, uri = auth.totp_begin(p.user_id)
    return {"secret": secret, "uri": uri}


@router.post("/totp/confirm")
def totp_confirm(req: CodeReq, request: Request):
    p = _account(request)
    codes = auth.totp_confirm(p.user_id, req.code, ip=ip_of(request))
    if p.limited:
        auth.set_session_limited(p.session_hash, False)
    return {"recovery_codes": codes}


async def _recheck_password(p: Principal, password: str, request: Request, msg="The password isn't right") -> None:
    """Confirms the signed-in person's password before a sensitive change, under the sign-in limiter (same
    keys as /login): a stolen session can't be used to guess the password any faster than the login form."""
    ip = ip_of(request)
    keys = (("ip", ip), ("user", p.username.strip().lower()))
    if wait := auth.login_limiter.check(*keys):
        secs = math.ceil(wait)
        raise HTTPException(429, f"Too many attempts; try again in {secs} s", headers={"Retry-After": str(secs)})
    if await run_in_threadpool(auth.authenticate, p.username, password) is None:
        auth.login_limiter.fail(*keys)
        auth.audit(p.username, "password.recheck_fail", p.username, ip)
        raise HTTPException(400, msg)
    auth.login_limiter.ok(*keys)


@router.post("/totp/disable")
async def totp_disable(req: PasswordOnlyReq, request: Request):
    p = _account(request)
    await _recheck_password(p, req.password, request)
    if p.role == "admin" and auth.get_config()["require_2fa_admin"]:
        raise HTTPException(409, "Two-factor authentication is required for admins")
    auth.totp_disable(p.user_id, ip=ip_of(request))
    return {"ok": True}


@router.post("/totp/recovery")
async def totp_recovery(req: PasswordOnlyReq, request: Request):
    p = _account(request)
    await _recheck_password(p, req.password, request)
    if not p.user["has_totp"]:
        raise HTTPException(409, "Turn on two-factor authentication first")
    auth.audit(p.username, "totp.recovery_codes", p.username, ip_of(request))
    return {"recovery_codes": auth.new_recovery_codes(p.user_id)}


@router.get("/sessions")
def my_sessions(request: Request):
    p = _account(request)
    cur = p.session_hash[:16]
    return [{**s, "current": s["id"] == cur} for s in auth.list_sessions(p.user_id)]


@router.delete("/sessions/{sid}")
def revoke_my_session(sid: str, request: Request):
    p = _account(request)
    h = auth.session_hash_by_id(sid, p.user_id)
    if h is None:
        raise HTTPException(404, "No such session")
    auth.revoke_session(h, actor=p.username, ip=ip_of(request))
    return {"ok": True}


@router.post("/sessions/revoke-others")
def revoke_my_other_sessions(request: Request):
    p = _account(request)
    n = auth.revoke_user_sessions(p.user_id, except_hash=p.session_hash, actor=p.username, ip=ip_of(request))
    return {"revoked": len(n)}


# ---- device pairing

@router.post("/pair/start")
def pair_start(request: Request):
    if not auth.enabled():
        raise HTTPException(409, "Sign-in is off")
    return auth.pair_start(ip_of(request))


class PollReq(BaseModel):
    device_code: str


@router.post("/pair/poll")
def pair_poll(req: PollReq, request: Request):
    got = auth.pair_poll(req.device_code, ip_of(request), request.headers.get("user-agent", ""))
    if got is None:
        return {"status": "pending"}
    if got == "expired":
        return {"status": "expired"}
    resp = JSONResponse({"status": "approved"})
    set_cookie(resp, request, got, auth.DEVICE_TTL)
    return resp


class ApproveReq(BaseModel):
    code: str
    role: Literal["viewer", "operator"] = "viewer"
    label: str = ""


@router.post("/pair/approve")
def pair_approve(req: ApproveReq, request: Request):
    p = _account(request)
    auth.pair_approve(req.code, role=req.role, label=req.label, approver_id=p.user_id, ip=ip_of(request))
    return {"ok": True}


# ---- administration

class NewUserReq(BaseModel):
    username: str
    password: str
    role: Literal["viewer", "operator", "admin"] = "viewer"


@router.get("/admin/users")
def admin_users():
    return auth.list_users("person")


@router.post("/admin/users")
async def admin_create_user(req: NewUserReq, request: Request):
    p = _p(request)
    ip = ip_of(request)
    # bootstrap_admin() checks "sign-in is off" and creates the first account atomically (auth.py's _lock),
    # so two concurrent first-setup requests can't both slip through and create two permanent admins.
    user = await run_in_threadpool(auth.bootstrap_admin, req.username, req.password, actor="setup", ip=ip)
    if user is not None:
        # Turning sign-in on: the first account is an admin, and this browser is signed in as it right away.
        auth.audit(user["username"], "auth.enable", "", ip)
        return _start_session(request, {**user}, True, ip)
    return await run_in_threadpool(auth.create_user, req.username, req.password, req.role, actor=p.username, ip=ip)


class UserPatch(BaseModel):
    role: Literal["viewer", "operator", "admin"] | None = None
    disabled: bool | None = None
    label: str | None = None


@router.patch("/admin/users/{user_id}")
def admin_update_user(user_id: int, req: UserPatch, request: Request):
    return auth.update_user(user_id, role=req.role, disabled=req.disabled, label=req.label,
                            actor=_p(request).username, ip=ip_of(request))


@router.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: Request):
    auth.delete_user(user_id, actor=_p(request).username, ip=ip_of(request))
    return {"ok": True}


@router.post("/admin/users/{user_id}/password")
async def admin_set_password(user_id: int, req: PasswordOnlyReq, request: Request):
    p = _p(request)
    await run_in_threadpool(auth.set_password, user_id, req.password,
                            except_hash=p.session_hash if user_id == p.user_id else None,
                            actor=p.username, ip=ip_of(request))
    return {"ok": True}


@router.post("/admin/users/{user_id}/reset-2fa")
def admin_reset_2fa(user_id: int, request: Request):
    auth.totp_disable(user_id, actor=_p(request).username, ip=ip_of(request))
    return {"ok": True}


@router.post("/admin/users/{user_id}/revoke-sessions")
def admin_revoke_user(user_id: int, request: Request):
    p = _p(request)
    n = auth.revoke_user_sessions(user_id, except_hash=p.session_hash, actor=p.username, ip=ip_of(request))
    return {"revoked": len(n)}


@router.get("/admin/devices")
def admin_devices():
    return auth.list_users("device")


def _require_device(user_id: int) -> None:
    # Both handlers below are thin wrappers around the person-account admin handlers, which have no
    # kind check of their own — without this, PATCH/DELETE /admin/devices/{id} would happily operate on a
    # person account (including granting role=admin) through the device-scoped route, blurring a boundary
    # the two route namespaces are meant to keep separate.
    u = auth.get_user(user_id)
    if u is None or u["kind"] != "device":
        raise auth.AuthError(404, "No such device")


@router.patch("/admin/devices/{user_id}")
def admin_update_device(user_id: int, req: UserPatch, request: Request):
    _require_device(user_id)
    return admin_update_user(user_id, req, request)


@router.delete("/admin/devices/{user_id}")
def admin_delete_device(user_id: int, request: Request):
    _require_device(user_id)
    return admin_delete_user(user_id, request)


@router.get("/admin/sessions")
def admin_sessions(request: Request):
    cur = (_p(request).session_hash or "")[:16]
    return [{**s, "current": s["id"] == cur} for s in auth.list_sessions(None)]


@router.delete("/admin/sessions/{sid}")
def admin_revoke_session(sid: str, request: Request):
    h = auth.session_hash_by_id(sid)
    if h is None:
        raise HTTPException(404, "No such session")
    auth.revoke_session(h, actor=_p(request).username, ip=ip_of(request))
    return {"ok": True}


@router.get("/admin/config")
def admin_config():
    cfg = auth.get_config()
    return {**cfg, "warnings": auth.config_warnings(cfg)}


@router.put("/admin/config")
def admin_set_config(patch: dict[str, Any], request: Request):
    cfg = auth.set_config(patch, actor=_p(request).username, ip=ip_of(request))
    return {**cfg, "warnings": auth.config_warnings(cfg)}


@router.get("/admin/audit")
def admin_audit(limit: int = 200):
    return auth.audit_list(limit)
