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
run bin/go2rtc -version | grep "1.9.14" >/dev/null || fail "bin/go2rtc is not v1.9.14"

echo "== ffmpeg with libx264, ffprobe =="
run ffmpeg -hide_banner -encoders | grep libx264 >/dev/null || fail "ffmpeg has no libx264 encoder"
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

# Named volumes enforce ownership even on Docker Desktop (unlike its bind mounts), so the data-dir guard
# is exercised here on every platform.
guard_case() {  # $1 = label, $2 = root shell snippet that breaks /data ownership
  local vol="sentinel-eye-guard-$$"
  docker volume create "$vol" >/dev/null
  docker run --rm --platform linux/amd64 --user 0 -v "$vol":/data --entrypoint "" "$IMG" sh -c "touch /data/.keep && $2"
  local cid out
  cid=$(docker run -d --platform linux/amd64 -v "$vol":/data "$IMG")
  docker wait "$cid" >/dev/null & local waiter=$!
  ( sleep 20; kill "$waiter" 2>/dev/null ) & local killer=$!
  wait "$waiter" 2>/dev/null || true; kill "$killer" 2>/dev/null || true
  out=$(docker logs "$cid" 2>&1); local state; state=$(docker inspect -f '{{.State.Status}}' "$cid")
  docker rm -f "$cid" >/dev/null; docker volume rm "$vol" >/dev/null
  [ "$state" = exited ] || fail "$1: container is still running instead of exiting"
  echo "$out" | grep "sudo chown -R 1000:1000 data" >/dev/null || fail "$1: no 'chown -R' hint in: $out"
}
echo "== data-dir guard: root-owned /data =="
guard_case "root-owned /data" "chown 0:0 /data && chmod 755 /data"
echo "== data-dir guard: writable /data but root-owned settings.json (mode 600) =="
guard_case "root-owned settings.json" "chown 1000:1000 /data && echo '{}' > /data/settings.json && chmod 600 /data/settings.json"

echo "== multi-arch build (linux/amd64 + linux/arm64) =="
docker buildx build --platform linux/amd64,linux/arm64 . >/dev/null || fail "multi-arch build failed"

echo "PASS"
