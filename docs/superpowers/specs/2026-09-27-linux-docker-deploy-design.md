# Linux VM deployment with Docker Compose — design

Date: 2026-09-27 · Status: approved in conversation, pending written-spec review

## Goal

Run Sentinel Eye on an Ubuntu amd64 VM with Docker Compose, reachable from the LAN/VPN directly and from
the internet through a reverse proxy or tunnel the operator already runs (outside this repo).

## Constraints and decisions

| Topic | Decision |
|---|---|
| Runtime | Docker Compose, one service. No `version:` key in the compose file. |
| Architectures | Image is multi-arch (`linux/amd64`, `linux/arm64`) via `buildx` and `TARGETARCH`. Target VM is amd64. |
| AI enhancer | Not included. Its dependencies stay commented out in `requirements.txt`; the server already imports Pillow/torch lazily (commit `dd7f486`). |
| Networking | `network_mode: host`, so go2rtc's WebRTC (`:8555` TCP/UDP) works on the LAN/VPN without ICE candidate configuration. |
| Internet access | Out of scope for this repo: the operator's own proxy/tunnel terminates TLS and **must authenticate**, because the app has no login. Through an HTTP tunnel the player falls back to MSE over the WebSocket on port 8007 automatically. |
| DVR reachability | Assumed: the VM reaches the DVR's IP directly (same LAN or routed). |
| App code | No changes to `app/` or `web/`. `run.sh`/`stop.sh` stay as the macOS path, unchanged. |

## Components

### `Dockerfile`

- **Stage `go2rtc`**: downloads go2rtc **v1.9.14** (same version `run.sh` pins) for `TARGETARCH`
  (`go2rtc_linux_amd64` / `go2rtc_linux_arm64` release assets — raw binaries, not zips) and marks it
  executable. An unsupported `TARGETARCH` fails the build with a clear message.
- **Runtime stage** on `python:3.14-slim`:
  - `apt-get install ffmpeg` (provides `ffmpeg`, `ffprobe`, and `libx264`, which `hikrelay.py` uses for
    H.265→H.264 transcoding off macOS).
  - `pip install --no-cache-dir -r requirements.txt`.
  - Copies `app/`, `web/`, and the go2rtc binary to `/app/bin/go2rtc` (the path `app/go2rtc.py` expects:
    `ROOT / "bin" / "go2rtc"`, with `ROOT=/app`).
  - Creates user/group `sentinel` with UID/GID 1000 and runs as that user.
  - `ENV SENTINEL_DATA=/data`, `PYTHONUNBUFFERED=1`; `/data` created and owned by 1000.
  - `CMD` runs `uvicorn --app-dir app server:app --host ${SENTINEL_HOST:-0.0.0.0} --port ${SENTINEL_PORT:-8007}`
    through `sh -c` with `exec`, so uvicorn receives signals directly.

### `.dockerignore`

Excludes `.venv/`, `data/`, `.env`, `bin/`, `.git/`, `.impeccable/`, `docs/`, `tools/`, and `__pycache__/`.
Keeps credentials, local databases, and macOS binaries out of the build context and image.

### `compose.yaml`

- Service `sentinel-eye`: `build: .`, `image: sentinel-eye:local`, `restart: unless-stopped`,
  `network_mode: host`, `init: true` (tini reaps go2rtc, `hikrelay.py`, and ffmpeg children).
- Volume: `./data:/data` (bind mount; holds `settings.json`, `playback.db`, exports, thumbnails,
  `go2rtc.yaml`, `go2rtc.log`, and `export_signing_key.pem`).
- Environment (all optional): `SENTINEL_HOST`, `SENTINEL_PORT`, `TZ`.
- Commented-out optional mount `./.env:/app/.env:ro` for first-run seeding.
- Healthcheck: `python -c` + `urllib.request` against `http://127.0.0.1:${SENTINEL_PORT:-8007}/api/status`
  (no curl in the image). `/api/status` answers without a configured DVR.

## First-run configuration

- **Primary path**: start the stack and enter the DVR in the Settings page. The server starts without a
  reachable DVR (commit `a216abf`).
- **Alternative**: uncomment the `.env` mount. `app/settings.py` `_migrate_env()` reads `/app/.env` only
  when `data/settings.json` does not exist yet; afterwards the mount can be removed.
- Credentials end up in `data/settings.json` (mode 600), as today.

## Operations

- Before first start: `mkdir -p data && sudo chown 1000:1000 data`. Otherwise Docker creates `./data` as
  root and the app cannot write.
- Migrating from an existing install: copy the old `data/` directory to the VM and apply the same
  `chown`. Keeping `export_signing_key.pem` keeps earlier exports verifiable.
- Logs: `docker compose logs -f` for the server; `data/go2rtc.log` for go2rtc.
- Update: `git pull && docker compose up -d --build`.
- Stop: `docker compose down`. The server's lifespan stops go2rtc; tini reaps the rest. `stop.sh` is not
  used on Linux.

## Documentation

New README section "Run on a Linux VM with Docker": prerequisites (Docker Engine + Compose plugin), the
`chown`, first start, migrating `data/`, updating, environment variables, and a prominent warning:

- there is no login; anything that can reach port 8007 controls the app, including DVR credentials;
- an internet-facing proxy/tunnel must authenticate users and pass WebSocket upgrades for `/ws` and
  `/api/playback/ws`;
- WebRTC works on the LAN/VPN; through an HTTP tunnel playback uses MSE.

## Testing

1. `docker buildx build --platform linux/amd64,linux/arm64 .` succeeds.
2. In the amd64 image: `bin/go2rtc -version` prints v1.9.14; `ffmpeg -encoders` lists `libx264`;
   `id -u` is 1000.
3. `docker compose up` with an empty `data/` and no DVR: healthcheck becomes `healthy`, `GET /` serves the
   UI, and `GET /api/settings` returns JSON.
4. If the DVR is reachable from the build machine: start with a copy of the current `data/` and confirm a
   live tile plays via the WebSocket/MSE path. If it is not reachable, report that and leave this check
   for the VM.

## Out of scope

AI enhancer in the container, application-level authentication, proxy/tunnel configuration, publishing
images to a registry, and changes to `run.sh`/`stop.sh`.
