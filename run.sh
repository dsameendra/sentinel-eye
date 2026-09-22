#!/bin/zsh
# Start Sentinel Eye: web UI + settings API on http://127.0.0.1:8080 (go2rtc is started by the server).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"   # ffmpeg
# This python.org build doesn't trust a system CA bundle by default (no "Install Certificates.command" run
# for this venv) — without this, the AI frame enhancer's one-time model-weight download over HTTPS
# (docs/enhance-ai-spec.md) fails with SSL_CERT_VERIFY_FAILED. certifi is already a transitive dependency.
export SSL_CERT_FILE="$(.venv/bin/python3 -c 'import certifi; print(certifi.where())' 2>/dev/null)"
exec .venv/bin/uvicorn --app-dir app server:app --host "${SENTINEL_HOST:-127.0.0.1}" --port "${SENTINEL_PORT:-8080}"
