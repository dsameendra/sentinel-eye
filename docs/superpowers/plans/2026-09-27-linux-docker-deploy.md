# Linux VM Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Sentinel Eye as a multi-arch Docker image plus a Compose file so it runs on an Ubuntu amd64 VM.

**Architecture:** One image contains Python 3.14, ffmpeg (with libx264), the app (`app/`, `web/`), and a go2rtc binary picked by `TARGETARCH`. One Compose service runs it with host networking, tini as init, a bind-mounted `/data`, and a healthcheck that requires go2rtc to be up. No application code changes; tests are shell scripts in `tools/` (the repo's existing test pattern) that drive `docker`/`docker compose`.

**Tech Stack:** Docker BuildKit/buildx, Docker Compose v2, `python:3.14-slim` (Debian), `alpine` (download stage only), go2rtc v1.9.14, bash.

**Spec:** `docs/superpowers/specs/2026-09-27-linux-docker-deploy-design.md`

## Global Constraints

- Compose file has **no `version:` key**.
- Image must build for `linux/amd64` and `linux/arm64` (multi-arch, via `TARGETARCH`).
- go2rtc version: **v1.9.14**; release assets `go2rtc_linux_amd64` / `go2rtc_linux_arm64` (raw binaries, verified reachable 2026-09-27).
- Container user: `sentinel`, **UID/GID 1000**. `SENTINEL_DATA=/data`.
- No AI enhancer dependencies in the image.
- No changes to `app/`, `web/`, `run.sh`, `stop.sh`.
- `network_mode: host`, `init: true`, `restart: unless-stopped`.
- Listen address/port from `SENTINEL_HOST` (default `0.0.0.0`) and `SENTINEL_PORT` (default `8007`).
- The app has no login: docs must say an internet-facing proxy/tunnel must authenticate and pass WebSocket upgrades on `/ws` and `/api/playback/ws`.
- Tests use bash (`#!/usr/bin/env bash`), because they must run on the Ubuntu VM, not only the Mac.
- On macOS, `tools/test_docker_compose.sh` needs Docker Desktop's host networking enabled (Settings → Resources → Network → "Enable host networking"); on Linux it works as-is.

## Review Focus

1. **`./data` created by Docker as root (operator skipped the `chown`)** → container exits immediately with a message telling them to run `sudo chown 1000:1000 data`, instead of a Python traceback loop. Pinned in Task 1 (CMD guard) and Task 2 (test case "unwritable data dir", Linux only).
2. **`SENTINEL_HOST` set to a specific IP (e.g. a VPN address)** → healthcheck still passes (it must call that IP, not 127.0.0.1). Pinned in Task 2 (healthcheck logic + test case "SENTINEL_HOST=127.0.0.1").
3. **DVR configured but unreachable from the VM** → server still starts and reports healthy, so the operator can reach Settings. Pinned in Task 2 (test case "migrated data", DVR host `192.0.2.10`).
4. **Migrating an existing `data/` from the Mac** → settings from the old `settings.json` are loaded, not replaced by defaults. Pinned in Task 2 (test case "migrated data").
5. **`docker compose down` / VM reboot** → shutdown finishes promptly (SIGTERM reaches uvicorn, which stops go2rtc), not after the 10 s kill timeout. Pinned in Task 2 (shutdown timing assertion).

---

## File Structure

| File | Responsibility |
|---|---|
| `Dockerfile` (create) | Multi-arch image: go2rtc download stage + runtime stage. |
| `.dockerignore` (create) | Keep secrets, local data, venv, macOS binaries out of the build context. |
| `compose.yaml` (create) | The single service, volume, env, healthcheck. |
| `tools/test_docker_image.sh` (create) | Image-level checks (spec Testing 1–2). |
| `tools/test_docker_compose.sh` (create) | Stack-level checks (spec Testing 3 + Review Focus). |
| `README.md` (modify, insert after the `### Stop` section, before `## Installing as an app`) | "Run on a Linux VM with Docker" section. |

---

### Task 1: Docker image

**Files:**
- Create: `tools/test_docker_image.sh`
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `requirements.txt` (enhancer lines already commented), `app/`, `web/`.
- Produces: an image where `/app/bin/go2rtc` exists, working directory `/app`, user UID 1000, `SENTINEL_DATA=/data`, and default `CMD` that starts uvicorn on `${SENTINEL_HOST:-0.0.0.0}:${SENTINEL_PORT:-8007}` after checking `/data` is writable. Task 2 builds this image via `build: .`.

- [ ] **Step 1: Write the failing test**

Create `tools/test_docker_image.sh`:

```bash
#!/usr/bin/env bash
# Image checks for the Docker deployment (docs/superpowers/specs/2026-09-27-linux-docker-deploy-design.md,
# "Testing" 1–2): go2rtc version, ffmpeg with libx264, non-root user, nothing private in the image, and a
# multi-arch build.
#   tools/test_docker_image.sh
set -euo pipefail
cd "$(dirname "$0")/.."
IMG=sentinel-eye:test-amd64
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { docker run --rm --platform linux/amd64 --entrypoint "" "$IMG" "$@"; }

echo "== build linux/amd64 =="
docker buildx build --platform linux/amd64 --load -t "$IMG" .

echo "== go2rtc v1.9.14 =="
run bin/go2rtc -version | grep -q "1.9.14" || fail "bin/go2rtc is not v1.9.14"

echo "== ffmpeg with libx264, ffprobe =="
run ffmpeg -hide_banner -encoders | grep -q libx264 || fail "ffmpeg has no libx264 encoder"
run sh -c 'command -v ffprobe' >/dev/null || fail "ffprobe missing"

echo "== runs as UID 1000 =="
[ "$(run id -u)" = "1000" ] || fail "container user is not UID 1000"

echo "== nothing private or host-specific in the image =="
run sh -c 'for p in /app/.env /app/data /app/.venv /app/.git /app/bin/go2rtc_mac; do [ ! -e "$p" ] || { echo "$p"; exit 1; }; done' \
  || fail "build context leaked into the image (see path above)"

echo "== no AI enhancer deps =="
run python -c 'import importlib.util as u, sys; sys.exit(any(u.find_spec(m) for m in ("torch", "PIL", "cv2")))' \
  || fail "enhancer dependencies are installed"

echo "== server module imports =="
run sh -c 'cd /app/app && python -c "import server"' || fail "app/server.py does not import"

echo "== multi-arch build (linux/amd64 + linux/arm64) =="
docker buildx build --platform linux/amd64,linux/arm64 . >/dev/null || fail "multi-arch build failed"

echo "PASS"
```

Then `chmod +x tools/test_docker_image.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `tools/test_docker_image.sh`
Expected: FAIL at the first build, with buildx reporting it cannot find a `Dockerfile`.

- [ ] **Step 3: Write `.dockerignore`**

```
.git/
.venv/
.env
data/
bin/
.impeccable/
docs/
tools/
**/__pycache__/
*.pyc
```

- [ ] **Step 4: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Sentinel Eye for Linux hosts. Multi-arch: build with
#   docker buildx build --platform linux/amd64,linux/arm64 .
# The AI frame enhancer is not included (its dependencies stay commented out in requirements.txt).

# go2rtc is a single static binary per arch; fetch it on the build machine's own platform.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS go2rtc
ARG TARGETARCH
ARG GO2RTC_VERSION=v1.9.14
RUN apk add --no-cache curl \
 && case "$TARGETARCH" in amd64|arm64) ;; \
      *) echo "go2rtc: unsupported TARGETARCH '$TARGETARCH' (amd64, arm64)" >&2; exit 1 ;; esac \
 && curl -fsSL -o /go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_${TARGETARCH}" \
 && chmod 755 /go2rtc

FROM python:3.14-slim
# ffmpeg/ffprobe: hikrelay, thumbnails, exports, timebase; libx264 is the H.265->H.264 encoder off macOS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 sentinel \
 && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin sentinel \
 && mkdir /data && chown 1000:1000 /data

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ app/
COPY web/ web/
COPY --from=go2rtc /go2rtc bin/go2rtc

ENV SENTINEL_DATA=/data \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER sentinel
EXPOSE 8007
# Fail fast with a fix-it message if the bind-mounted data dir is owned by someone else (usually root,
# when Docker created ./data itself), instead of crash-looping on a PermissionError.
CMD ["sh", "-c", "[ -w /data ] || { echo \"sentinel-eye: /data is not writable by UID $(id -u). On the host run: sudo chown 1000:1000 data\" >&2; exit 1; }; exec uvicorn --app-dir app server:app --host \"${SENTINEL_HOST:-0.0.0.0}\" --port \"${SENTINEL_PORT:-8007}\""]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `tools/test_docker_image.sh`
Expected: ends with `PASS`.
If `pip install` fails compiling a wheel (no prebuilt `linux/amd64` or `linux/arm64` wheel for Python 3.14 for some pin), report the exact package and stop. Do not add compilers or change pins without checking back.
If the multi-arch step fails with "Multi-platform build is not supported for the docker driver", run `docker buildx create --name sentinel-builder --driver docker-container --use` once and re-run the test.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore tools/test_docker_image.sh
git commit -m "Add multi-arch Docker image for Linux hosts"
```

---

### Task 2: Compose service

**Files:**
- Create: `tools/test_docker_compose.sh`
- Create: `compose.yaml`

**Interfaces:**
- Consumes: the image from Task 1 (`build: .`), its `CMD`, and its `/data` writability guard; the app's `GET /api/status` → `{"go2rtc": bool, "streams": {...}, ...}` and `GET /api/settings` → the settings JSON (`connection.host`, `channels[].name`, ...).
- Produces: `compose.yaml` with service name `sentinel-eye`. It honors the env vars `SENTINEL_HOST`, `SENTINEL_PORT`, `TZ`, and `SENTINEL_DATA_DIR` (host path of the data dir, default `./data`). Task 3 documents these names.

- [ ] **Step 1: Write the failing test**

Create `tools/test_docker_compose.sh`:

```bash
#!/usr/bin/env bash
# Stack checks for the Docker deployment (docs/superpowers/specs/2026-09-27-linux-docker-deploy-design.md,
# "Testing" 3, plus the plan's Review Focus). Uses a scratch data dir and port 18007, never ./data.
# go2rtc's own ports (1984, 8554, 8555) are fixed, so a local ./run.sh must be stopped first.
# macOS: needs Docker Desktop host networking enabled.
#   tools/test_docker_compose.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=sentinel-eye-test
export SENTINEL_PORT=18007
IMG=sentinel-eye:local
SCRATCH=$(mktemp -d)
fail() { echo "FAIL: $*" >&2; docker compose logs --tail 50 >&2 || true; exit 1; }
cleanup() { docker compose down -t 15 >/dev/null 2>&1 || true
            docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" "$IMG" rm -rf /s/data >/dev/null 2>&1 || true
            rm -rf "$SCRATCH"; }
trap cleanup EXIT

for port in 18007 1984 8554 8555; do
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then fail "port $port is in use (stop ./run.sh first)"; fi
done

docker compose build

# fresh data dir owned by UID 1000, optionally seeded with a settings.json
prep_data() {  # $1 = owner uid:gid, $2 = settings.json content or ""
  docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" "$IMG" sh -c "rm -rf /s/data && mkdir /s/data"
  [ -n "$2" ] && printf '%s' "$2" > "$SCRATCH/settings.json.seed" \
    && docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" "$IMG" cp /s/settings.json.seed /s/data/settings.json
  docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" "$IMG" chown -R "$1" /s/data
  export SENTINEL_DATA_DIR="$SCRATCH/data"
}
wait_healthy() {
  local cid; cid=$(docker compose ps -q sentinel-eye)
  for _ in $(seq 1 45); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$cid")" = healthy ] && return 0
    sleep 2
  done
  fail "container never became healthy"
}
base() { echo "http://127.0.0.1:$SENTINEL_PORT"; }

echo "== 1. empty data dir, no DVR: starts, serves UI and API =="
prep_data 1000:1000 ""
docker compose up -d
wait_healthy
curl -fsS "$(base)/" | grep -qi "<html" || fail "GET / did not serve the UI"
curl -fsS "$(base)/api/settings" | python3 -c 'import json,sys; json.load(sys.stdin)' || fail "GET /api/settings is not JSON"
[ "$(docker compose exec -T sentinel-eye stat -c %a /data/settings.json)" = 600 ] || fail "settings.json is not mode 600"
[ "$(docker compose exec -T sentinel-eye stat -c %u /data/settings.json)" = 1000 ] || fail "settings.json not owned by 1000"

echo "== 2. shutdown is prompt =="
t0=$(date +%s); docker compose down -t 15; t1=$(date +%s)
[ $((t1 - t0)) -lt 9 ] || fail "docker compose down took $((t1 - t0))s (SIGTERM not reaching uvicorn?)"

echo "== 3. migrated data with an unreachable DVR: settings kept, still healthy =="
prep_data 1000:1000 '{"connection":{"host":"192.0.2.10","username":"admin","password":"x"},"channels":[{"id":"c1","channel":1,"name":"Migrated Cam"}]}'
docker compose up -d
wait_healthy
curl -fsS "$(base)/api/settings" | python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s["connection"]["host"] == "192.0.2.10", s["connection"]
assert s["channels"][0]["name"] == "Migrated Cam", s["channels"]
' || fail "migrated settings.json was not loaded"
docker compose down -t 15

echo "== 4. SENTINEL_HOST=127.0.0.1: healthcheck follows the bind address =="
prep_data 1000:1000 ""
SENTINEL_HOST=127.0.0.1 docker compose up -d
wait_healthy
docker compose down -t 15

echo "== 5. unwritable data dir: exits with a chown hint =="
if [ "$(uname)" = Linux ]; then
  prep_data 0:0 ""
  docker compose up -d
  sleep 5
  docker compose logs sentinel-eye | grep -q "chown 1000:1000 data" || fail "no chown hint in logs"
  docker compose down -t 15
else
  echo "(skipped: bind-mount ownership isn't enforced by Docker Desktop on $(uname))"
fi

echo "PASS"
```

Then `chmod +x tools/test_docker_compose.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `tools/test_docker_compose.sh`
Expected: FAIL at `docker compose build` with "no configuration file provided: not found".

- [ ] **Step 3: Write `compose.yaml`**

```yaml
# Sentinel Eye on a Linux host. See README "Run on a Linux VM with Docker".
# There is no login: anything that can reach SENTINEL_PORT controls the app, including the DVR password.
services:
  sentinel-eye:
    build: .
    image: sentinel-eye:local
    restart: unless-stopped
    # Host networking so go2rtc's WebRTC (8555 TCP/UDP) advertises the VM's own addresses on the LAN/VPN.
    network_mode: host
    # tini as PID 1 reaps go2rtc, hikrelay and ffmpeg children.
    init: true
    stop_grace_period: 15s
    environment:
      SENTINEL_HOST: ${SENTINEL_HOST:-0.0.0.0}
      SENTINEL_PORT: ${SENTINEL_PORT:-8007}
      TZ: ${TZ:-UTC}
    volumes:
      # Must be owned by UID 1000 before first start: mkdir -p data && sudo chown 1000:1000 data
      - ${SENTINEL_DATA_DIR:-./data}:/data
      # First run only: seed data/settings.json from .env (DVR_HOST/DVR_USER/DVR_PASS/DVR_KEY),
      # then remove this line again.
      # - ./.env:/app/.env:ro
    healthcheck:
      # Healthy = the web server answers AND go2rtc is up. Calls the bind address when it's a specific IP.
      test: ["CMD", "python", "-c", "import json,os,urllib.request as u; h=os.environ['SENTINEL_HOST']; h='127.0.0.1' if h in ('','0.0.0.0','::') else h; assert json.load(u.urlopen('http://%s:%s/api/status' % (h, os.environ['SENTINEL_PORT']), timeout=5))['go2rtc']"]
      interval: 30s
      timeout: 10s
      start_period: 30s
      start_interval: 2s
      retries: 3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tools/test_docker_compose.sh`
Expected: ends with `PASS` (case 5 prints "skipped" on macOS).
If `curl` to `127.0.0.1:18007` fails on macOS while the container is healthy, Docker Desktop host networking is off. Enable it (Settings → Resources → Network), restart Docker Desktop, and re-run.

- [ ] **Step 5: Commit**

```bash
git add compose.yaml tools/test_docker_compose.sh
git commit -m "Add Docker Compose service with healthcheck"
```

---

### Task 3: README — Run on a Linux VM with Docker

**Files:**
- Modify: `README.md`. Insert a new `### Run on a Linux VM with Docker` section after the `### Stop` section's code block and before `## Installing as an app`.

**Interfaces:**
- Consumes: env var names from Task 2 (`SENTINEL_HOST`, `SENTINEL_PORT`, `TZ`, `SENTINEL_DATA_DIR`), the `.env` mount line, and test script names from Tasks 1–2.
- Produces: operator documentation only.

- [ ] **Step 1: Write the failing check**

Run:
```bash
grep -q "^### Run on a Linux VM with Docker" README.md && grep -q "chown 1000:1000 data" README.md \
  && grep -q "/api/playback/ws" README.md && echo OK || echo MISSING
```
Expected: `MISSING`

- [ ] **Step 2: Insert the section**

Place this text in `README.md` immediately before the line `## Installing as an app`:

````markdown
### Run on a Linux VM with Docker

Tested target: Ubuntu on amd64 with Docker Engine and the Compose plugin. The image is multi-arch
(amd64/arm64) and bundles Python, ffmpeg and go2rtc. The [AI frame enhancer](#ai-frame-enhancer) is not
included. The VM must be able to reach the recorder's IP directly (same LAN or routed).

```sh
git clone https://github.com/aweher/sentinel-eye.git && cd sentinel-eye
mkdir -p data && sudo chown 1000:1000 data     # the container runs as UID 1000
docker compose up -d --build
```

Then open `http://<vm-ip>:8007` and enter the recorder in **Settings**. The container uses host
networking, so on your LAN/VPN live view gets WebRTC exactly like a native install.

- **Seeding from `.env` instead:** uncomment the `./.env:/app/.env:ro` line in `compose.yaml` before the
  first start. It is read only when `data/settings.json` doesn't exist yet, so remove the line afterwards.
- **Moving an existing install:** stop the old one, copy its whole `data/` directory to the VM, and
  `sudo chown -R 1000:1000 data`. Keeping `export_signing_key.pem` keeps earlier exports verifiable.
- **Settings via environment** (exported in the shell before `docker compose up`, or edited in `compose.yaml`): `SENTINEL_HOST`
  (default `0.0.0.0`; set it to a VPN address to listen only there), `SENTINEL_PORT` (default `8007`),
  `TZ` (log timestamps only, since the app takes its time zone from the recorder), `SENTINEL_DATA_DIR` (host path, default
  `./data`).
- **Logs:** `docker compose logs -f` (server), `data/go2rtc.log` (go2rtc).
- **Update:** `git pull && docker compose up -d --build`. **Stop:** `docker compose down`.
- **Tests:** `tools/test_docker_image.sh` and `tools/test_docker_compose.sh`.

**Reaching it from the internet:** there is still no login, so never publish port 8007 directly. Put it
behind a reverse proxy or tunnel that **authenticates every request** (for example Cloudflare Access,
oauth2-proxy, or your proxy's own auth), and make sure it passes WebSocket upgrades for `/ws` and
`/api/playback/ws`. Through an HTTP-only tunnel WebRTC can't connect, and the player falls back to MSE over
that WebSocket automatically (slightly more latency, same picture).
````

- [ ] **Step 3: Run the check to verify it passes**

Run the same command as Step 1.
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: document running on a Linux VM with Docker"
```

---

### Task 4: Real-recorder smoke test (spec Testing 4)

**Files:** none (verification only; nothing is committed).

**Interfaces:**
- Consumes: `compose.yaml` (Task 2), the operator's real `data/` (holds DVR credentials, never copied into the repo or image), and `GET /api/status` → `streams` with a `producers` count per stream.

- [ ] **Step 1: Check whether the recorder is reachable from this machine**

Run: `python3 -c "import json; print(json.load(open('data/settings.json'))['connection']['host'])"` to get the host. Then run `nc -z -w 3 <host> 554 && echo reachable || echo unreachable`.
If `unreachable`, stop here. Report that the recorder is not reachable from the build machine and that this check has to run on the VM (`docker compose up -d`, then Step 3 against `http://<vm-ip>:8007`).

- [ ] **Step 2: Start with a copy of the real data**

```bash
./stop.sh
SCRATCH=$(mktemp -d); cp -Rp data "$SCRATCH/data"
docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" sentinel-eye:local chown -R 1000:1000 /s/data
SENTINEL_DATA_DIR="$SCRATCH/data" SENTINEL_PORT=18007 COMPOSE_PROJECT_NAME=sentinel-eye-smoke docker compose up -d
```

- [ ] **Step 3: Confirm live sub-streams have producers**

Wait about 20 s, then run:
```bash
curl -fsS http://127.0.0.1:18007/api/status | python3 -c '
import json, sys
st = json.load(sys.stdin)["streams"]
live = {n: v for n, v in st.items() if n.endswith("_sub") and v["producers"] > 0}
print(f"{len(live)} sub-streams with producers:", sorted(live))
sys.exit(0 if live else 1)
'
```
Expected: exit 0 with at least one `_sub` stream listed. Sub-streams are preloaded, so go2rtc connects them without a viewer.
Then open `http://127.0.0.1:18007` in a browser and confirm a tile plays.

- [ ] **Step 4: Clean up**

```bash
COMPOSE_PROJECT_NAME=sentinel-eye-smoke docker compose down -t 15
docker run --rm --user 0 -v "$SCRATCH":/s --entrypoint "" sentinel-eye:local rm -rf /s/data; rm -rf "$SCRATCH"
```
Report the result of Step 3 (pass/fail with output) in the final summary.
