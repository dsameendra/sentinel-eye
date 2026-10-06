# AGENTS.md

Guidance for AI coding agents (Codex/ChatGPT, Claude Code, GitHub Copilot, Antigravity, Cursor, …) working
in this repository. Humans should start with [README.md](README.md); this file covers only what an agent
needs that isn't obvious from the code. When this file and the code disagree, the code wins. Please fix this
file in the same change.

## Project overview

Sentinel Eye is a self-hosted web dashboard for Hikvision DVR/NVRs and cameras: live view, multi-camera
frame-locked playback, event search, signed evidence exports, and local AI frame enhancement. It runs entirely
on the user's own machine and LAN, with no cloud, vendor app or plugin.

- **Backend:** Python 3 + FastAPI (`app/server.py`), served by uvicorn on port **8007**.
- **Streaming:** go2rtc (WebRTC/MSE to the browser), configured by `app/go2rtc.py`. `app/hikrelay.py` decrypts
  Hikvision "Stream Encryption" (reverse-engineered, see `tools/NOTES.md`) and pipes the result through ffmpeg.
- **Frontend:** plain ES modules in `web/`, with **no build step, no framework and no npm dependencies**.
- **Optional sign-in:** viewer/operator/admin roles, TOTP, TV pairing (`app/auth.py`, `app/auth_api.py`).

Deeper, authoritative docs (read them when your task touches their area):

| Doc | Covers |
|---|---|
| `docs/SPEC.md` | Full spec and build status: playback, timebase, events, export, AI enhancer (§7.8) |
| `docs/DESIGN.md` | Design system: colour/type/spacing tokens and component rules. Follow it for any UI work |
| `docs/PRODUCT.md` | Users, positioning, product principles |
| `tools/NOTES.md` | Encryption scheme and the hard-won RTP/ffmpeg/go2rtc timing pitfalls |
| `SECURITY.md` | Threat model and what is in scope |

## Repository map

- `app/`: backend modules. Key ones: `server.py` (routes, WebSocket proxy), `auth.py`/`auth_api.py`
  (accounts, route roles), `playback_session.py`/`timebase.py` (playback, RTP↔UTC calibration),
  `export.py` (stream-copy export, Ed25519 signing), `enhance_ai.py`/`enhance_models.py` (AI enhancer),
  `hwaccel.py` (H.264 encoder selection), `settings.py` (settings model and persistence).
- `web/`: `index.html`, `login.html`, `pair.html`, `sw.js` (service worker), `css/app.css`, `js/*.js`
  (one module per view or component; `main.js` is the hash router), `vendor/` (third-party code, vendored as-is).
- `tools/`: tests (`test_*.py`, `test_*.mjs`), browser e2e scripts (`e2e_*.py`, which drive Chrome via `cdp.py`),
  benches (`bench_*.py`), installers and notes.
- `docs/`: specs, design docs, plans (`docs/superpowers/`), and screenshots (synthetic footage only).
- **Never edit or commit:** `data/` (live settings, credentials, `auth.db`, signing key, models), `.env`,
  `bin/` (downloaded go2rtc), `.venv/`, `gfpgan/` (downloaded weights), `backups/`, `compose.gpu.yaml`
  (generated).
- Finder/iCloud duplicates (`* 2.*`) are git-ignored; never commit or recreate them.

## Running it

```sh
./run.sh --native setup      # create .venv, install requirements.txt, fetch bin/go2rtc
./run.sh --native run        # foreground server on http://127.0.0.1:8007 (Ctrl-C to stop)
./run.sh --native restart    # background; logs go to data/sentinel.log (go2rtc: data/go2rtc.log)
./run.sh status | logs | stop
```

- Docker is the default mode (`./run.sh` without `--native`). The code is baked into the image, so changes
  need `./run.sh update`. For development, prefer `--native`.
- **Frontend changes only need a browser refresh. Backend changes need `./run.sh --native restart`.**
- The backend runs as `uvicorn --app-dir app server:app`, so modules import each other **flatly**
  (`import auth`, `import settings as cfg`), never as `app.auth`. Scripts in `tools/` do
  `sys.path.insert(0, "app")` first.
- Use `.venv/bin/python3` for anything that imports the backend.

## Checks before you finish

CI (`.github/workflows/ci.yml`) runs these. They must pass:

```sh
find app tools -name '*.py' -exec python3 -m py_compile {} +
find web -name '*.js' -print0 | xargs -0 -n1 node --check
.venv/bin/python3 tools/test_ws_routes.py
```

Also run the suites for the area you touched. None of them needs a recorder:

| Area | Command |
|---|---|
| Auth, roles, routes | `.venv/bin/pip install -r requirements-dev.txt` once, then `.venv/bin/python3 tools/test_auth_core.py` and `tools/test_auth_http.py` |
| Viewer, gestures, zoom UI | `node tools/test_viewer.mjs` |
| Service worker / PWA shell | `node tools/test_shell_update.mjs`, `node tools/test_pwa_bootstrap.mjs` |
| Playback background loops | `.venv/bin/python3 tools/test_playback_service.py` |
| Encoder selection | `.venv/bin/python3 tools/test_hwaccel.py` |
| AI enhancer | `.venv/bin/python3 tools/test_enhance_models.py`, `tools/test_enhance_ai.py` |
| Docker | `tools/test_docker_image.sh`, `tools/test_docker_compose.sh` |

For UI work, use an isolated instance rather than the real recorder:

- `tools/test_rig.sh start` runs a fake camera plus a scratch app on `:8081`.
- `.venv/bin/python tools/pwa_preview.py` runs a synthetic UI with no writes.

**Real-recorder scripts:** `tools/test_m0.py`, `tools/e2e_live.py`, `tools/e2e_real_settings.py`,
`tools/e2e_stress.py` and `tools/e2e_server_load.py` talk to the user's real DVR. Do not run them unless the
user asks.

## Conventions

- **Python:** start each module with a docstring saying what it is for. Comments explain *why*, often citing
  the real-device behaviour that forced a decision, so keep them when editing nearby code.
  `requirements.txt` is fully pinned. The AI-enhancer dependencies (commented out there) are installed only
  through `tools/install_enhance_deps.sh` (basicsr needs local patches), and are not in the Docker image.
- **Tests** are standalone scripts using a small `check(name, ok)` PASS/FAIL helper, not pytest. Match the
  style of the neighbouring test file. Tests use scratch data dirs and must never touch `data/`.
- **Frontend:** browser-native ES modules imported with relative `./x.js` paths. Don't add a bundler,
  framework, TypeScript or npm packages. If third-party code is unavoidable, vendor a single file into
  `web/vendor/`. Shared helpers (`esc`, `icon`, `toast`, modals) live in `web/js/ui.js`, and the API client
  is in `web/js/api.js`.
- **PWA shell revision:** when shipping changes to cached shell assets that installed apps must pick up,
  bump the revision in **all three places together**:
  - `CACHE_NAME` in `web/sw.js`
  - `--shell-revision` in `web/css/app.css`
  - the expected strings in `tools/test_shell_update.mjs`
- **UI** uses the tokens and rules in `docs/DESIGN.md` (dark graphite, one accent colour for interactive
  elements, Inter). `.impeccable/config.json` records reviewed design-lint exceptions. It is shared state,
  so update it intentionally. `.impeccable/hook.cache.json` is local.
- **Time:** the app works in DVR/NVR local time, taken from the recorder rather than the host. See
  `app/timebase.py` and `web/js/dvrtime.js` before touching timestamps.

## Security rules (non-negotiable)

- **HTTP routes:** every new `/api/` route needs a deliberate entry in `ROUTE_ROLES` (`app/auth_api.py`).
  Unmatched routes fail closed to admin.
  - Anything a signed-out page needs must be added to `PUBLIC`, and only if it is truly public.
- **WebSocket routes** bypass the HTTP middleware. Each handler must call `_ws_admit(ws, role)`
  (`app/server.py`), and the new path must be added to the allowlist in `tools/test_ws_routes.py`.
- **Viewers never see recorder credentials.** `GET /api/settings` redacts the connection for non-admins,
  and any new settings or status payload must do the same.
- **No network calls off the LAN:** no telemetry, CDNs, cloud APIs or remote fonts. Model downloads are the
  only exception, and they are pinned and checksum-verified (`app/enhance_models.py`).
- **AI provenance:** enhanced output always carries the ENHANCED label, and the original frame is always
  kept alongside it.
- **Exports** stay as stream copy (no re-encoding), with a signed manifest.
- **Secrets:** never print, log or commit the DVR password, verification code, `.env` contents, session
  tokens or `*.pem` keys.

## Always / Ask first / Never

- **Always:** run the CI checks above, keep changes scoped, and update `README.md` and/or `docs/SPEC.md`
  when behaviour or setup changes (as the PR template asks).
- **Ask first:**
  - adding any dependency (Python or JS)
  - any command that contacts the real recorder (repeated failed logins **lock the DVR account**)
  - `./run.sh clean`, `./run.sh update`, or Docker image rebuilds
  - changing the export/manifest format (it breaks verification of earlier exports)
  - deleting files
- **Never:**
  - commit `.env`, `data/`, `*.db`, `*.pem`, or video/footage (`*.mp4`, `*.mkv`, snapshots)
  - use real surveillance footage in screenshots, fixtures or tests (synthetic only)
  - weaken an auth check to make a test pass

## Gotchas

- Read `tools/NOTES.md` before touching `hikrelay.py`, ffmpeg arguments or go2rtc config. Examples:
  - ffmpeg ignores `-framerate` for raw H.265 from a pipe.
  - `-fflags nobuffer` breaks the H.265 parser.
  - Python pipes to ffmpeg must be unbuffered.
  - go2rtc only accepts `exec:` sources from its config file.
- **Hardware decoding:** decoding stays in software on purpose (VideoToolbox H.265 decode stalls on this
  DVR). Only encoding is hardware-accelerated.
- **WebCodecs** (Playback, previews, instant replay) only works on HTTPS or `localhost`. On plain LAN HTTP,
  live view works but playback doesn't. That is expected, not a bug.
- **Optional enhancer:** the AI enhancer is native-only. Code paths must degrade with a clear message when
  its dependencies are missing (see `tools/test_enhance_ai.py`).
- **Ports:** native and Docker instances share ports. Only one can run at a time.
- **Shell revision:** currently `adaptive-v33` (kept in sync across `web/sw.js`, `web/css/app.css`,
  `tools/test_shell_update.mjs`, and `README.md`).

## Commits and pull requests

- Commit subjects are short, imperative, plain-English summaries of the user-visible change (see
  `git log`), e.g. "Polish responsive UI and fullscreen behavior across devices".
- PRs follow `.github/PULL_REQUEST_TEMPLATE.md`: what changed, how it was tested (recorder model and
  browsers, if relevant), and the docs-updated checklist.

## Code Review Rules

When reviewing a change, flag:

- a new `/api/` route without a deliberate `ROUTE_ROLES` entry
- a new WebSocket route without `_ws_admit` and a `tools/test_ws_routes.py` update
- recorder credentials reachable by non-admins
- any frontend build tooling, framework or npm dependency, or any off-LAN network call
- cached shell changes without a matching shell-revision bump in all three places
- AI output missing the ENHANCED label or the original frame
- an export path that re-encodes or skips signing
- secrets, `data/` or footage in the diff
- behaviour changes without a matching `README.md` / `docs/SPEC.md` update
