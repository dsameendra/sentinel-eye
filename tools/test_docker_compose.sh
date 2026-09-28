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

# Engine 25+ only healthcheck keys make compose reject the file on older distro Docker (e.g. Ubuntu docker.io).
! grep -E "^\s*start_interval:" compose.yaml >/dev/null || fail "compose.yaml uses start_interval (needs Docker Engine 25+)"

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
curl -fsS "$(base)/" | grep -i "<html" >/dev/null || fail "GET / did not serve the UI"
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
  docker compose logs sentinel-eye | grep "sudo chown -R 1000:1000 data" >/dev/null || fail "no chown -R hint in logs"
  docker compose down -t 15
else
  echo "(skipped: bind-mount ownership isn't enforced by Docker Desktop on $(uname))"
fi

echo "== 6. SENTINEL_ADMIN_PASSWORD: sign-in on, healthcheck still passes, status says nothing more =="
prep_data 1000:1000 ""
SENTINEL_ADMIN_PASSWORD="compose test password" docker compose up -d
wait_healthy
[ "$(curl -s -o /dev/null -w '%{http_code}' "$(base)/api/settings")" = 401 ] || fail "settings reachable without signing in"
curl -fsS "$(base)/api/status" | python3 -c 'import json,sys; s=json.load(sys.stdin); assert list(s) == ["go2rtc"], s' \
  || fail "unauthenticated /api/status says more than go2rtc"
jar="$SCRATCH/cookies"
curl -fsS -c "$jar" -H 'Content-Type: application/json' -d '{"username":"admin","password":"compose test password"}' \
  "$(base)/api/auth/login" >/dev/null || fail "admin from SENTINEL_ADMIN_PASSWORD can't sign in"
curl -fsS -b "$jar" "$(base)/api/settings" >/dev/null || fail "signed-in admin can't read settings"
[ "$(docker compose exec -T sentinel-eye stat -c %a /data/auth.db)" = 600 ] || fail "auth.db is not mode 600"
docker compose down -t 15

echo "PASS"
