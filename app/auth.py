"""Optional sign-in: users and roles, scrypt passwords, TOTP + recovery codes, sessions, TV pairing, config,
audit log, rate limiting, client-IP/bypass resolution, and a lock-out CLI.

Auth is on iff at least one (person) user exists — see docs/superpowers/specs/2026-09-28-authentication-design.md.
Everything lives in data/auth.db, kept apart from settings.json (which /api/settings hands to the browser) and
from playback.db (a cache that's safe to delete). Only hashes of tokens, device codes and recovery codes are
stored; the raw values exist only in the cookie / on the user's screen.

CLI (works inside Docker: `docker compose exec sentinel-eye python app/auth.py …`):
    python app/auth.py list-users | reset-password <user> | disable-2fa <user> | revoke-sessions <user> | disable-auth
"""
import base64, hashlib, hmac, ipaddress, json, os, re, secrets, sqlite3, struct, sys, threading, time
from typing import Callable, Mapping

from settings import DATA

DB_FILE = DATA / "auth.db"
ROLES = ("viewer", "operator", "admin")
USERNAME_RE = re.compile(r"[A-Za-z0-9._@-]{1,64}")
MIN_PASSWORD = 10
PAIR_TTL = 600
PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: read off a TV across the room
DEVICE_TTL = 365 * 86400
CHALLENGE_TTL = 300
TOTP_PENDING_TTL = 600
AUDIT_DAYS = 90
PROXY_HEADERS = ("forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip")
CONFIG_DEFAULTS = {"require_2fa_admin": False, "bypass_cidrs": [], "bypass_role": "viewer",
                   "trusted_proxies": [], "session_hours": 12, "remember_days": 30}
_SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}

_lock = threading.RLock()
_local = threading.local()
_revoke_callbacks: list[Callable[[list[str]], None]] = []
_challenges: dict[str, tuple[int, bool, float]] = {}      # challenge -> (user_id, remember, expires)
_totp_pending: dict[int, tuple[str, float]] = {}           # user_id -> (secret, expires)
_last_prune = 0.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'person',     -- person | device (a paired TV is its own user)
    label TEXT NOT NULL DEFAULT '',          -- devices: "Living room TV"
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    totp_secret TEXT,
    totp_last_step INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_ts REAL NOT NULL,
    updated_ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_ts REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                      -- browser | device
    remember INTEGER NOT NULL DEFAULT 0,
    limited INTEGER NOT NULL DEFAULT 0,      -- admin that must enrol 2FA before anything else
    label TEXT NOT NULL DEFAULT '',
    created_ts REAL NOT NULL,
    last_seen_ts REAL NOT NULL,
    expires_ts REAL NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS pairings (
    device_code_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,          -- normalised: 8 chars, no dash
    ip TEXT NOT NULL DEFAULT '',
    created_ts REAL NOT NULL,
    expires_ts REAL NOT NULL,
    approved_role TEXT,
    approved_label TEXT,
    approved_by INTEGER
);
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    detail_json TEXT
);
"""


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _now() -> float:   # patched by tests
    return time.time()


def _conn():
    c = getattr(_local, "conn", None)
    if c is None:
        DATA.mkdir(exist_ok=True)
        if not DB_FILE.exists():
            # Created 0600 (it holds password hashes); SQLite gives its -wal/-shm files the same mode. Only
            # when missing: closing any fd on a file drops this process's POSIX locks on it, SQLite's included.
            os.close(os.open(DB_FILE, os.O_RDWR | os.O_CREAT, 0o600))
        c = sqlite3.connect(DB_FILE, timeout=30, isolation_level=None, check_same_thread=False)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.row_factory = sqlite3.Row
        with _lock:
            c.executescript(SCHEMA)
        _local.conn = c
    return c


def _q(sql, params=()):
    return _conn().execute(sql, params).fetchall()


def _one(sql, params=()):
    # Close the cursor: a half-read SELECT keeps a WAL read transaction open, and the connection would keep
    # seeing that old snapshot — missing changes made by the CLI in another process.
    cur = _conn().execute(sql, params)
    try:
        return cur.fetchone()
    finally:
        cur.close()


def _w(sql, params=()):
    with _lock:
        return _conn().execute(sql, params)


def rank(role: str) -> int:
    return ROLES.index(role) if role in ROLES else -1


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


token_hash = _sha


# ------------------------------------------------------------------ passwords

def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, dklen=32, maxmem=64 * 1024 * 1024, **_SCRYPT)
    b = lambda x: base64.b64encode(x).decode()
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b(salt)}${b(h)}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, h = stored.split("$")
        if algo != "scrypt":
            return False
        want = base64.b64decode(h)
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(want), maxmem=64 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, want)


_dummy_hash = None


def _dummy_verify(pw: str) -> None:
    """Same scrypt work for an unknown/disabled user as for a real one, so timing doesn't reveal usernames."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_hex(16))
    verify_password(pw, _dummy_hash)


def _check_password(pw: str) -> None:
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise AuthError(422, f"Passwords are at least {MIN_PASSWORD} characters")
    if len(pw) > 1024:
        raise AuthError(422, "That password is too long")


# ------------------------------------------------------------------ users

def enabled() -> bool:
    """Sign-in is on iff a person account exists. Not cached: the CLI may change it from another process."""
    return _one("SELECT 1 FROM users WHERE kind='person' LIMIT 1") is not None


def _public_user(r) -> dict | None:
    if r is None:
        return None
    return {"id": r["id"], "username": r["username"], "kind": r["kind"], "label": r["label"], "role": r["role"],
            "has_totp": bool(r["totp_secret"]), "disabled": bool(r["disabled"]), "created_ts": r["created_ts"]}


def get_user(user_id: int) -> dict | None:
    return _public_user(_one("SELECT * FROM users WHERE id=?", (user_id,)))


def get_user_by_name(username: str) -> dict | None:
    return _public_user(_one("SELECT * FROM users WHERE username=?", (username,)))


def list_users(kind: str | None = "person") -> list[dict]:
    rows = _q("""SELECT u.*, (SELECT MAX(last_seen_ts) FROM sessions s WHERE s.user_id=u.id) AS last_seen,
                        (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_ts > ?) AS nsessions
                 FROM users u WHERE (? IS NULL OR u.kind=?) ORDER BY u.kind, u.username""", (_now(), kind, kind))
    return [{**_public_user(r), "last_seen_ts": r["last_seen"], "sessions": r["nsessions"]} for r in rows]


def create_user(username: str, password: str, role: str, *, actor: str = "", ip: str = "") -> dict:
    username = (username or "").strip()
    if not USERNAME_RE.fullmatch(username) or username.lower().startswith("device:"):
        raise AuthError(422, "Usernames are 1-64 letters, digits, and . _ @ -")
    if role not in ROLES:
        raise AuthError(422, "Unknown role")
    _check_password(password)
    now = _now()
    try:
        cur = _w("INSERT INTO users(username, kind, pw_hash, role, created_ts, updated_ts) VALUES (?,?,?,?,?,?)",
                 (username, "person", hash_password(password), role, now, now))
    except sqlite3.IntegrityError:
        raise AuthError(409, "That username is taken")
    audit(actor or username, "user.create", username, ip, role=role)
    return get_user(cur.lastrowid)


def _other_admins(user_id: int) -> int:
    return _one("SELECT COUNT(*) FROM users WHERE kind='person' AND role='admin' AND disabled=0 AND id<>?",
                (user_id,))[0]


def _require_user(user_id: int):
    r = _one("SELECT * FROM users WHERE id=?", (user_id,))
    if r is None:
        raise AuthError(404, "No such user")
    return r


def update_user(user_id: int, *, role: str | None = None, disabled: bool | None = None, label: str | None = None,
                actor: str = "", ip: str = "") -> dict:
    r = _require_user(user_id)
    if role is not None:
        if role not in ROLES or (r["kind"] == "device" and role == "admin"):
            raise AuthError(422, "Unknown role" if role not in ROLES else "A device can't be an admin")
    is_admin_now = r["kind"] == "person" and r["role"] == "admin" and not r["disabled"]
    loses_admin = (role is not None and role != "admin") or bool(disabled)
    if is_admin_now and loses_admin and _other_admins(user_id) == 0:
        raise AuthError(409, "That's the last admin: add another admin first")
    sets, params = [], []
    if role is not None:
        sets.append("role=?"); params.append(role)
    if disabled is not None:
        sets.append("disabled=?"); params.append(int(bool(disabled)))
    if label is not None:
        sets.append("label=?"); params.append(label.strip()[:64])
    if sets:
        _w(f"UPDATE users SET {', '.join(sets)}, updated_ts=? WHERE id=?", (*params, _now(), user_id))
        audit(actor, "user.update", r["username"], ip, role=role, disabled=disabled, label=label)
    if disabled:
        revoke_user_sessions(user_id, actor=actor)
    return get_user(user_id)


def delete_user(user_id: int, *, actor: str = "", ip: str = "") -> None:
    r = _require_user(user_id)
    if r["kind"] == "person" and r["role"] == "admin" and not r["disabled"] and _other_admins(user_id) == 0:
        raise AuthError(409, "That's the last admin: add another admin first")
    hashes = [x["token_hash"] for x in _q("SELECT token_hash FROM sessions WHERE user_id=?", (user_id,))]
    _w("DELETE FROM users WHERE id=?", (user_id,))
    audit(actor, "device.delete" if r["kind"] == "device" else "user.delete", r["username"], ip)
    _fire_revoked(hashes)


def set_password(user_id: int, password: str, *, except_hash: str | None = None, actor: str = "", ip: str = "") -> None:
    r = _require_user(user_id)
    _check_password(password)
    _w("UPDATE users SET pw_hash=?, updated_ts=? WHERE id=?", (hash_password(password), _now(), user_id))
    audit(actor or r["username"], "user.password", r["username"], ip)
    revoke_user_sessions(user_id, except_hash=except_hash, actor=actor or r["username"])


def authenticate(username: str, password: str) -> dict | None:
    r = _one("SELECT * FROM users WHERE username=? AND kind='person'", ((username or "").strip(),))
    if r is None or r["disabled"]:
        _dummy_verify(password or "")
        return None
    if not verify_password(password or "", r["pw_hash"]):
        return None
    return _public_user(r)


def bootstrap_from_env(env: Mapping[str, str] = os.environ) -> None:
    """SENTINEL_ADMIN_USER / SENTINEL_ADMIN_PASSWORD create the first admin — only while no user exists, so
    leaving them set never overwrites a password changed later from the UI."""
    pw = env.get("SENTINEL_ADMIN_PASSWORD", "")
    if not pw or enabled():
        return
    create_user(env.get("SENTINEL_ADMIN_USER", "") or "admin", pw, "admin", actor="env")


# ------------------------------------------------------------------ TOTP (RFC 6238) + recovery codes

def totp_new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", step), "sha1").digest()
    off = mac[-1] & 0x0F
    return f"{(struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def totp_uri(secret: str, username: str) -> str:
    from urllib.parse import quote
    return f"otpauth://totp/{quote('Sentinel Eye:' + username)}?secret={secret}&issuer={quote('Sentinel Eye')}"


def totp_begin(user_id: int) -> tuple[str, str]:
    r = _require_user(user_id)
    secret = totp_new_secret()
    with _lock:
        _totp_pending[user_id] = (secret, _now() + TOTP_PENDING_TTL)
    return secret, totp_uri(secret, r["username"])


def _match_step(secret: str, code: str, after: int | None) -> int | None:
    code = re.sub(r"\s", "", code or "")
    if not re.fullmatch(r"\d{6}", code):
        return None
    cur = int(_now() // 30)
    for step in (cur - 1, cur, cur + 1):
        if (after is None or step > after) and hmac.compare_digest(totp_at(secret, step), code):
            return step
    return None


def totp_confirm(user_id: int, code: str, *, ip: str = "") -> list[str]:
    with _lock:
        pending = _totp_pending.get(user_id)
    if pending is None or pending[1] < _now():
        raise AuthError(400, "Start two-factor setup again")
    step = _match_step(pending[0], code, None)
    if step is None:
        raise AuthError(400, "That code isn't right; check the time on your phone")
    r = _require_user(user_id)
    _w("UPDATE users SET totp_secret=?, totp_last_step=?, updated_ts=? WHERE id=?", (pending[0], step, _now(), user_id))
    with _lock:
        _totp_pending.pop(user_id, None)
    audit(r["username"], "totp.enable", r["username"], ip)
    return new_recovery_codes(user_id)


def totp_check(user_id: int, code: str) -> bool:
    with _lock:   # read-check-write under the lock so one code can't be used twice concurrently
        r = _one("SELECT totp_secret, totp_last_step FROM users WHERE id=?", (user_id,))
        if r is None or not r["totp_secret"]:
            return False
        step = _match_step(r["totp_secret"], code, r["totp_last_step"])
        if step is None:
            return False
        _conn().execute("UPDATE users SET totp_last_step=? WHERE id=?", (step, user_id))
    return True


def totp_disable(user_id: int, *, actor: str = "", ip: str = "") -> None:
    r = _require_user(user_id)
    _w("UPDATE users SET totp_secret=NULL, totp_last_step=NULL, updated_ts=? WHERE id=?", (_now(), user_id))
    _w("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
    audit(actor or r["username"], "totp.disable", r["username"], ip)


def _norm_recovery(code: str) -> str:
    return re.sub(r"[\s-]", "", (code or "").lower())


def new_recovery_codes(user_id: int) -> list[str]:
    codes = [f"{h[:4]}-{h[4:]}" for h in (secrets.token_hex(4) for _ in range(10))]
    with _lock:
        c = _conn()
        c.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
        c.executemany("INSERT INTO recovery_codes(user_id, code_hash) VALUES (?,?)",
                      [(user_id, _sha(_norm_recovery(x))) for x in codes])
    return codes


def use_recovery_code(user_id: int, code: str) -> bool:
    h = _sha(_norm_recovery(code))
    with _lock:
        cur = _conn().execute("UPDATE recovery_codes SET used_ts=? WHERE user_id=? AND code_hash=? AND used_ts IS NULL",
                              (_now(), user_id, h))
    return cur.rowcount == 1


# ------------------------------------------------------------------ sessions

def _ttl(kind: str, remember: bool) -> float:
    if kind == "device":
        return DEVICE_TTL
    cfg = get_config()
    return cfg["remember_days"] * 86400 if remember else cfg["session_hours"] * 3600


def session_ttl(session: dict) -> float:
    return _ttl(session["kind"], bool(session["remember"]))


def create_session(user_id: int, *, kind: str = "browser", remember: bool = False, label: str = "", ip: str = "",
                   ua: str = "", limited: bool = False) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    _w("""INSERT INTO sessions(token_hash, user_id, kind, remember, limited, label, created_ts, last_seen_ts, expires_ts, ip, user_agent)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
       (_sha(token), user_id, kind, int(remember), int(limited), label[:64], now, now, now + _ttl(kind, remember),
        ip[:64], ua[:256]))
    return token


def lookup_session(token: str) -> tuple[dict, dict] | None:
    """(session, user) for a live cookie, else None. Slides the expiry at most once a minute; the returned
    session has "slid": True when it did, so the caller can refresh a persistent cookie's Max-Age."""
    if not token or len(token) > 128:
        return None
    h = _sha(token)
    r = _one("SELECT * FROM sessions WHERE token_hash=?", (h,))
    if r is None:
        return None
    now = _now()
    if r["expires_ts"] <= now:
        _w("DELETE FROM sessions WHERE token_hash=?", (h,))
        return None
    u = _one("SELECT * FROM users WHERE id=?", (r["user_id"],))
    if u is None or u["disabled"]:
        return None
    s = dict(r)
    s["slid"] = False
    if now - r["last_seen_ts"] >= 60:
        s["expires_ts"] = now + _ttl(r["kind"], bool(r["remember"]))
        s["last_seen_ts"] = now
        s["slid"] = True
        _w("UPDATE sessions SET last_seen_ts=?, expires_ts=? WHERE token_hash=?", (now, s["expires_ts"], h))
    return s, _public_user(u)


def set_session_limited(token_hash_: str, limited: bool) -> None:
    _w("UPDATE sessions SET limited=? WHERE token_hash=?", (int(limited), token_hash_))


def on_revoke(cb: Callable[[list[str]], None]) -> None:
    _revoke_callbacks.append(cb)


def _fire_revoked(hashes: list[str]) -> None:
    if hashes:
        for cb in list(_revoke_callbacks):
            try:
                cb(hashes)
            except Exception:
                pass


def revoke_session(token_hash_: str, *, actor: str = "", ip: str = "") -> None:
    r = _one("SELECT s.token_hash, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?",
             (token_hash_,))
    if r is None:
        return
    _w("DELETE FROM sessions WHERE token_hash=?", (token_hash_,))
    if actor:
        audit(actor, "session.revoke", r["username"], ip)
    _fire_revoked([token_hash_])


def revoke_user_sessions(user_id: int, *, except_hash: str | None = None, actor: str = "", ip: str = "") -> list[str]:
    hashes = [r["token_hash"] for r in _q("SELECT token_hash FROM sessions WHERE user_id=?", (user_id,))
              if r["token_hash"] != except_hash]
    with _lock:
        _conn().executemany("DELETE FROM sessions WHERE token_hash=?", [(h,) for h in hashes])
    if hashes and actor:
        u = get_user(user_id)
        audit(actor, "session.revoke_all", u["username"] if u else str(user_id), ip, count=len(hashes))
    _fire_revoked(hashes)
    return hashes


def list_sessions(user_id: int | None = None) -> list[dict]:
    rows = _q("""SELECT s.*, u.username, u.kind AS user_kind FROM sessions s JOIN users u ON u.id=s.user_id
                 WHERE s.expires_ts > ? AND (? IS NULL OR s.user_id=?) ORDER BY s.last_seen_ts DESC""",
              (_now(), user_id, user_id))
    return [{"id": r["token_hash"][:16], "user_id": r["user_id"], "username": r["username"], "kind": r["kind"],
             "label": r["label"], "ip": r["ip"], "user_agent": r["user_agent"], "created_ts": r["created_ts"],
             "last_seen_ts": r["last_seen_ts"], "expires_ts": r["expires_ts"], "remember": bool(r["remember"])}
            for r in rows]


def session_hash_by_id(sid: str, user_id: int | None = None) -> str | None:
    if not re.fullmatch(r"[0-9a-f]{16}", sid or ""):
        return None
    r = _one("SELECT token_hash FROM sessions WHERE token_hash LIKE ? AND (? IS NULL OR user_id=?)",
             (sid + "%", user_id, user_id))
    return r["token_hash"] if r else None


# ------------------------------------------------------------------ login challenges (password ok, TOTP pending)

def challenge_new(user_id: int, remember: bool) -> str:
    c = secrets.token_urlsafe(24)
    now = _now()
    with _lock:
        for k in [k for k, v in _challenges.items() if v[2] < now]:
            del _challenges[k]
        _challenges[c] = (user_id, remember, now + CHALLENGE_TTL)
    return c


def challenge_peek(challenge: str) -> tuple[int, bool] | None:
    with _lock:
        v = _challenges.get(challenge or "")
    if v is None or v[2] < _now():
        return None
    return v[0], v[1]


def challenge_take(challenge: str) -> tuple[int, bool] | None:
    with _lock:
        v = _challenges.pop(challenge or "", None)
    if v is None or v[2] < _now():
        return None
    return v[0], v[1]


# ------------------------------------------------------------------ device pairing

def _norm_user_code(code: str) -> str:
    return re.sub(r"[\s-]", "", (code or "").upper())


def pair_start(ip: str = "") -> dict:
    now = _now()
    _w("DELETE FROM pairings WHERE expires_ts <= ?", (now,))
    if _one("SELECT COUNT(*) FROM pairings WHERE ip=?", (ip,))[0] >= 5:
        raise AuthError(429, "Too many pairing codes from this device; wait a few minutes")
    device_code = secrets.token_urlsafe(32)
    for _ in range(10):
        user_code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(8))
        try:
            _w("INSERT INTO pairings(device_code_hash, user_code, ip, created_ts, expires_ts) VALUES (?,?,?,?,?)",
               (_sha(device_code), user_code, ip, now, now + PAIR_TTL))
            break
        except sqlite3.IntegrityError:
            continue
    return {"device_code": device_code, "user_code": f"{user_code[:4]}-{user_code[4:]}", "expires_in": PAIR_TTL}


def pair_approve(user_code: str, *, role: str, label: str, approver_id: int, ip: str = "") -> None:
    if role not in ("viewer", "operator"):
        raise AuthError(422, "A device can be a viewer or an operator")
    label = (label or "").strip()[:64] or "TV"
    with _lock:
        cur = _conn().execute("""UPDATE pairings SET approved_role=?, approved_label=?, approved_by=?
                                 WHERE user_code=? AND expires_ts > ? AND approved_role IS NULL""",
                              (role, label, approver_id, _norm_user_code(user_code), _now()))
    if cur.rowcount != 1:
        raise AuthError(404, "That code is wrong or has expired; get a new one on the TV")
    approver = get_user(approver_id)
    audit(approver["username"] if approver else "", "device.approve", label, ip, role=role)


def pair_poll(device_code: str, ip: str = "", ua: str = ""):
    """Session token once approved (the pairing is then consumed), None while pending, "expired" otherwise."""
    h = _sha(device_code or "")
    with _lock:
        r = _one("SELECT * FROM pairings WHERE device_code_hash=?", (h,))
        if r is None or r["expires_ts"] <= _now():
            return "expired"
        if r["approved_role"] is None:
            return None
        _conn().execute("DELETE FROM pairings WHERE device_code_hash=?", (h,))
    slug = re.sub(r"[^a-z0-9]+", "-", r["approved_label"].lower()).strip("-")[:32] or "device"
    now = _now()
    cur = _w("""INSERT INTO users(username, kind, label, pw_hash, role, created_ts, updated_ts)
                VALUES (?,?,?,?,?,?,?)""",
             (f"device:{slug}-{secrets.token_hex(2)}", "device", r["approved_label"], "!", r["approved_role"], now, now))
    return create_session(cur.lastrowid, kind="device", label=r["approved_label"], ip=ip, ua=ua)


# ------------------------------------------------------------------ config

def _cidrs(v) -> list[str]:
    if isinstance(v, str):
        v = [x for x in re.split(r"[\s,]+", v) if x]
    if not isinstance(v, list):
        raise AuthError(422, "Expected a list of networks")
    out = []
    for x in v:
        try:
            out.append(str(ipaddress.ip_network(str(x).strip(), strict=False)))
        except ValueError:
            raise AuthError(422, f"Not a network: {x}")
    return out


def get_config() -> dict:
    cfg = dict(CONFIG_DEFAULTS)
    for r in _q("SELECT key, value_json FROM config"):
        if r["key"] in cfg:
            cfg[r["key"]] = json.loads(r["value_json"])
    return cfg


def set_config(patch: dict, *, actor: str = "", ip: str = "") -> dict:
    clean = {}
    for k, v in patch.items():
        if k not in CONFIG_DEFAULTS:
            raise AuthError(422, f"Unknown setting: {k}")
        if k == "require_2fa_admin":
            clean[k] = bool(v)
        elif k in ("bypass_cidrs", "trusted_proxies"):
            clean[k] = _cidrs(v)
        elif k == "bypass_role":
            if v not in ("viewer", "operator"):
                raise AuthError(422, "Network access can be viewer or operator, never admin")
            clean[k] = v
        elif k == "session_hours":
            if not isinstance(v, int) or not 1 <= v <= 720:
                raise AuthError(422, "Session length is 1-720 hours")
            clean[k] = v
        elif k == "remember_days":
            if not isinstance(v, int) or not 1 <= v <= 365:
                raise AuthError(422, "Remember-me is 1-365 days")
            clean[k] = v
    with _lock:
        _conn().executemany("INSERT INTO config(key, value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                            [(k, json.dumps(v)) for k, v in clean.items()])
    if clean:
        audit(actor, "config.update", "", ip, **clean)
    return get_config()


def config_warnings(cfg: dict) -> list[str]:
    loop4, loop6 = ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128")
    for c in cfg["bypass_cidrs"]:
        n = ipaddress.ip_network(c)
        if (n.version == 4 and n.overlaps(loop4)) or (n.version == 6 and n.overlaps(loop6)):
            return [f"{c} includes this machine: a tunnel or reverse proxy running here would skip sign-in "
                    "for everyone it forwards (unless it adds X-Forwarded-For / CF-Connecting-IP headers)."]
    return []


# ------------------------------------------------------------------ audit

def audit(actor: str, action: str, target: str = "", ip: str = "", **detail) -> None:
    global _last_prune
    detail = {k: v for k, v in detail.items() if v is not None}
    now = _now()
    _w("INSERT INTO audit(ts, actor, action, target, ip, detail_json) VALUES (?,?,?,?,?,?)",
       (now, actor or "", action, target or "", ip or "", json.dumps(detail) if detail else None))
    if now - _last_prune > 3600:
        _last_prune = now
        _w("DELETE FROM audit WHERE ts < ?", (now - AUDIT_DAYS * 86400,))


def audit_list(limit: int = 200) -> list[dict]:
    rows = _q("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (max(1, min(limit, 2000)),))
    return [{"ts": r["ts"], "actor": r["actor"], "action": r["action"], "target": r["target"], "ip": r["ip"],
             "detail": json.loads(r["detail_json"]) if r["detail_json"] else {}} for r in rows]


# ------------------------------------------------------------------ rate limiting

class RateLimiter:
    """Per-key failure counter: 5 failures free, then 1, 2, 4… s between attempts, capped at 15 minutes."""
    FREE, CAP, FORGET = 5, 900, 3600

    def __init__(self):
        self._m: dict[tuple, tuple[int, float]] = {}   # key -> (failures, last failure time)
        self._l = threading.Lock()

    def _wait(self, key, now) -> float:
        n, last = self._m.get(key, (0, 0.0))
        if n <= self.FREE:
            return 0.0
        return max(0.0, last + min(2 ** (n - self.FREE - 1), self.CAP) - now)

    def check(self, *keys) -> float:
        now = _now()
        with self._l:
            return max([self._wait(k, now) for k in keys] + [0.0])

    def fail(self, *keys) -> None:
        now = _now()
        with self._l:
            if len(self._m) > 10000:
                self._m = {k: v for k, v in self._m.items() if now - v[1] < self.FORGET}
            for k in keys:
                n, last = self._m.get(k, (0, 0.0))
                if now - last > self.FORGET:
                    n = 0
                self._m[k] = (n + 1, now)

    def ok(self, *keys) -> None:
        with self._l:
            for k in keys:
                self._m.pop(k, None)


login_limiter = RateLimiter()


# ------------------------------------------------------------------ client IP, proxies, bypass

def _ip(s: str):
    try:
        a = ipaddress.ip_address((s or "").strip().strip("[]"))
    except ValueError:
        return None
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a


def _within(addr, cidrs: list[str]) -> bool:
    if addr is None:
        return False
    for c in cidrs:
        try:
            if addr in ipaddress.ip_network(c, strict=False):
                return True
        except (ValueError, TypeError):
            continue
    return False


def _lower(headers: Mapping[str, str]) -> dict:
    return {k.lower(): v for k, v in headers.items()}


def client_ip(peer: str, headers: Mapping[str, str], trusted_proxies: list[str]) -> str:
    """The peer address, unless the peer is a trusted proxy: then the address it says it forwarded for."""
    if not _within(_ip(peer), trusted_proxies):
        return peer or ""
    h = _lower(headers)
    cf = _ip(h.get("cf-connecting-ip", ""))
    if cf is not None:
        return str(cf)
    for part in reversed([p for p in h.get("x-forwarded-for", "").split(",") if p.strip()]):
        a = _ip(part)
        if a is None:
            break
        if not _within(a, trusted_proxies):
            return str(a)
    return peer or ""


def effective_scheme(scheme: str, peer: str, headers: Mapping[str, str], trusted_proxies: list[str]) -> str:
    if _within(_ip(peer), trusted_proxies):
        proto = _lower(headers).get("x-forwarded-proto", "").split(",")[0].strip().lower()
        if proto in ("http", "https"):
            return proto
    return "https" if scheme in ("https", "wss") else "http"


def bypass_role(peer: str, headers: Mapping[str, str], cfg: dict) -> str | None:
    """Role for a request from a listed network, or None. Never for anything that came through a proxy:
    a tunnel on this host makes internet traffic arrive from 127.0.0.1 with forwarding headers on it."""
    if not cfg.get("bypass_cidrs"):
        return None
    h = _lower(headers)
    if any(k in h for k in PROXY_HEADERS):
        return None
    if not _within(_ip(peer), cfg["bypass_cidrs"]):
        return None
    return cfg["bypass_role"] if cfg.get("bypass_role") in ("viewer", "operator") else "viewer"


# ------------------------------------------------------------------ CLI

def _cli(argv: list[str]) -> int:
    import argparse, getpass
    ap = argparse.ArgumentParser(prog="auth.py", description="Sentinel Eye sign-in recovery tools")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list-users")
    for name in ("reset-password", "disable-2fa", "revoke-sessions"):
        sub.add_parser(name).add_argument("user")
    sub.add_parser("disable-auth")
    a = ap.parse_args(argv)

    def find(name):
        u = get_user_by_name(name)
        if u is None:
            print(f"No user named {name!r}", file=sys.stderr)
            raise SystemExit(1)
        return u

    try:
        if a.cmd == "list-users":
            for u in list_users(None):
                print(f"{u['username']:32} {u['role']:9} {'2fa' if u['has_totp'] else '   '} "
                      f"{'disabled' if u['disabled'] else ''}")
            if not enabled():
                print("(sign-in is off: no accounts)")
        elif a.cmd == "reset-password":
            u = find(a.user)
            if sys.stdin.isatty():
                pw = getpass.getpass("New password: ")
                if getpass.getpass("Again: ") != pw:
                    print("Passwords don't match", file=sys.stderr)
                    return 1
            else:
                pw = sys.stdin.readline().rstrip("\n")
            set_password(u["id"], pw, actor="cli")
            print(f"Password changed for {u['username']}; their sessions were signed out.")
        elif a.cmd == "disable-2fa":
            u = find(a.user)
            totp_disable(u["id"], actor="cli")
            print(f"Two-factor authentication is off for {u['username']}.")
        elif a.cmd == "revoke-sessions":
            u = find(a.user)
            n = len(revoke_user_sessions(u["id"], actor="cli"))
            print(f"Signed out {n} session(s) of {u['username']}.")
        elif a.cmd == "disable-auth":
            print("This deletes every account, device and session; the app then opens without sign-in.")
            if input("Type DELETE to continue: ").strip() != "DELETE":
                print("Nothing changed.")
                return 1
            hashes = [r["token_hash"] for r in _q("SELECT token_hash FROM sessions")]
            with _lock:
                _conn().executescript("DELETE FROM sessions; DELETE FROM recovery_codes; DELETE FROM pairings; DELETE FROM users;")
            audit("cli", "auth.disable")
            _fire_revoked(hashes)
            print("Sign-in is off.")
    except AuthError as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
