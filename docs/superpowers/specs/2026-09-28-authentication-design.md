# Optional authentication — design

Date: 2026-09-28 · Status: implemented (see "Implementation notes" at the end)

## Goal

Let an operator turn on a login for Sentinel Eye, so it can be reached from networks they don't fully
trust (a tunnel, a VPN shared with others, a household LAN) without putting an authenticating proxy in
front of it. With no users configured the app behaves exactly as today: no login, full access.

## Constraints and decisions

| Topic | Decision |
|---|---|
| Opt-in | Auth is **on iff at least one user exists**. Zero users = today's behaviour, unchanged. |
| Mechanism | Own login page + opaque session cookie. No HTTP Basic, no JWT. |
| Users | Multiple users, three fixed roles: `viewer`, `operator`, `admin`. No per-camera permissions. |
| Passwords | `hashlib.scrypt` (stdlib), per-user salt. Minimum 10 characters. No new Python dependency. |
| 2FA | TOTP (RFC 6238), optional per user, implemented on stdlib `hmac`. Admin setting can require it for admins. 10 single-use recovery codes. |
| TV / devices | Device pairing with a short code (Netflix/YouTube-TV style) approved by a logged-in admin. No secrets in URLs. |
| Sessions | Long-lived "remember me", per-session listing and revocation, revoke-all. Revocation also closes that session's open WebSockets. |
| Network bypass | Optional, **off by default**, explicit CIDR list only, grants a configured role (default `viewer`), never applies to proxied requests. |
| Bootstrap | `SENTINEL_ADMIN_USER` / `SENTINEL_ADMIN_PASSWORD` env vars create the first admin when no users exist; also creatable from Settings → Security. |
| Storage | New `data/auth.db` (SQLite, chmod 600), separate from `playback.db` and from `settings.json` (which `/api/settings` exposes). |
| Delivery | One spec, one plan, all features together. |

## Roles

Authorization is enforced server-side per route; the frontend only hides what the role can't use.

| Capability | Routes | viewer | operator | admin |
|---|---|---|---|---|
| Live view, snapshot, zoom, instant replay | `/ws`, `GET /api/settings` (redacted) | ✅ | ✅ | ✅ |
| Playback, timeline, event search, thumbnails | `/api/playback/*`, `/api/timeline/*` | ❌ | ✅ | ✅ |
| Bookmarks | `/api/bookmarks*` | ❌ | ✅ | ✅ |
| Export, enhance, OCR | `/api/export*`, `/api/enhance*` | ❌ | ✅ | ✅ |
| Shared layout / order / quality | `PUT /api/display` | ❌ | ✅ | ✅ |
| Connection, cameras, test, discover | `PUT /api/settings`, `/api/test`, `/api/discover` | ❌ | ❌ | ✅ |
| Users, devices, sessions, auth config | `/api/auth/admin/*` | ❌ | ❌ | ✅ |

- `GET /api/settings` for non-admins omits `connection` entirely (host, username, has_password, key flags),
  keeping only what the live grid needs (channels, display).
- Per-browser preferences (TV mode etc.) stay in `localStorage` and are available to every role.
- Role is re-read from `auth.db` on every request (small in-process cache invalidated on writes), so a
  demotion takes effect immediately.
- With auth off, every request is treated as `admin` — one code path, no special-casing in routes.

## Components

### `app/auth.py` (new)

- **Schema** (`auth.db`, WAL, same locking style as `db.py`):
  - `users(id, username UNIQUE COLLATE NOCASE, kind 'person'|'device', pw_hash, role, totp_secret NULL,
    totp_last_step NULL, disabled, created_utc, updated_utc)` — a paired device is its own `kind='device'`
    user (unusable password), so its role and revocation don't depend on any person, and it never
    counts as "the last admin".
  - `recovery_codes(user_id, code_hash, used_utc NULL)`
  - `sessions(token_hash PK, user_id, kind 'browser'|'device', label, created_utc, last_seen_utc,
    expires_utc, ip, user_agent)` — the cookie holds a 256-bit random token; only its SHA-256 is stored.
  - `pairings(device_code_hash PK, user_code, created_utc, expires_utc, approved_user_id NULL,
    approved_role NULL, label NULL)`
  - `config(key PK, value_json)` — `require_2fa_admin`, `bypass_cidrs`, `bypass_role`,
    `trusted_proxies`, session lifetimes.
  - `audit(id, ts_utc, actor, action, target, ip, detail_json)` — logins (ok/fail), 2FA changes,
    pairings, user/role changes, revocations. Kept 90 days.
- **Passwords**: `scrypt(n=2**15, r=8, p=1)`, stored as `scrypt$n$r$p$salt$hash`; verify with
  `hmac.compare_digest`. A dummy verify runs for unknown usernames so timing doesn't reveal them.
- **TOTP**: SHA-1, 6 digits, 30 s step, ±1 step window, rejects a step ≤ `totp_last_step` (no replay).
  Enrolment is confirmed with a valid code before it's saved.
- **Sessions**: browser sessions last 12 h sliding, or 30 days sliding with "remember me"; device sessions
  365 days sliding. `last_seen_utc` is written at most once a minute per session. Changing your password
  revokes your other sessions.
- **Rate limiting** (in memory): per client IP and per username, exponential backoff after 5 failures
  (capped at 15 min). Pairing code submission is limited the same way.
- **CLI** for lock-outs: `python app/auth.py reset-password <user>`, `disable-2fa <user>`,
  `list-users`, `disable-auth` (deletes all users after confirmation). Works in Docker via
  `docker compose exec sentinel-eye python app/auth.py …`.

### Client IP and proxies

- The peer address is the client IP, unless the peer is in `trusted_proxies` (CIDRs, empty by default), in
  which case the right-most untrusted address of `X-Forwarded-For` (or `CF-Connecting-IP`) is used.
- **Bypass** applies only when the peer address is in `bypass_cidrs` **and** the request carries none of
  `Forwarded`, `X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`. Rationale: a tunnel or reverse proxy on
  the same host makes internet traffic arrive from `127.0.0.1`; `127.0.0.0/8` is therefore not bypassed
  unless listed explicitly, and the UI warns when it is.
- The bypass never grants `admin`.

### Middleware and routes (`app/server.py`)

- One ASGI middleware resolves the principal (session cookie → bypass → anonymous) into
  `request.state.user`, and a `require(role)` dependency guards each route per the table above.
- **Public without a session**: `/login`, `/pair`, `/api/auth/login`, `/api/auth/pair/start`,
  `/api/auth/pair/poll`, `/manifest.json`, `/sw.js`, `/icons/*`, the CSS/JS the login page loads, and
  `/api/status`. Unauthenticated `/api/status` returns only `{"go2rtc": bool}` (enough for the Docker
  healthcheck); the full body needs a session.
- Unauthenticated HTML requests → `302 /login?next=…` (same-origin `next` only); API → `401` JSON.
- **WebSockets** (`/ws`, `/api/playback/ws`): validate cookie and role before `accept()`, else close with
  4401/4403. The existing Origin check stays. Each open socket is registered against its session token;
  revoking a session closes them.
- **Cookie**: `se_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when the request is HTTPS
  (directly, or `X-Forwarded-Proto: https` from a trusted proxy).
- **CSRF**: `SameSite=Strict` plus an Origin/Referer same-host check on every non-GET request.
- New endpoints under `/api/auth/`: `login`, `login/totp`, `logout`, `me`, `password`, `totp/*`
  (enrol, confirm, disable, recovery codes), `sessions` (list/revoke own), `pair/start`, `pair/poll`,
  `pair/approve`, and `admin/*` (users CRUD, sessions of all users, devices, config, audit).

### Login flow

1. `POST /api/auth/login {username, password, remember}` → `200` with a session, or
   `{"totp_required": true, "challenge": …}` (short-lived, single-use, 5 min).
2. `POST /api/auth/login/totp {challenge, code}` accepts a TOTP code or a recovery code.
3. If `require_2fa_admin` is on and an admin has no TOTP, the session is limited to the enrolment
   endpoints until they enrol.

### Device pairing (TV)

1. The TV opens `/login` and picks **Pair this device**. `POST /api/auth/pair/start` returns a
   `device_code` (secret, kept in page memory) and a `user_code` (8 chars, no ambiguous letters, e.g.
   `K7QM-4TXD`), valid 10 minutes.
2. The TV shows the code and a QR of `https://<host>/pair?code=K7QM-4TXD`, then polls
   `/api/auth/pair/poll` every 3 s.
3. An admin, logged in on a phone, scans or types the code at `/pair`, names the device ("Living room
   TV") and picks its role (default `viewer`, max `operator`). No second factor is asked of the TV.
4. The next poll sets a device-session cookie and the TV reloads into the app. Devices appear under
   Settings → Security → Devices and can be revoked or renamed.

### Frontend (`web/`)

- `web/login.html` + `web/js/login.js`: username/password, remember me, TOTP step, pair-this-device view.
  Same design tokens as the app; large-target layout when the browser's TV-mode flag is set.
- `web/pair.html` (or a route in the SPA): approve a pairing code.
- `web/js/api.js`: on `401` redirect to `/login?next=…`; on `403` show a toast.
- `GET /api/auth/me` at startup → `{user, role, auth_enabled, via: session|bypass|none}`; the UI hides
  playback/export/settings sections the role can't use and shows a user menu (change password, 2FA,
  my sessions, log out) when auth is on.
- **Settings → Security** (admin): enable auth (create first admin), users (add, role, disable, reset
  password, reset 2FA), devices, all sessions, bypass CIDRs + role, trusted proxies, require 2FA for
  admins, audit log.
- QR rendering for TOTP enrolment and pairing: vendor a small MIT QR generator into `web/vendor/`.
- `web/sw.js`: never cache `/login`, `/pair` or `/api/auth/*`; bump `CACHE_NAME`.

### Docs and deployment

- README: replace "there's no login system" with an Authentication section (enable, roles, TV pairing,
  2FA, bypass caveat, lock-out CLI). Keep the recommendation to terminate TLS in front when exposed.
- `compose.yaml`: replace the "There is no login" comment; add commented `SENTINEL_ADMIN_USER` /
  `SENTINEL_ADMIN_PASSWORD`.

## Testing

- `tools/test_auth.py` (same style as the other `tools/test_*.py`), against a server on a scratch
  `SENTINEL_DATA`:
  - auth off: every route reachable, `/api/auth/me` says disabled;
  - bootstrap from env; login/logout; wrong password backoff; unknown user timing path;
  - role matrix: every route in the table × each role → expected 200/401/403, HTTP and WebSocket;
  - TOTP enrol/confirm/login, replay rejected, recovery code single-use, `require_2fa_admin`;
  - session expiry, revoke one / revoke all, revoke closes an open `/ws`;
  - pairing: start → approve → poll sets cookie; expired and wrong codes; rate limit;
  - bypass: allowed CIDR without proxy headers → bypass role; with `X-Forwarded-For` → login required;
    `127.0.0.1` not bypassed unless listed;
  - unauthenticated `/api/status` returns only `go2rtc`.
- `tools/test_docker_compose.sh`: healthcheck still passes with auth enabled.

## Out of scope

- Per-camera permissions, external identity providers (OIDC/SAML), WebAuthn/passkeys, email-based
  password reset. OIDC-style SSO remains available by putting an authenticating proxy in front.

## Implementation notes

Where the build differs from the text above:

- The HTTP side lives in `app/auth_api.py` (principal, route→role table, cookie, `/api/auth/*`); `server.py`
  only wires it in. Sign-in pages are `/login` and `/pair`.
- CSRF: a non-GET request is refused only when its `Origin`/`Referer` names another host. A request with
  neither is a non-browser client (the `tools/` scripts), since browsers always send `Origin` cross-site.
- Instant replay for viewers: `/api/playback/ws` admits a viewer when `start` is within the last 2 minutes,
  and ignores that viewer's seeks further back. Everything else on that socket still needs operator.
- A viewer's `GET /api/settings` returns `connection: {channel_zero, configured}`.
- `SENTINEL_ADMIN_USER` / `SENTINEL_ADMIN_PASSWORD` are always passed through `compose.yaml` (empty = no-op).
