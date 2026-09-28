#!/usr/bin/env bash
# Start Sentinel Eye: web UI + settings API on http://127.0.0.1:8007 (go2rtc is started by the server).
set -e
cd "$(dirname "$0")"

# ffmpeg must be on PATH. macOS installs it via Homebrew (whose bin dir isn't always on a GUI shell's
# PATH); Linux and Windows package managers put it somewhere already on PATH.
if [ "$(uname -s)" = "Darwin" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "No .venv found — run this first:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# bin/go2rtc is .gitignore'd (a binary, and arch-specific), so a fresh clone never has it. Fetch it on
# first run rather than making that a separate manual step — this is meant to be a one-command "clone and
# ./run.sh" setup. Note the fetch differs by OS: upstream publishes macOS/Windows assets as .zip archives
# but Linux assets as bare binaries, so only the zip path needs unzip.
if [[ ! -x bin/go2rtc ]]; then
  GO2RTC_VERSION="v1.9.14"
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Darwin/arm64)               asset="go2rtc_mac_arm64.zip";   kind=zip ;;
    Darwin/x86_64)              asset="go2rtc_mac_amd64.zip";   kind=zip ;;
    Linux/x86_64)               asset="go2rtc_linux_amd64";     kind=bin ;;
    Linux/aarch64|Linux/arm64)  asset="go2rtc_linux_arm64";     kind=bin ;;
    Linux/armv7l|Linux/armv6l)  asset="go2rtc_linux_arm";       kind=bin ;;
    Linux/i686|Linux/i386)      asset="go2rtc_linux_i386";      kind=bin ;;
    *) echo "go2rtc: unsupported platform $os/$arch — download it manually from" \
            "https://github.com/AlexxIT/go2rtc/releases and place it at bin/go2rtc" >&2; exit 1 ;;
  esac
  echo "Fetching go2rtc $GO2RTC_VERSION ($asset)…"
  mkdir -p bin
  work=$(mktemp -d)
  url="https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION/$asset"
  if [[ $kind == zip ]]; then
    curl -fsSL "$url" -o "$work/go2rtc.zip"
    unzip -q -o "$work/go2rtc.zip" -d "$work"
    mv "$work/go2rtc" bin/go2rtc
  else
    curl -fsSL "$url" -o bin/go2rtc
  fi
  chmod +x bin/go2rtc
  # macOS only: clears the quarantine flag curl can add when a proxy tags the download. Harmless elsewhere.
  if [[ $os == Darwin ]]; then xattr -d com.apple.quarantine bin/go2rtc 2>/dev/null || true; fi
  rm -rf "$work"
fi

# macOS only: a python.org build doesn't trust a system CA bundle by default (no "Install
# Certificates.command" run for this venv) — without this, the AI frame enhancer's one-time model-weight
# download over HTTPS (docs/SPEC.md section 7.8) fails with SSL_CERT_VERIFY_FAILED. certifi is already a
# transitive dependency. Skipped on Linux/Windows, whose Python uses the system trust store — forcing
# SSL_CERT_FILE there can *break* TLS if the system store isn't certifi's bundle.
if [ "$(uname -s)" = "Darwin" ]; then
  SSL_CERT_FILE="$(.venv/bin/python3 -c 'import certifi; print(certifi.where())' 2>/dev/null)" || true
  export SSL_CERT_FILE
fi

# Binds 127.0.0.1 by default, matching the README: there is no login, so the dashboard is not reachable
# from other machines unless you opt in. Set SENTINEL_HOST=0.0.0.0 to watch from your phone/TV on a
# network you trust.
exec .venv/bin/uvicorn --app-dir app server:app --host "${SENTINEL_HOST:-127.0.0.1}" --port "${SENTINEL_PORT:-8007}"
