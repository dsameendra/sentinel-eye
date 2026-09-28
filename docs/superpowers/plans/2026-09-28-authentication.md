# Optional Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional multi-user login for Sentinel Eye with roles, TOTP, TV pairing, revocable sessions and an opt-in network bypass. With no users, behaviour is unchanged.

**Architecture:** A new `app/auth.py` owns everything stateful (users, sessions, TOTP, recovery codes, pairings, config, audit) in `data/auth.db`, plus the pure helpers for client-IP/bypass resolution. `app/server.py` gains one HTTP middleware that resolves a principal and enforces a single route→role table (fail-closed: an `/api/` path missing from the table needs `admin`), the same check at the top of both WebSocket handlers, a registry that closes a revoked session's sockets, and the `/api/auth/*` endpoints. The frontend gets a standalone login/pair page, 401/403 handling, role-aware navigation, an account menu and a Settings → Security tab.

**Tech Stack:** Python 3.14 stdlib (`hashlib.scrypt`, `hmac`, `secrets`, `sqlite3`, `ipaddress`), FastAPI/Starlette, vanilla ES modules, a vendored MIT QR generator. Tests: `tools/test_*.py` scripts (repo pattern), HTTP/WS checks via Starlette `TestClient` (needs `httpx`, added as a dev-only requirement).

**Spec:** `docs/superpowers/specs/2026-09-28-authentication-design.md`

## Global Constraints

- **No users ⇒ no auth.** Every request is then an `admin` principal with `via="none"`; no login page, no cookies. Existing installs upgrade with zero behaviour change.
- No new runtime Python dependency. `httpx` goes in a new `requirements-dev.txt` only.
- `auth.db` lives in `settings.DATA`, created `0o600`, WAL, a module lock around writes (same pattern as `db.py`).
- Only SHA-256 of session tokens, device codes and recovery codes is stored. Passwords: `scrypt$n$r$p$salt_b64$hash_b64`, `n=2**15, r=8, p=1, maxmem=64 MiB`, 32-byte output.
- All secret comparisons use `hmac.compare_digest`.
- Cookie `se_session`: `HttpOnly; SameSite=Strict; Path=/`, `Secure` only when the effective scheme is https. `Max-Age` set only for remember-me/device sessions.
- Non-GET requests (HTTP) must have an `Origin` (or, failing that, `Referer`) whose host equals `Host`; else 403. Applies with auth off too (it's free CSRF hardening; the WS handlers already do this).
- Bypass never yields `admin`; never applies when any of `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` is present; `127.0.0.0/8` and `::1` are bypassed only if listed explicitly.
- The last enabled admin can't be deleted, disabled or demoted (409).
- `bookmarks.author` and export `author` use the principal's username (`"Operator"` when auth is off, as today).
- Error messages on login never distinguish unknown user / wrong password / disabled user.
- Run everything from the repo root with `.venv/bin/python3`; the app imports modules flat (`--app-dir app`), tests do `sys.path.insert(0, "app")` after setting `SENTINEL_DATA` to a scratch dir.

## Review Focus

1. **Tunnel on the same host + bypass configured for the LAN** → internet requests via the tunnel (peer `127.0.0.1`, `CF-Connecting-IP` set) must hit the login page. Pinned in Task 3 (unit) and Task 5 (HTTP).
2. **A route added later and forgotten in the role table** → must require `admin`, not be open. Pinned in Task 5 ("unknown /api path needs admin").
3. **Revoking a TV** → its live `/ws` stream stops within a second, not at the next reconnect. Pinned in Task 5.
4. **Docker healthcheck with auth on** → still healthy; unauthenticated `/api/status` leaks nothing but `go2rtc`. Pinned in Task 5 and Task 8.
5. **Locked out (forgot password / lost phone)** → CLI in the container fixes it without deleting data. Pinned in Task 2.
6. **Service worker** → a cached shell for a logged-out user must still end up on `/login`, not a blank app. Pinned in Task 6 (manual check list).

---

## File Structure

| File | Responsibility |
|---|---|
| `app/auth.py` (create) | Storage, passwords, TOTP, sessions, recovery codes, pairing, config, audit, rate limiting, IP/bypass helpers, CLI. |
| `app/server.py` (modify) | Principal middleware + route role table, CSRF origin check, WS guards + registry, `/api/auth/*`, redacted settings/status, real authors. |
| `requirements-dev.txt` (create) | `httpx` for `TestClient`. |
| `tools/test_auth_core.py` (create) | Unit checks for `auth.py`. |
| `tools/test_auth_http.py` (create) | HTTP + WebSocket checks against `server.app`. |
| `web/login.html`, `web/js/login.js` (create) | Login, TOTP step, pair-this-device. |
| `web/pair.html`, `web/js/pair.js` (create) | Admin approves a pairing code. |
| `web/vendor/qrcode.js` (create) | Vendored MIT QR generator (e.g. `qrcode-generator` 1.4.4), with its license header. |
| `web/js/api.js` (modify) | 401 → `/login?next=`, 403 → readable error; auth endpoints; `getJSON` helper for the raw `fetch` call sites. |
| `web/js/main.js` (modify) | `me` at boot, role-gated nav/routes, account menu. |
| `web/js/account.js` (create) | Account modal: change password, 2FA enrol/disable, recovery codes, my sessions, log out. |
| `web/js/settings.js` (modify) | Security tab (admin), hide admin-only tabs for others. |
| `web/js/live.js`, `events.js`, `timeline.js`, `datepicker.js`, `dvrtime.js`, `playback.js`, `wcplayer.js` (modify) | Raw `fetch` → `getJSON`; WS close `4401` → login redirect. |
| `web/css/app.css` (modify) | Login/pair pages, account menu, security tab. |
| `web/sw.js` (modify) | Never cache `/login*`, `/pair*`; bump `CACHE_NAME` to `-v3`. |
| `README.md`, `compose.yaml` (modify) | Authentication docs; env vars; replace "no login" statements. |
| `tools/test_docker_compose.sh` (modify) | Healthcheck case with auth enabled. |

---

### Task 1: `auth.py` — storage, passwords, users, TOTP

**Files:** Create `app/auth.py`, `tools/test_auth_core.py`, `requirements-dev.txt`.

**Interfaces produced:**

```python
ROLES = ("viewer", "operator", "admin")
def rank(role: str) -> int                      # viewer 0, operator 1, admin 2
class AuthError(Exception): status: int         # 400/403/409/422 with a user-facing message

def enabled() -> bool                           # any user exists (cached; invalidated on user writes)
def hash_password(pw: str) -> str
def verify_password(pw: str, stored: str) -> bool
def create_user(username: str, password: str, role: str) -> dict
def update_user(user_id: int, *, role=None, disabled=None, actor=None) -> dict
def set_password(user_id: int, password: str) -> None
def delete_user(user_id: int, actor=None) -> None
def get_user(user_id: int) -> dict | None       # never includes pw_hash / totp_secret
def list_users() -> list[dict]                  # + has_totp, session count
def authenticate(username: str, password: str) -> dict | None   # None for unknown/wrong/disabled; constant work

def totp_new_secret() -> str                    # base32, 20 random bytes
def totp_uri(secret: str, username: str) -> str # otpauth://totp/Sentinel%20Eye:<user>?secret=…&issuer=Sentinel%20Eye
def totp_at(secret: str, step: int) -> str      # RFC 6238 / 4226, SHA-1, 6 digits
def totp_begin(user_id) -> (secret, uri)        # pending secret held in memory 10 min, not saved
def totp_confirm(user_id, code) -> list[str]    # saves secret, returns 10 fresh recovery codes
def totp_check(user_id, code) -> bool           # ±1 step, step must be > totp_last_step, then stores it
def totp_disable(user_id) -> None               # also deletes recovery codes
def new_recovery_codes(user_id) -> list[str]    # "xxxx-xxxx", 10, replaces old ones
def use_recovery_code(user_id, code) -> bool
def bootstrap_from_env(env=os.environ) -> None  # SENTINEL_ADMIN_USER (default "admin") / SENTINEL_ADMIN_PASSWORD, only when no users
```

Validation: username `^[A-Za-z0-9._@-]{1,64}$` (case-insensitive unique), password ≥ 10 chars and ≤ 1024, role in `ROLES`.

- [ ] **Step 1: failing tests** in `tools/test_auth_core.py` (scratch `SENTINEL_DATA` via `tempfile.mkdtemp()` set before importing `auth`):
  - `enabled()` False on a fresh dir; True after `create_user`.
  - hash/verify round trip; wrong password False; stored format starts with `scrypt$32768$8$1$`.
  - `authenticate` ok / wrong pw / unknown user / disabled user; unknown user takes ≥ 50 % of a real verify's time.
  - duplicate username (different case) → `AuthError` 409; short password → 422; bad role → 422.
  - last admin: delete / disable / demote → 409; with two admins, one can be demoted.
  - TOTP: RFC 6238 vector (secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, T=59 → `287082`, T=1111111109 → `081804`); `totp_check` accepts current and ±1 step, rejects ±2, rejects the same code twice.
  - recovery codes: 10 unique, each usable once, `new_recovery_codes` invalidates old ones.
  - `bootstrap_from_env` creates the admin once; a second call with a different password changes nothing.
  - `auth.db` mode is `0o600`.
- [ ] **Step 2:** run `.venv/bin/python3 tools/test_auth_core.py` → FAIL (no module).
- [ ] **Step 3:** implement. Schema exactly as in the spec (`users`, `recovery_codes`, `sessions`, `pairings`, `config`, `audit`), created in `_conn()` like `db.py`. TOTP core:

```python
def totp_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", step), "sha1").digest()
    off = mac[-1] & 0x0F
    return f"{(struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"
```

  Dummy verify: a module-level `_DUMMY = hash_password(secrets.token_hex())` computed lazily; `authenticate` verifies against it when the user is unknown or disabled.
- [ ] **Step 4:** tests PASS. Create `requirements-dev.txt` with `-r requirements.txt` and `httpx==<current>` (pin the version pip resolves).
- [ ] **Step 5:** commit `auth: users, scrypt passwords, TOTP and recovery codes`.

### Task 2: `auth.py` — sessions, pairing, config, audit, rate limiting, CLI

**Interfaces produced:**

```python
SESSION_TTL = {"browser": 12*3600, "remember": 30*86400, "device": 365*86400}   # sliding
def create_session(user_id, *, kind="browser", remember=False, label="", ip="", ua="", limited=False) -> str  # raw token
def lookup_session(token: str) -> tuple[dict, dict] | None  # (session, user); slides expiry, touches last_seen ≤ 1/min; None if expired/disabled user
def revoke_session(token_hash: str, actor=None) -> None
def revoke_user_sessions(user_id, *, except_hash=None, actor=None) -> list[str]   # returns revoked hashes
def list_sessions(user_id=None) -> list[dict]   # hash prefix id (first 16 hex), kind, label, ip, ua, created, last_seen, expires
def token_hash(token: str) -> str
def on_revoke(cb: Callable[[list[str]], None]) -> None   # server registers its WS closer

def challenge_new(user_id, remember) -> str      # 5 min, single use, in memory
def challenge_take(challenge) -> tuple[int, bool] | None

PAIR_TTL = 600
def pair_start(ip) -> dict                       # {"device_code", "user_code": "K7QM-4TXD", "expires_in"}
def pair_approve(user_code, *, role, label, approver_id) -> None   # role ∈ {viewer, operator}; AuthError 404 unknown/expired
def pair_poll(device_code, ip, ua) -> str | None | Literal["expired"]  # token once approved (then pairing deleted), None while pending

CONFIG_DEFAULTS = {"require_2fa_admin": False, "bypass_cidrs": [], "bypass_role": "viewer",
                   "trusted_proxies": [], "session_hours": 12, "remember_days": 30}
def get_config() -> dict
def set_config(patch: dict, actor=None) -> dict  # validates CIDRs with ipaddress, bypass_role ∈ {viewer, operator}

def audit(actor, action, target="", ip="", **detail) -> None   # prunes rows > 90 days on write, at most once an hour
def audit_list(limit=200) -> list[dict]

class RateLimiter:                               # in memory
    def check(self, *keys) -> float              # seconds to wait (0 = allowed); keys like ("ip", ip), ("user", name)
    def fail(self, *keys) -> None                # after 5 failures: 2**(n-5) s, capped at 900
    def ok(self, *keys) -> None                  # reset
login_limiter, pair_limiter
```

`user_code` alphabet: `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 8 chars, shown as `XXXX-XXXX`, matched ignoring case and dashes. `set_password` revokes all of that user's sessions except the caller's (pass `except_hash`). Disabling or deleting a user revokes all theirs. Changing a role doesn't revoke (role is read per request).

CLI (`python app/auth.py <cmd>`): `list-users`, `reset-password <user>` (prompts twice with `getpass`, or reads stdin when not a tty), `disable-2fa <user>`, `revoke-sessions <user>`, `disable-auth` (asks to type `DELETE`, then deletes all users, sessions, pairings; keeps config and audit). Each writes an audit row with actor `cli`.

- [ ] **Step 1: failing tests** appended to `tools/test_auth_core.py`:
  - session create → lookup ok; lookup of a random token None; expiry (monkeypatch `auth._now`) → None; sliding: a lookup near expiry extends it.
  - disabled user's session → None; `set_password(except_hash=h)` keeps `h`, revokes others; `on_revoke` callback receives the revoked hashes.
  - only hashes stored: raw token not found anywhere in `auth.db` bytes.
  - challenge single-use and expires.
  - pairing: start → poll None → approve (with dashes/lowercase) → poll returns a token whose session is `kind="device"` and whose user is a new `kind='device'` user with the approved role (see note) → second poll `"expired"`; approve with role `admin` → 422; expired code → 404.
  - config: invalid CIDR 422; `bypass_role="admin"` 422.
  - rate limiter: 5 fails free, 6th → wait ≥ 1 s, cap 900, `ok` resets.
  - CLI via `subprocess` with `SENTINEL_DATA` set: `reset-password` through stdin works; `disable-2fa` clears TOTP; `disable-auth` with `DELETE` makes `enabled()` False.

  **Note on device identity:** a paired device gets its own row in `users` (username `device:<label-slug>-<4 hex>`, random unusable password, `role` = approved role, flagged `kind='device'` via a `users.kind` column default `'person'`). That way a device's role and revocation are independent of any person, `list_users()` can filter them into the Devices list, and devices never count as "the last admin". Add `kind TEXT NOT NULL DEFAULT 'person'` to the Task 1 schema.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commit `auth: sessions, device pairing, config, audit, rate limits, recovery CLI`.

### Task 3: client IP, proxies and bypass (pure functions)

**Interfaces produced (in `auth.py`):**

```python
PROXY_HEADERS = ("forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip")
def client_ip(peer: str, headers: Mapping[str, str], trusted_proxies: list[str]) -> str
def effective_scheme(scope_scheme: str, peer: str, headers, trusted_proxies) -> str   # honours X-Forwarded-Proto only from a trusted proxy
def bypass_role(peer: str, headers, cfg: dict) -> str | None
```

`client_ip`: if `peer` is in a trusted CIDR, use `CF-Connecting-IP` if present, else walk `X-Forwarded-For` right-to-left skipping trusted addresses and return the first untrusted one; otherwise `peer`. Invalid addresses fall back to `peer`.

`bypass_role`: `None` if any `PROXY_HEADERS` present (case-insensitive) or `bypass_cidrs` empty; else `cfg["bypass_role"]` if `peer` is inside a listed CIDR (IPv4-mapped IPv6 normalised), else `None`.

- [ ] **Step 1: failing tests** (`tools/test_auth_core.py`):
  - LAN `192.168.1.20`, cidrs `["192.168.1.0/24"]` → `"viewer"`.
  - same peer + `X-Forwarded-For: 1.2.3.4` → `None`. Peer `127.0.0.1` + `CF-Connecting-IP` with cidrs `["127.0.0.0/8"]` → `None`.
  - peer `127.0.0.1`, cidrs `["192.168.1.0/24"]` → `None`.
  - `::ffff:192.168.1.20` matches `192.168.1.0/24`.
  - `client_ip` untrusted peer ignores XFF; trusted peer `127.0.0.1` with `XFF: 9.9.9.9, 10.0.0.2` and trusted `["127.0.0.0/8","10.0.0.0/8"]` → `9.9.9.9`; garbage XFF → peer.
  - `effective_scheme` https only from trusted proxy.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `auth: client IP, trusted proxies and bypass resolution`.

### Task 4: server — principal middleware, role table, CSRF, WS guards

**Files:** modify `app/server.py`.

**Interfaces produced:**

```python
@dataclass
class Principal:
    user_id: int | None; username: str; role: str; via: Literal["session", "bypass", "none", "anon"]
    session_hash: str | None = None; limited: bool = False
def principal_for(scope_like) -> Principal       # shared by the middleware and both WS handlers

ROUTE_ROLES: list[tuple[str, re.Pattern, str]]    # (method or "*", path regex, min role); first match wins
PUBLIC_PATHS: re.Pattern                          # login/pair pages + their assets, /api/auth/{login,login/totp,pair/start,pair/poll,me}, /manifest.json, /sw.js, /icons/, /api/status
```

Role table (translate the spec table; order matters):

```
GET  /api/settings                    viewer   (handler redacts for non-admin)
PUT  /api/display                     operator
*    /api/settings | /api/test | /api/discover     admin
*    /api/timeline/ | /api/playback/ | /api/bookmarks | /api/export | /api/enhance   operator
*    /api/auth/admin/                 admin
*    /api/auth/                       viewer   (own account endpoints)
GET  /api/status                      public, full body only for viewer+
*    /api/…anything else              admin    (fail closed)
GET  non-/api paths (the SPA shell, js, css, vendor)   viewer → else 302 /login?next=
```

Middleware order of checks: (1) non-GET/HEAD/OPTIONS → CSRF origin check; (2) resolve principal: auth off → `admin/none`; cookie → `lookup_session`; else `bypass_role`; else `anon`; (3) `limited` sessions may only call `/api/auth/me`, `/api/auth/totp/*`, `/api/auth/logout` (else 403 `{"detail": "Set up two-factor authentication first", "code": "2fa_required"}`); (4) public path → pass; (5) anon → 302 for HTML (`Accept` contains `text/html` or path has no extension), 401 JSON for `/api/`; (6) rank below table role → 403. Principal stored on `request.state.principal`.

WS handlers: before the existing Origin check, `p = principal_for(ws)`; `anon` → `close(4401)`; `/api/playback/ws` needs operator → `close(4403)`; `/ws` needs viewer. After `accept()`, register `ws` in `_ws_by_session[p.session_hash]` (skip when `None`), unregister in `finally`. `auth.on_revoke(_close_revoked)` is registered in `lifespan`; `_close_revoked(hashes)` schedules `ws.close(4401)` on the event loop via `loop.call_soon_threadsafe` (revocation can happen in a threadpool).

Also in this task:
- `get_settings()` → for non-admins return `{"channels": …, "display": …, "connection": {"channel_zero": …}}` only (`live.js` reads `connection.channel_zero`; grep `settings().connection` in `web/js` and keep exactly the fields read outside `settings.js`).
- `status()` → if `request.state.principal.via == "anon"` return `{"go2rtc": …}` only.
- `create_bookmark` / `create_export`: author = `p.username` if `p.via == "session"`, `"Operator"` otherwise (bypass shows `"LAN (<role>)"`).
- `bootstrap_from_env()` called at import time (before first request), next to `state = …`.

- [ ] **Step 1: failing tests** `tools/test_auth_http.py` using `TestClient(server.app)` **without** the `with` block (no lifespan, no go2rtc/DVR). Handlers that touch `state["playback"]` may 500 — role checks assert on `status_code not in (401, 403)` vs `== 401/403`, never on 200. Helpers: `login(client, user, pw)`, `as_role(role)` creating users via `auth.create_user`. Cases:
  - auth off: `GET /api/settings` 200 full; `PUT /api/display` without Origin but GET works; non-GET with foreign `Origin` → 403.
  - auth on, anon: `GET /` → 302 `/login?next=%2F`; `GET /api/settings` → 401; `GET /login.html` 200; `GET /api/status` → only key `go2rtc` (monkeypatch `state["go2rtc"]` with a stub whose `status()`/`up()` return fixed values).
  - role matrix: for each (method, path) sample from the table × {viewer, operator, admin} → allowed or 403 as specified. Include `GET /api/nonexistent-future` → 403 for operator (fail closed).
  - viewer `GET /api/settings` has no `host`/`username`/`has_password`.
  - WS: `client.websocket_connect("/ws?src=x")` anon → closed 4401; viewer on `/api/playback/ws` → 4403.
  - revocation closes WS: stub the go2rtc upstream by monkeypatching `websockets.connect` with an async context manager that yields forever; connect as viewer, `auth.revoke_user_sessions(uid)`, expect a close 4401 within 1 s.
  - bypass: `TestClient(server.app, client=("192.168.1.20", 5000))` with cidrs set → `GET /api/settings` 200 redacted; same with `X-Forwarded-For` → 401.
  - `limited` session → `GET /api/settings` 403 `2fa_required`, `/api/auth/me` 200.
- [ ] **Step 2–4:** FAIL → implement → PASS. Re-run `tools/test_auth_core.py`.
- [ ] **Step 5:** commit `server: enforce roles on every route and WebSocket when auth is on`.

### Task 5: server — `/api/auth/*` endpoints

All bodies are pydantic models; all mutating ones audit. `ip = auth.client_ip(...)`.

| Endpoint | Behaviour |
|---|---|
| `GET /api/auth/me` | `{auth_enabled, via, user: {id, username, role, has_totp} \| null, limited, bypass_available}` — public. |
| `POST /api/auth/login {username, password, remember}` | Limiter on `("ip", ip)` and `("user", lower(username))` → 429 with `Retry-After`. Fail → 401 `"Wrong username or password"`. User has TOTP → `{"totp_required": true, "challenge"}`. Else cookie + `me`. Admin without TOTP and `require_2fa_admin` → session `limited=True`. |
| `POST /api/auth/login/totp {challenge, code}` | Code is 6 digits → `totp_check`; else `use_recovery_code`. Same limiter. |
| `POST /api/auth/logout` | Revoke current session, expire cookie. |
| `POST /api/auth/password {current, new}` | Verifies current, `set_password(except_hash=current)`. |
| `POST /api/auth/totp/begin` → `{secret, uri}`; `/totp/confirm {code}` → `{recovery_codes}`; `/totp/disable {password}`; `/totp/recovery {password}` → new codes | Confirm on a `limited` session upgrades it (`limited=False`). |
| `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`, `POST /api/auth/sessions/revoke-others` | Own sessions only; `id` is the 16-hex prefix. |
| `POST /api/auth/pair/start` | Public, `pair_limiter` by IP, max 5 pending per IP. |
| `POST /api/auth/pair/poll {device_code}` | Public; on approval sets a device cookie (`Max-Age` 1 year). |
| `POST /api/auth/pair/approve {code, role, label}` | Admin. |
| `GET/POST /api/auth/admin/users`, `PATCH/DELETE /api/auth/admin/users/{id}`, `POST …/{id}/password`, `POST …/{id}/reset-2fa`, `POST …/{id}/revoke-sessions` | Admin. **`POST /admin/users` while auth is off** creates the first admin (role forced to `admin`) and logs this browser in (cookie in the response). |
| `GET /api/auth/admin/devices`, `PATCH/DELETE …/{id}` | Devices = users with `kind='device'`; delete revokes. |
| `GET /api/auth/admin/sessions`, `DELETE …/{id}` | All sessions. |
| `GET/PUT /api/auth/admin/config` | `PUT` accepts loopback CIDRs but its response includes `warnings: ["127.0.0.0/8 is listed: a tunnel or proxy on this host would bypass login"]` when loopback is listed. |
| `GET /api/auth/admin/audit?limit=` | Newest first. |

- [ ] **Step 1: failing tests** in `tools/test_auth_http.py`:
  - first-admin flow: auth off → `POST /api/auth/admin/users` → cookie set, `me.via == "session"`, now anon gets 401.
  - login ok / wrong / 6th fast failure → 429 with `Retry-After`; unknown and wrong give identical body.
  - TOTP login: login → challenge → wrong code 401 → right code 200; recovery code works once.
  - `require_2fa_admin`: admin without TOTP gets `limited`; after `totp/confirm` full access without re-login.
  - logout clears cookie; old cookie → 401.
  - password change revokes a second client's session, keeps the caller's.
  - pairing end to end with two clients (TV anon, admin): start → approve → poll sets cookie → TV `GET /api/settings` 200 redacted → admin deletes device → TV 401.
  - admin can't demote self when last admin → 409; operator calling `/api/auth/admin/users` → 403.
  - config warning for `127.0.0.0/8`.
  - cookie flags: `HttpOnly`, `SameSite=Strict`, no `Secure` over http; `Secure` with `X-Forwarded-Proto: https` from a trusted proxy.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `server: login, 2FA, sessions, pairing and user admin endpoints`.

### Task 6: frontend — login, pairing, 401/403 handling, role-aware shell

- [ ] `web/login.html` + `web/js/login.js` (no import of the app's views; reuse `css/app.css` tokens and `ui.js`'s `icon`/`esc` only):
  - Form: username, password, "Keep me signed in on this device", submit; 429 shows the wait; TOTP step with "Use a recovery code" link; on success `location.replace(next || '/')` (only same-origin paths starting with `/` and not `//`).
  - "Pair this device" button (prominent when `localStorage['sentinel-eye-tv-mode']==='1'` or `?pair=1`): calls `pair/start`, shows the code large + QR of `${origin}/pair.html?code=…` via `web/vendor/qrcode.js`, polls every 3 s, countdown, "Get a new code" on expiry.
  - If `me.auth_enabled` is false or already logged in → redirect to `/`.
- [ ] `web/pair.html` + `web/js/pair.js`: requires admin (else redirect to `/login?next=`); code field prefilled from `?code=`, device name, role select (Viewer default, Operator), Approve → success state.
- [ ] `web/js/api.js`: in `call()`, `401` → `location.assign('/login.html?next=' + encodeURIComponent(location.pathname + location.hash))` and throw; `403` with `code === '2fa_required'` → open the account modal on the 2FA step; export `getJSON(url)` using the same handling; add `me`, `logout`, and the account/admin endpoint wrappers used by Tasks 6–7.
- [ ] Replace raw `fetch(...).then(r => r.json())` in `live.js`, `events.js`, `timeline.js`, `datepicker.js`, `dvrtime.js`, `playback.js` with `getJSON`.
- [ ] `wcplayer.js` and the go2rtc player path (`tile.js`/`vendor/video-rtc.js` close handler — find where the live WS reconnects): close code `4401` → same login redirect instead of retry; `4403` → show "Your role can't open playback" and stop retrying.
- [ ] `main.js`: `boot()` fetches `api.me()` before settings. Store in `state.me`, expose `ctx.me()` and `ctx.can(role)`. Hide nav items: Playback/Events need operator, Settings visible to all (Display tab only for viewer: per-browser TV options). `route()` redirects a disallowed section to `#/live` with a toast. When `auth_enabled && via === 'session'`: user button in `.tools` (username + role chip) → menu: Account…, Pair a device (admin), Log out. When `via === 'bypass'`: a small "LAN access (viewer)" chip with a "Sign in" link.
- [ ] `web/sw.js`: skip `/login.html`, `/pair.html`, `/js/login.js`, `/js/pair.js`; bump to `sentinel-eye-shell-v3`. Keep the existing `/api/` skip.
- [ ] Manual checks (write results into the commit message body): logged-out installed PWA opens → lands on login; TV-mode browser → pairing code is readable at 3 m; phone scans QR → approve; after revoking, the TV's grid goes to login within seconds.
- [ ] Commit `web: login page, device pairing and role-aware navigation`.

### Task 7: frontend — account modal and Settings → Security

- [ ] `web/js/account.js`: modal (use the existing `#modal-root` pattern from `ui.js`) with sections: Password (current/new/confirm, ≥ 10 chars client-side too); Two-factor (begin → QR of `uri` + secret text → confirm code → show recovery codes once with Copy/Download .txt; disable with password; regenerate codes); Sessions (this device marked, revoke one, revoke all others); Log out.
- [ ] `settings.js`: TABS become role-aware — `connection`, `channels`, `enhancement`, `status` admin-only; `display` for all but the shared layout/order/quality controls disabled for viewers with a hint; new `security` tab (icon `lock`, add to `ui.js` icons if missing), admin-only, or visible to everyone while auth is off (it's where auth gets enabled).
- [ ] Security tab contents:
  - Auth off: explanation + "Enable sign-in" form (username, password ×2) → `POST /api/auth/admin/users` → reload.
  - Users table: username, role select, 2FA badge, last seen, disabled toggle, actions (reset password, reset 2FA, sign out everywhere, delete); "Add user".
  - Devices: label, role, last seen, IP → rename, change role, revoke; "Pair a device" (opens `/pair.html`).
  - Sessions: all users, revoke.
  - Access: require 2FA for admins; bypass CIDRs (textarea, one per line) + role; trusted proxies; server warnings shown inline.
  - Activity: audit log table (time, who, what, IP).
- [ ] CSS for all of the above in `app.css`, using existing tokens; verify light/dark and phone width.
- [ ] Manual check via the app (`run` skill): enable sign-in from scratch, create an operator, log in as them in a private window, confirm Settings shows only Display/Security-less view, Playback works, Connection 403 not reachable from UI.
- [ ] Commit `web: account settings, 2FA enrolment and the Security tab`.

### Task 8: docs, compose, Docker test

- [ ] `README.md`: replace "there's no login system…" (Why section) with a pointer to a new **Authentication** section: turning it on (UI or `SENTINEL_ADMIN_USER`/`SENTINEL_ADMIN_PASSWORD`), roles table, pairing a TV, 2FA and recovery codes, LAN bypass and the same-host tunnel caveat, trusted proxies, lock-out CLI (`docker compose exec sentinel-eye python app/auth.py reset-password admin`), and "still terminate TLS in front when exposed to the internet". Update the Docker section's "must authenticate" wording accordingly.
- [ ] `compose.yaml`: replace the "There is no login" comment; add commented `SENTINEL_ADMIN_USER: admin` / `SENTINEL_ADMIN_PASSWORD: ${SENTINEL_ADMIN_PASSWORD:-}` lines.
- [ ] `tools/test_docker_compose.sh`: new case — start with `SENTINEL_ADMIN_PASSWORD` set, assert healthcheck becomes `healthy`, `curl /api/settings` → 401, `curl /api/status` body has only `go2rtc`.
- [ ] Run all: `tools/test_auth_core.py`, `tools/test_auth_http.py`, `tools/test_hwaccel.py`, and (on a Docker host) `tools/test_docker_compose.sh`.
- [ ] Commit `docs: optional authentication`.
