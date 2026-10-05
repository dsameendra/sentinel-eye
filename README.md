<img src="web/icons/app-icon-512.png" width="88" height="88" alt="Sentinel Eye" align="left" style="margin-right:16px">

# Sentinel Eye

A self-hosted web dashboard for Hikvision recorders and cameras — live viewing, DVR/NVR playback and review,
event search, exports, and real-time AI-assisted enhancement, all running on your own machine.

<br clear="left">

No Hikvision app, no plugin, and no cloud account. It reads the recorder's standard RTSP streams over your
LAN and, when the recorder's proprietary "Stream Encryption" is turned on, decrypts them itself (the scheme
was reverse-engineered from scratch — see `tools/NOTES.md`). Nothing about how you watch or review your
cameras ever leaves your network.

![Live camera grid with page tools on the left and destination navigation beside notifications and Account](docs/screenshots/live-grid.jpg)

*(Screenshots use an isolated synthetic camera rig or UI fixtures, with invented accounts and camera names. Playback images show the review interface without a connected recorder; the enhancer example is a UI fixture, not an AI quality result. No real surveillance footage is included. [Capture details](docs/adaptive-ui-validation.md).)*

## Why

Hikvision's own apps and cloud are the alternative to this project, not a neutral baseline. Sentinel Eye
exists to replace them outright: everything the vendor's software does — live view, recorded playback,
motion/event review, clip export, and increasingly AI-assisted analysis — running entirely on hardware you
control, with the recorder's proprietary encryption decrypted locally instead of trusted to a vendor plugin.

Built for my own needs first. Out of the box there's no login and it's meant for `127.0.0.1` or a network
you already trust; [sign-in](#sign-in-optional) is one form away when other people, a TV, or a tunnel get
involved.

## Features

### Live view
- Grid layouts from 1×1 up to 4×4, plus 1+5, 1+7 and 2+8 (one large tile, several small ones); several
  pages when you have more cameras than fit on one screen, with auto-rotation between them. The next page's
  cameras connect a few seconds before each rotation, so it lands on live pictures — only when there's
  headroom, and never at the expense of what's on screen.
- Drag tiles to reorder them ("Arrange" mode); the order is saved and used everywhere else in the app.
- Auto / SD / HD streaming (Auto: HD for the large tile and the focus view, SD for small tiles, to keep a big
  wall of cameras light), plus an HD/SD switch per camera.
- A focus view for any camera: the tile grows to fill the screen and shrinks back home when you close it;
  switch cameras with the arrows, take a snapshot, bookmark the moment, go full screen.
- Zoom and pan on any tile, the focus view, or a Playback pane — scroll wheel, trackpad or touch pinch, drag,
  or the on-screen controls, without ever pausing the picture. While zoomed, a minimap shows the whole
  picture with the part on screen outlined; click or drag it to move there.
- **Instant replay:** the last 15 seconds of any camera, full screen, with play/pause and start over — no
  need to leave the live view.
- Live event badges (motion, line-crossing, tamper, video loss) on the relevant tile, and a notification
  with a thumbnail of the moment when something new happens.
- **Channel-zero** (Settings → Channel-zero overview, on recorders that support it): the recorder's own
  single-stream overview of every camera at once — the same picture a monitor plugged straight into it would
  show. An **Overview** button in the live view switches to it full screen. It has no recording of its own,
  so there's no instant replay for it, and bookmarking it bookmarks every real camera at once instead.
- **TV mode** (Settings → Display & layout): a remote-friendly layout for leaving the cameras on a TV — see
  [TV mode](#tv-mode) below.

![One synthetic camera in Focus with grouped viewing controls](docs/screenshots/focus.jpg)

### Playback and review
- Review up to four cameras at once, frame-locked. Speeds run from 1/8× to 16×, within the recorder's own
  budget for fast playback (four cameras at 4×, two at 8×, one at 16× — faster choices than the cameras on
  screen allow are greyed out rather than failing).
- A zoomable, scrollable timeline with each camera's recorded coverage and events, click or drag to seek,
  and frame-accurate stepping forward and backward.
- A "select a range" tool for exporting exactly the footage you need, and a multi-cut clipper: build a list
  of ranges from several points in the timeline, then export them all as one batch.
- Bookmarks and incident notes on a moment, on one camera or several, searchable later.

![Desktop Playback workspace with date and camera tools, transport and timeline; recorder unavailable in this fixture](docs/screenshots/playback.jpg)

### Event search
- Motion, line-crossing, intrusion, tamper and video-loss events (and your own bookmarks) across cameras and
  date ranges, as thumbnails or a list, with a quick in-page preview before opening it in Playback or
  exporting. Your last search comes back instantly when you return to it.

![Event search with synthetic events, camera filters and consistent desktop navigation](docs/screenshots/events.jpg)

### Export
- Every export is a stream copy of the original footage — no re-encoding, no quality loss.
- **Signed evidence package** (recommended): the clip, a `manifest.json` covering every file's SHA-256 hash,
  the exact camera and DVR/NVR time range, and an Ed25519 signature over that manifest, plus an offline
  `verify.html` that checks it all in a browser with nothing installed and no server involved.
- **Plain MP4/MKV**: just the clip, for a quick look.

### Real-time enhancement ("the wand")
A WebGL filter chain that runs live, on the playing picture, at zero cost when switched off:
brightness/contrast/gamma, edge-aware sharpen, noise reduction, dark-channel-inspired dehaze, CLAHE-style
local contrast, digital WDR (highlight rolloff for backlit scenes), single-scale Retinex illumination
correction, temporal rain/snow-streak reduction, chromatic-aberration correction, and auto white balance
(corrects the color cast IR-lit night footage typically has). Every control is an independently adjustable,
stackable slider — presets are just one-click starting points, including one tuned for grainy, color-cast
IR night footage. A flashlight brightens just the spot under the pointer, and in Playback the filters can be
limited to a region.

### AI frame enhancer
From a paused frame in Playback — or up to 11 frames around it, aligned and fused first for less noise — a
local super-resolution + face-restoration pipeline produces the clearest, highest-resolution version of
that moment it can, for faces and license plates. Select a region first and every output pixel goes to it.
Settings → Enhancement picks the models — an upscaler (Real-ESRGAN, or SwinIR in faithful or sharp, standard
or large) and a face model (GFPGAN v1.4 or v1.3, or RestoreFormer) — or one of three measured pairings:
*Balanced* (fast), *Faithful* (closest to the real pixels) and *Most detail*; each result says which models
made it. **Read text** reads
plates and signs: draw a box around the text and turn it to match a slant, and the box is levelled, enlarged
and read, with the patch it read from shown beside the result. Licence plates go to a dedicated plate reader
(a small ONNX model) that reads both the enhanced and the original frame and keeps the more confident
reading; other text is read with Tesseract. It runs entirely on this machine and never
calls out to the cloud, and every enhanced picture carries an **ENHANCED** label, with the original frame
always kept alongside it: the distinction between "what the sensor recorded" and "the AI's best
reconstruction of it" is never blurred.

![Enhancer comparison interface with a synthetic source/result fixture and explicit provenance](docs/screenshots/enhancer.jpg)

### Settings
Recorder address and login, the encryption toggle and verification code, per-channel names/order/frame-rate
overrides and custom RTSP paths, a "detect channels" scan (also reads the recorder's own camera names),
theme, layout and streaming defaults, and live connection/engine status. With [sign-in](#sign-in-optional)
on, Security holds accounts, paired TVs, sessions, network access and an activity log, and Account is where
you change your password, two-factor, username and picture (your initial on a colour, a designed avatar, or
a photo).

![Display and layout settings with consistent navigation and appearance controls](docs/screenshots/settings.jpg)

### Keyboard shortcuts

Press `?` on Live or Playback for this list in the app.

**Live view — grid**

| Key | Action |
|---|---|
| `1` – `9` | Open that camera |
| `←` / `→` | Previous / next page |
| `E` | Arrange mode on / off |
| `F` | Full screen |
| `Esc` | Leave arrange mode |

**Live view — focus**

| Key | Action |
|---|---|
| `←` / `→` | Previous / next camera |
| `+` / `-` / `0` | Zoom in / out / reset |
| `S` | Snapshot |
| `B` | Bookmark this moment |
| `H` | Switch HD / SD |
| `F` | Full screen |
| `Esc` | Reset zoom, then back to the grid |

**Instant replay**

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `Home` | Start over |
| `Esc` | Back to live |

**Playback**

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `,` / `.` | One frame back / forward |
| `Shift` + `1` / `2` / `3` | Back 5 s / 10 s / 30 s |
| `Shift` + `4` / `5` / `6` | Forward 5 s / 10 s / 30 s |
| `B` | Bookmark this moment |
| `F` | Full screen |

## How it works

```mermaid
flowchart LR
    DVR["Hikvision DVR/NVR / cameras"] -- "RTSP" --> Relay["hikrelay.py<br/>(decrypt, measure fps)"]
    DVR -- "RTSP (unencrypted)" --> Go2rtc
    Relay -- "ffmpeg" --> Go2rtc["go2rtc"]
    Go2rtc -- "WebRTC / MSE" --> Browser["Browser (web/)"]
    Server["server.py (FastAPI)"] -. "settings API, WebSocket proxy,<br/>static files" .-> Browser
    Server -. "configures" .-> Go2rtc
    Server -. "starts" .-> Relay
```

The decrypting relay only runs when the recorder's Stream Encryption is turned on; otherwise go2rtc pulls
each camera directly. A few key files:

| File | Responsibility |
|---|---|
| `app/server.py` | FastAPI app: settings API, connection test, WebSocket proxy, static UI |
| `app/hikrelay.py` | The decrypting relay (`tools/NOTES.md` documents the reverse-engineered scheme) |
| `app/go2rtc.py` | Generates go2rtc's config from current settings and restarts it on change |
| `app/playback_session.py`, `app/timebase.py` | DVR/NVR playback sessions and the RTP-to-UTC clock calibration that makes multi-camera playback frame-locked |
| `app/export.py` | Stream-copy export, manifest generation, Ed25519 signing |
| `app/enhance_ai.py` | The local Real-ESRGAN/GFPGAN frame enhancer |
| `app/auth.py`, `app/auth_api.py` | Optional sign-in: accounts, roles, TOTP, sessions, TV pairing, and the per-route role checks |
| `app/hwaccel.py` | Picks the H.264 encoder for the live transcode (NVENC, VA-API, V4L2, VideoToolbox, or CPU) |
| `web/` | Plain ES modules, no build step, no framework |

SD streams stay connected at all times, so the grid starts instantly; HD streams start only when actually
viewed. HD is H.265 on the wire, transcoded to H.264 on this machine so it plays smoothly in every
browser — playing the original H.265 directly is an opt-in setting for lower CPU use.

## Running it

### Requirements
- **Docker** (the default): Docker Engine with the Compose plugin on Linux, or Docker Desktop on macOS with
  host networking enabled (Settings > Resources > Network). The image bundles Python, ffmpeg and go2rtc.
- **Or native** (`--native`): Python 3 and ffmpeg (`brew install ffmpeg` on macOS). Built and tested on
  macOS; native Linux (x86_64/arm64) is supported by `run.sh` but hasn't been verified yet.
- A Hikvision DVR/NVR or camera reachable over RTSP on your network

### `run.sh`: the whole lifecycle

```sh
./run.sh                 # = ./run.sh start: build/prepare if needed, start in the background, wait until healthy
./run.sh status          # running? healthy?
./run.sh logs            # follow the server log (go2rtc's is data/go2rtc.log)
./run.sh stop            # ./stop.sh does the same
./run.sh restart
./run.sh update          # git pull, rebuild / reinstall dependencies, restart if it was running
./run.sh backup          # data/ (settings, credentials, accounts, signing key, playback index) to backups/*.tar.gz
./run.sh setup           # just the preparation step of start
./run.sh shell           # Docker only: a shell inside the container
./run.sh clean           # remove the container + image (native: .venv and bin/go2rtc); data/ is kept
./run.sh help
```

Every command runs in Docker unless you add `--native` (or export `SENTINEL_MODE=native`), which runs the
server straight from a `.venv` on this machine instead: `./run.sh --native start`. Native `setup` creates
`.venv`, installs `requirements.txt` and fetches the right [go2rtc](https://github.com/AlexxIT/go2rtc) binary
for your OS and CPU into `bin/go2rtc`; `./run.sh --native run` runs it in the foreground (Ctrl-C stops it),
logging to the terminal instead of `data/sentinel.log`. `stop`, `status` and `logs` pick native on their own
when a native instance is running. Only one of the two can run at a time, since they share ports.

`backup` archives contain the DVR/NVR password; `backups/` is git-ignored and created with owner-only access.

### Configure

The first time you start it, Sentinel Eye seeds `data/settings.json` from a `.env` file in the project root,
if one exists (`run.sh` also passes it into the container on that first Docker start):

```sh
DVR_HOST=192.0.2.10
DVR_USER=admin
DVR_PASS=your-password
DVR_KEY=your-stream-encryption-verification-code   # only needed if Stream Encryption is on
```

`.env` is only read on that very first run — after that, everything (recorder address, login, encryption,
channels, display options) is edited from the in-app **Settings** screen. `data/` holds your credentials
(file mode 600) and is git-ignored; never commit it.

### AI frame enhancer (optional, native only)

Everything above is all you need for live view, playback, export, and the real-time "wand" filters. The
[AI frame enhancer](#ai-frame-enhancer) (Real-ESRGAN/SwinIR + GFPGAN/RestoreFormer, plus Tesseract and a plate reader for
Read text) is a separate, heavier opt-in — it pulls in PyTorch and its model weights (about 420 MB for the
defaults; each other model 67–349 MB, only if you choose it), and one of its dependencies
([basicsr](https://github.com/XPixelGroup/BasicSR), effectively unmaintained since 2022) needs a couple of
small local patches to install and run on current Python. It isn't in the Docker image. All of that is
scripted:

```sh
./run.sh --native setup
tools/install_enhance_deps.sh
```

Run it once, and again after an update that adds enhancer models (it's safe to re-run). Model weights
download into `data/models` the first time each is used — or ahead of time from Settings → Enhancement — and
are checked against pinned checksums; updates and `.venv` rebuilds keep them. If you skip this, everything
else works normally; only the frame-enhancer button will report it's unavailable.

### Listen address and port

Opens on **http://127.0.0.1:8007**. Until you turn on [sign-in](#sign-in-optional) there is no login, so
keep it on `127.0.0.1` or a network you trust. Set `SENTINEL_HOST`/`SENTINEL_PORT` to change the listen address
(default `0.0.0.0`, all interfaces), in either mode:

```sh
SENTINEL_HOST=127.0.0.1 SENTINEL_PORT=8090 ./run.sh restart
```

### Watching from your phone (or another device on your network)

With the default `SENTINEL_HOST=0.0.0.0`, on your phone (connected to the **same Wi-Fi**) browse to
`http://<this-machine's-LAN-IP>:8007` — find the IP with `ipconfig getifaddr en0` (Wi-Fi) on a Mac.

Without [sign-in](#sign-in-optional), this makes the dashboard — and your camera feeds — reachable by
**anything else on that network**, not just your phone: other devices on the same Wi-Fi, a guest network if
it shares the same subnet, or anyone who has the Wi-Fi password. Only leave it open on a Wi-Fi network you
actually trust; otherwise turn sign-in on first.

The frontend is plain JavaScript with no build step. Natively a UI change just needs a browser refresh and a
backend (Python) change needs `./run.sh --native restart`; in Docker both need `./run.sh update` (the code is
baked into the image).

### GPU acceleration

With the default "convert H.265 on the server" setting, every camera's main stream is re-encoded to H.264
live, which is the heaviest thing the server does. At startup it picks the H.264 encoder by running a short
test encode on each candidate, and uses the first one that works:

- **macOS:** VideoToolbox.
- **Linux:** NVIDIA (NVENC), then Intel/AMD (VA-API, via `/dev/dri`), then V4L2 M2M (e.g. Raspberry Pi),
  and the CPU (libx264) when none works.

Only encoding moves to the GPU; decoding stays on the CPU on purpose (a hardware H.265 decoder has already
choked on this NVR's stream once). `./run.sh status` and `/api/status` show the choice (`encoder:` /
`"hwaccel"`), and the server log says which one it picked at startup. Force one with
`SENTINEL_HWACCEL=nvenc|vaapi|v4l2m2m|videotoolbox|cpu`; if the forced one fails its test encode, it falls
back to the CPU and logs why.

In Docker, `./run.sh` passes the host's GPU into the container on Linux by itself: `/dev/dri` (with the
render node's group, so the container user can open it) and, when the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
is installed, the NVIDIA GPU. It writes that to `compose.gpu.yaml` (git-ignored); with plain
`docker compose`, add `-f compose.gpu.yaml` after `./run.sh setup` has generated it. `SENTINEL_GPU=off`
skips the passthrough. Docker Desktop (macOS) can't pass a GPU through, so there it's always the CPU; run
natively to get VideoToolbox. Natively on Linux, your user needs to be in the render node's group (usually
`render`), which `./run.sh --native setup` warns about.

### Run on a Linux VM with Docker

Tested target: Ubuntu on amd64 with Docker Engine and the Compose plugin. The image is multi-arch
(amd64/arm64) and bundles Python, ffmpeg, go2rtc and the VA-API drivers (see *GPU acceleration*). The [AI frame enhancer](#ai-frame-enhancer) is not
included. The VM must be able to reach the recorder's IP directly (same LAN or routed).

```sh
git clone https://github.com/dsameendra/sentinel-eye.git && cd sentinel-eye
./run.sh    # builds the image, gives data/ to UID 1000 (asks for sudo once), starts, waits until healthy
```

Then open `http://<vm-ip>:8007` and enter the recorder in **Settings**. The container uses host
networking, so on your LAN/VPN live view gets WebRTC exactly like a native install.

**Playback needs HTTPS or localhost.** Browsers only enable WebCodecs, which Playback, event previews and
instant replay decode with, on a secure origin. On plain `http://<vm-ip>:8007` live view works, but
recordings don't. Either put it behind HTTPS (see *Reaching it from the internet* below), or use an SSH tunnel
from your computer, `ssh -N -L 8007:127.0.0.1:8007 <vm>`, and open `http://localhost:8007`.

- **Seeding from `.env` instead:** create `.env` before the first `./run.sh` (see *Configure*). With plain
  `docker compose`, uncomment the `./.env:/app/.env:ro` line in `compose.yaml` for the first start instead,
  and remove it afterwards.
- **Moving an existing install:** stop the old one, copy its whole `data/` directory to the VM, and
  `sudo chown -R 1000:1000 data`. Keeping `export_signing_key.pem` keeps earlier exports verifiable.
- **Settings via environment** (exported in the shell before `./run.sh start`, or edited in
  `compose.yaml`): `SENTINEL_HOST` (default `0.0.0.0`; set it to a VPN address to listen only there),
  `SENTINEL_PORT` (default `8007`), `TZ` (log timestamps only, since the app takes its time zone from the
  recorder), `SENTINEL_DATA_DIR` (host path, default `./data`), `SENTINEL_ADMIN_USER` /
  `SENTINEL_ADMIN_PASSWORD` (turn [sign-in](#sign-in-optional) on at first start).
- **Logs:** `./run.sh logs` (server), `data/go2rtc.log` (go2rtc).
- **Update:** `./run.sh update`. **Stop:** `./run.sh stop`. Plain `docker compose` works too; `run.sh`
  only wraps it.
- **Tests:** `tools/test_docker_image.sh`, `tools/test_docker_compose.sh`,
  `.venv/bin/python3 tools/test_hwaccel.py` (encoder selection, no GPU needed), and the sign-in suites
  (see [Testing](#testing)).

**Reaching it from the internet:** turn [sign-in](#sign-in-optional) on first (ideally with two-factor
for admins), and never publish port 8007 directly: put it behind a reverse proxy or tunnel that terminates
HTTPS and passes WebSocket upgrades for `/ws` and `/api/playback/ws`. If you'd rather have single sign-on,
the proxy can authenticate too (Cloudflare Access, oauth2-proxy, …) in front of or instead of the built-in
sign-in. Through an HTTP-only tunnel WebRTC can't connect, and the player falls back to MSE over that
WebSocket automatically (slightly more latency, same picture).

## Sign-in (optional)

Off by default: with no accounts, everyone who can reach the address is effectively an admin, exactly as
before. It turns on the moment the first account exists, either from **Settings → Security & sign-in → Turn on
sign-in**, or at start-up with `SENTINEL_ADMIN_PASSWORD` (and optionally `SENTINEL_ADMIN_USER`, default
`admin`) in the environment — used only while there are no accounts, so leaving it set never overwrites a
password changed later.

| | Viewer | Operator | Admin |
|---|:-:|:-:|:-:|
| Live view, snapshots, zoom, instant replay | ✅ | ✅ | ✅ |
| Playback, event search, bookmarks, exports, frame enhancer | | ✅ | ✅ |
| Shared layout and camera order | | ✅ | ✅ |
| Recorder connection, channels, all settings, accounts | | | ✅ |

The server enforces this on every request and WebSocket; the interface just hides what you can't use. A
viewer's copy of the settings doesn't include the recorder's address or login.

- **Two-factor authentication:** each person can turn it on from the account menu (any authenticator app),
  with ten single-use recovery codes. **Require two-factor for admins** makes it mandatory for them.
- **TVs and shared screens:** on the TV, open the address and pick **Pair this device** (TV-mode browsers go
  straight there). It shows a code and a QR; an admin scans it or opens `/pair` on their phone, names the
  device and chooses Viewer or Operator. No password is typed on the TV, and it stays signed in for a year
  of use. Removing it in Settings → Security & sign-in (or from Your account) cuts its streams right away.
- **Sessions:** "Keep me signed in" lasts 30 days of use, otherwise 12 hours (both adjustable). Everyone can
  see and sign out their own devices; admins see all of them. Changing a password signs out your other
  devices.
- **Trusted networks:** optionally let a LAN (e.g. `192.168.1.0/24`) in without signing in, as Viewer or
  Operator, never Admin. Requests that came through a proxy or tunnel always sign in, even from a listed
  address: a tunnel running on the same machine makes internet traffic arrive from `127.0.0.1`, which is why
  that address is only trusted if you list it, and Security warns when you do.
- **Reverse proxies:** list their addresses under *Reverse proxies* so the activity log shows real client
  addresses and cookies get the `Secure` flag behind HTTPS.
- **Locked out?** On the server (inside Docker: `./run.sh shell`, or `docker compose exec sentinel-eye …`):

  ```sh
  python app/auth.py reset-password admin     # also: list-users, disable-2fa <user>,
                                              #       revoke-sessions <user>, disable-auth
  ```

Accounts, sessions and the activity log live in `data/auth.db` (passwords as scrypt hashes, session tokens
only as hashes); `./run.sh backup` includes it.

How it's protected, what's in scope, and how to report a vulnerability privately: [SECURITY.md](SECURITY.md).

## Installing as an app

Sentinel Eye installs as a standalone app on iPhone, iPad, and Mac — no App Store, just the browser's own
install mechanism:

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
- **Mac (Safari, Chrome, or Edge):** the browser's install button, or Safari's **Add to Dock**.

It opens full-screen with its own icon and no address bar, and still talks directly to your own Mac over
your network — installing it changes nothing about how or where data moves.

Installed iPhone/iPad navigation uses a solid surface matching the selected theme, with shared safe-area
spacing across pages and overlays. If an installed app still shows an older header after an update, close
it completely and relaunch online. The [iOS PWA header audit](docs/ios-pwa-header-plan.md) documents the
shell-version check, the user-confirmed blur fix, and remaining native-device acceptance for the adaptive layout.

<p align="center"><img src="docs/screenshots/mobile-live.jpg" width="320" alt="Sentinel Eye on a phone: the live view as a two-column grid with a tab bar for Live, Playback, Events and Settings"></p>

### Adaptive navigation and viewing

Desktop and iPad keep Live, Playback, Events and Settings together immediately left of notifications and Account. Phones use a floating bottom capsule in portrait and landscape. Settings opens as a grouped section list on compact screens; forms, save controls and event filters adapt to the available space in either theme.

Short landscape Playback keeps the picture large: **Timeline** opens precision review tools, and **More** exposes frame steps, speeds and secondary actions. A camera's expand control opens an immersive selected-camera view without creating another player; exit restores the selected panes. Installed iPhone/iPad apps use this app-level view without relying on native element fullscreen. Desktop/TV also request browser fullscreen where supported. The same expand button or **Exit view** restores the normal layout in one action.

In Focus, replay and immersive review, a single tap/click on the picture toggles controls. Playing footage hides them after the configured interval; paused playback keeps them visible by default. Pinch, pan, double-tap zoom and editing gestures keep their own behavior. Mouse movement reveals controls; menus and keyboard focus hold them. A return control stays reachable while chrome is hidden. TV arrows/OK reveal controls before activating them.

Camera **More** opens a bounded menu for zoom, quality, snapshots, replay and picture adjustments. Channel-zero has one all-camera bookmark icon; TV viewer accounts see Live and Settings, while operator/admin accounts also see Playback and Events.

![Phone landscape Playback with a shallow transport and on-demand Timeline](docs/screenshots/phone-landscape-playback.jpg)

![iPad landscape review workspace](docs/screenshots/ipad-playback.jpg)

![Event review in the light theme](docs/screenshots/light-events.jpg)

Online updates use a network-first static shell (`adaptive-v13`), with unchanged install identity and routes. Completely close and relaunch the installed app online to refresh it; reinstalling is not required. Fullscreen controls switch enter/exit state; desktop Focus and Playback use their bottom toggles without a duplicate corner Exit chip, while touch devices and TV retain the corner exit. Live overview icons now start in the same state they use after a fullscreen return. iPad Events keeps search next to its title and before range controls. The [validation record](docs/adaptive-ui-validation.md) distinguishes local checks from pending native-device and recorder acceptance.

### Channel-zero: the recorder's own overview

If your recorder supports it, Settings → **Channel-zero overview** turns on a single stream showing the
recorder's own multi-camera layout — the same picture a monitor plugged straight into it would show, at
whatever resolution the recorder itself encodes it at (confirmed directly against a real 8-channel NVR:
704×576, distinct from any individual camera's own main or sub stream). Once it's on, an **Overview** button
appears in the live view's bar. One click switches straight to Channel-zero filling the whole screen by
itself (the button becomes **Camera grid** to switch back); it's never a tile mixed in among your real
cameras. It isn't a real recorded channel, so there's no instant replay for it, and bookmarking it
bookmarks every real camera at once instead — the closest honest equivalent to "this moment," since it has
no timeline of its own to find a bookmark on later.

### TV mode

Settings → Display & layout → **TV mode** turns a browser into a screen you leave the cameras on — built and
tested against a Samsung TV's Tizen browser, and meant to work on any TV browser, remote or keyboard:

- **It starts on the Overview** (Channel-zero, when the recorder has it): one light stream, full screen,
  with a small clock. After five idle minutes on the camera grid it goes back there on its own, and it keeps
  the screen awake.
- **Dark by default**, so the picture is the brightest thing in the room; Light and Auto are a tap away
  (TV appearance, this TV only).
- **Made for a remote:** big buttons in the header (Overview / Camera grid, layout, full screen, settings)
  and page arrows on screen, so a TV browser's pointer remote works as well as a D-pad. Arrow keys move
  between controls and cameras, OK opens one, Back goes back, and the remote's play/pause key switches
  between the Overview and the grid. The header slides away while you watch and comes back on any key or
  pointer movement.
- **Light on the TV:** SD by default (HD is one switch away) and a 1×1 grid unless you pick another layout
  on the TV itself — most TV browsers are far less capable than a phone or laptop.

It's a per-browser setting: turning it on for the TV changes nothing on your phone or laptop.

![TV browser profile showing a decoded synthetic test stream; physical TV acceptance remains separate](docs/screenshots/tv-mode.jpg)

Results on an actual TV browser vary with its hardware and how current the browser is — treat any given
smart TV as something to test, not a guaranteed target.

With [sign-in](#sign-in-optional) on, a TV-mode browser opens on a pairing code instead of a password form:
approve it from your phone and the TV stays signed in on its own.

## Testing

```sh
tools/test_rig.sh start                              # isolated instance against a fake unencrypted camera
node tools/test_viewer.mjs                         # real viewer and gesture logic, deterministic input
node tools/test_shell_update.mjs                    # shell imports, cache/update and install identity
node tools/test_pwa_bootstrap.mjs                   # installed Apple detection
.venv/bin/python tools/pwa_preview.py               # synthetic UI; no recorder or production writes
```

`tools/e2e_live.py` and `tools/e2e_real_settings.py` check against your real recorder without changing
anything on it. Sign-in has its own suites, no recorder needed:

```sh
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python3 tools/test_auth_core.py    # accounts, 2FA, sessions, pairing, trusted networks, CLI
.venv/bin/python3 tools/test_auth_http.py    # every route and WebSocket per role, login flows
```

With the AI enhancer installed, two benches measure Read text on synthetic text (no real footage):
`tools/bench_ocr.py` on 72 printed plates and signs (angle, size, blur, polarity, JPEG) — about 94% read
exactly from an operator's box, against 17% for the whole picture — and `tools/bench_plates.py` on licence
plates seen side-on through the whole enhancer pipeline, where the plate reader reads most of them exactly
and Tesseract almost none. `tools/bench_enhance.py` compares every upscaler and face model (plates, stock
scenes, a face, timing) — the measurements behind the pairings in Settings — and
`tools/test_enhance_models.py` checks the model catalog, verified downloads and fallbacks without needing a
GPU or the weights.

## Project status

Live viewing, multi-camera DVR/NVR playback with frame-locked timing, event search, signed-package export,
the real-time enhancement filters, and the local AI frame enhancer are all built and in day-to-day use, along
with a Docker deployment for Linux hosts (with GPU transcoding when available) and optional sign-in. The
detailed specification and its build status live in `docs/SPEC.md` — including the parts
deliberately not built (a native-DVR/NVR-file export option, and a standalone offline player), and one open
investigation into a rare timing edge case on footage recorded many hours before the most recent per-channel
clock calibration.

## Contributing

This started as a tool built for my own needs — my own Hikvision NVR, on my own Mac — so there's a lot of
surface it's never had a reason to cover. Contributions are welcome, especially in the areas that setup
above already admits are untested or missing:

- **Other DVR/NVR/camera brands.** Everything here assumes Hikvision's RTSP path conventions and ISAPI, and
  the encryption support (`tools/NOTES.md`) is specific to Hikvision's own scheme. A Dahua, Reolink,
  ONVIF-generic, or other vendor's equivalent would be a real, separate effort — genuinely useful, and not
  something this project currently attempts.
- **Windows and native Linux support.** Linux runs in Docker today, and `./run.sh --native` knows how to set
  up on Linux, but a native Linux install hasn't been verified yet, and Windows hasn't been attempted.
- **Features.** `docs/SPEC.md` documents what's built, what was deliberately left out, and why — a good
  starting point for seeing what's already been considered and what's genuinely open.

If you're picking up one of the bigger items (a new DVR/NVR brand, a new OS), consider opening an issue first to
compare notes before sinking a lot of time in — this project's own conventions (no build step for the
frontend, the settings/RTSP path assumptions baked into `app/hikrelay.py` and `app/go2rtc.py`) are worth
knowing going in.

## License

[MIT](LICENSE)
