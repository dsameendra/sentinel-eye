# Security policy

Sentinel Eye watches and records what happens around someone's home or business, so a security problem in
it can expose live cameras, recorded footage, or the recorder's own credentials. Reports are taken
seriously and handled privately.

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub instead:
[**Security → Report a vulnerability**](https://github.com/dsameendra/sentinel-eye/security/advisories/new).
Only the maintainer can see it.

Helpful to include:

- what an attacker can do, and from where (the internet through a tunnel, the same network, a signed-in
  viewer, …);
- the steps or a small proof of concept;
- the commit or date of the version you tested, and how it was run (Docker or native, sign-in on or off,
  behind a proxy or not);
- whether it needs anything special — a particular recorder, browser or setting.

Please don't test against systems you don't own, and don't access or keep other people's footage or data
beyond what's needed to show the problem.

### What to expect

This is a project maintained in spare time, so these are aims rather than guarantees:

| | |
|---|---|
| Acknowledgement | within a few days |
| First assessment | within about a week |
| Fix | as soon as practical — critical issues (remote access without sign-in, credential exposure) first |

You'll be kept informed along the way. Once a fix is released, the advisory is published and you're
credited, unless you'd rather not be.

## Supported versions

There are no numbered releases yet: fixes go to the latest `main`, and only that is supported. Updating
is `./run.sh update`.

## Scope

In scope — anything that breaks what the app promises, for example:

- reaching cameras, recordings, settings or the API without signing in (when sign-in is on), or doing
  more than your role allows (Viewer, Operator, Admin);
- session, cookie, two-factor, TV-pairing or trusted-network weaknesses, and bypassing the sign-in rate
  limit;
- cross-site scripting, cross-site request forgery, clickjacking, path traversal or injection;
- the recorder's password, Stream Encryption key, accounts or export signing key leaking — through the API,
  logs, exports or files left readable by other users;
- an exported evidence package that `verify.html` reports as verified after its clips or manifest were
  changed;
- the decrypting relay or the playback proxy being usable to reach anything other than the configured
  recorder.

Out of scope:

- **Running with sign-in off where untrusted people can reach it.** With no accounts, anyone who can
  reach the address has full access — by design, and the README says so. Turn sign-in on first.
- Weaknesses in the Hikvision recorder or cameras themselves, their firmware, or Hikvision's own
  services.
- Denial of service by flooding the server or the recorder (the recorder's own connection and playback
  limits are the real ceiling).
- Vulnerabilities in dependencies (go2rtc, FastAPI, PyTorch, …) with no demonstrated effect on Sentinel Eye —
  report those upstream.
- Anything that needs an already-compromised machine, an admin account, or physical access to the server or
  recorder.

## How it's protected

So you know what to expect, and what to check:

- **Sign-in is optional, and off until the first account exists.** Once on, every HTTP request and WebSocket
  is checked on the server against the route's minimum role; the interface only hides what you can't use.
  A viewer's copy of the settings has no recorder address or login.
- **Passwords** are stored as scrypt hashes; session tokens only as hashes. Unknown usernames take the same
  time to reject as wrong passwords.
- **Sign-in attempts are rate-limited** per account and per address (5 free, then growing delays up to 15
  minutes); re-entering your password to change it, rename yourself, or change two-factor counts toward the
  same limit.
- **Sessions** use an `HttpOnly`, `SameSite=Strict` cookie, `Secure` behind HTTPS; 12 hours, or 30 days with
  "keep me signed in" (both adjustable). Changing your password signs your other devices out; revoking a
  session closes its live streams within a second.
- **Two-factor** (TOTP with single-use recovery codes) for anyone, and it can be required for admins.
- **Cross-site requests** that change anything are refused unless they come from the app's own origin;
  WebSockets check their origin too. Every response forbids being framed by another site, and turns off
  MIME sniffing.
- **TVs and shared screens** pair with a short code approved by an admin — no password is ever typed on
  them.
- **Trusted networks** (optional) can skip sign-in, but never as Admin, and never for requests that came
  through a proxy or tunnel.
- **Secrets at rest**: `data/settings.json` (recorder password, encryption key), `data/auth.db` (accounts,
  sessions, activity log) and the export signing key are created owner-only (mode 600); `data/` and
  `backups/` are git-ignored. `./run.sh backup` archives contain the recorder password — keep them private.
- **Nothing leaves your network.** No telemetry, no cloud account; the AI enhancer runs locally (its model
  weights are downloaded once, on first use).
- **Exports** are signed with an Ed25519 key that stays on the server; `verify.html` checks every file's
  hash and the signature offline.

### Known limitations

- `verify.html` checks the signature against the public key carried in the package. That proves nothing
  was changed after signing, but not *which* installation signed it: someone who alters a package can sign
  it again with their own key. To be sure it came from your installation, compare the public key shown under
  *Details* with your own (`data/export_signing_key.pem`).
- The app itself serves plain HTTP. Browsers need HTTPS (or `localhost`) for Playback, and anything beyond
  your own network should only be reached through a reverse proxy or tunnel that terminates HTTPS — see
  the README's *Reaching it from the internet*.
- There's no full Content-Security-Policy yet (framing is blocked; scripts and styles aren't restricted).

## Hardening checklist

- Turn on sign-in before anyone else can reach the address, and require two-factor for admins.
- Never publish port 8007 directly. Put it behind a reverse proxy or tunnel with HTTPS (and, if you like,
  its own authentication in front), and list the proxy under *Reverse proxies* so client addresses and the
  `Secure` cookie flag are right.
- Give people the lowest role that works: Viewer for watching, Operator for review and exports.
- Turn on the recorder's own Stream Encryption, and give Sentinel Eye a recorder account that can only
  view and play back.
- Keep `data/` and any backups private, and update regularly with `./run.sh update`.
