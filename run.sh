#!/bin/zsh
# Start Sentinel Eye: web UI + settings API on http://127.0.0.1:8080 (go2rtc is started by the server).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"   # ffmpeg
exec .venv/bin/uvicorn --app-dir app server:app --host "${SENTINEL_HOST:-127.0.0.1}" --port "${SENTINEL_PORT:-8080}"
