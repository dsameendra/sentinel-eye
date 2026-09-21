# Sentinel Eye

Self-hosted web dashboard for Hikvision recorders/cameras. It reads the standard RTSP streams over your
LAN, **decrypts Hikvision "Stream Encryption"** when it is on, and shows them in the browser. No
plugin, no Hikvision cloud, no dependence on the recorder's own analytics. (Stage 2+ adds recording,
motion/object events, plate and face recognition.)

## Run

```sh
brew install ffmpeg                      # once
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
# bin/go2rtc: download the macOS build from github.com/AlexxIT/go2rtc/releases (already present here)
./run.sh                                 # http://127.0.0.1:8080
./stop.sh
```

First run seeds `data/settings.json` from `.env` (`DVR_HOST`, `DVR_USER`, `DVR_PASS`, `DVR_KEY`) if it exists;
after that everything is edited in **Settings**. `data/` holds credentials (mode 600) and is git-ignored.
`SENTINEL_HOST` / `SENTINEL_PORT` change the listen address. There is no login: keep it on `127.0.0.1`
or a trusted network.

## What you get

- **Live view**: layouts 1×1, 2×2, 3×2, 3×3, 4×3, 4×4, 1+5, 1+7, 2+8 with pages; drag to reorder (Arrange);
  SD / HD / Auto quality (Auto = HD only in big tiles and the large view); large view with snapshot,
  full screen and camera-to-camera arrows; clicking a picture never pauses it.
- **Settings**: recorder address/login, encryption toggle + verification code (field disabled while off),
  test connection, channel list (names, order, per-stream fps override, custom RTSP paths), *Detect
  channels* (also reads the recorder's camera names), display options, status.
- Keys: `←/→` pages or cameras, `1-9` open camera, `E` arrange, `F` full screen, `H` HD/SD, `S` snapshot, `Esc`.

## How it works

```
recorder --RTSP--> hikrelay.py (decrypt, measure fps) --ffmpeg--> go2rtc --WebRTC/MSE--> browser
                     (only when encryption is on; otherwise go2rtc pulls the camera directly)
```

- `app/server.py` FastAPI: settings API, connection test, WebSocket proxy, static UI.
- `app/go2rtc.py` generates go2rtc's config from the settings and restarts it on change.
- `app/hikrelay.py` the decrypting relay (see `tools/NOTES.md` for the reverse-engineered scheme).
- `web/` plain ES modules, no build step.
- SD streams stay connected (needed for events later); HD streams start when opened and are
  converted H.265 -> H.264 on the Mac (smooth in every browser). "Play directly" is opt-in.

## Tests

`tools/test_rig.sh start` builds an isolated instance against a fake unencrypted camera;
`python tools/e2e_ui.py http://127.0.0.1:8081 <shotdir>` runs 40 browser checks (headless Chrome via CDP).
`tools/e2e_live.py` and `tools/e2e_real_settings.py` check the real recorder without changing anything.
