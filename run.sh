#!/bin/zsh
# Start Sentinel Eye: web UI + settings API on http://127.0.0.1:8007 (go2rtc is started by the server).
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"   # ffmpeg

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "No .venv found — run this first:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# bin/go2rtc is .gitignore'd (a binary, and arch-specific), so a fresh clone never has it. Fetch it on
# first run rather than making that a separate manual step — this is meant to be a one-command "clone and
# ./run.sh" setup.
if [[ ! -x bin/go2rtc ]]; then
  GO2RTC_VERSION="v1.9.14"
  case "$(uname -m)" in
    arm64)  asset="go2rtc_mac_arm64.zip" ;;
    x86_64) asset="go2rtc_mac_amd64.zip" ;;
    *) echo "go2rtc: unsupported architecture $(uname -m) — download it manually from" \
            "https://github.com/AlexxIT/go2rtc/releases and place it at bin/go2rtc" >&2; exit 1 ;;
  esac
  echo "Fetching go2rtc $GO2RTC_VERSION ($asset)…"
  mkdir -p bin
  work=$(mktemp -d)
  curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION/$asset" -o "$work/go2rtc.zip"
  unzip -q -o "$work/go2rtc.zip" -d "$work"
  mv "$work/go2rtc" bin/go2rtc
  chmod +x bin/go2rtc
  xattr -d com.apple.quarantine bin/go2rtc 2>/dev/null || true  # only set if curl went through a proxy that tags downloads; harmless no-op otherwise
  rm -rf "$work"
fi

# This python.org build doesn't trust a system CA bundle by default (no "Install Certificates.command" run
# for this venv) — without this, the AI frame enhancer's one-time model-weight download over HTTPS
# (docs/SPEC.md section 7.8) fails with SSL_CERT_VERIFY_FAILED. certifi is already a transitive dependency.
SSL_CERT_FILE="$(.venv/bin/python3 -c 'import certifi; print(certifi.where())' 2>/dev/null)" || true
export SSL_CERT_FILE
exec .venv/bin/uvicorn --app-dir app server:app --host "${SENTINEL_HOST:-0.0.0.0}" --port "${SENTINEL_PORT:-8007}"
