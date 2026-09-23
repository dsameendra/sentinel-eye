# Product

## Platform

web

## Users
The sole operator/homeowner running Sentinel Eye on their own machine to watch and review their Hikvision recorder/cameras. Single-user in practice: no login exists, and the dashboard is meant to run on `127.0.0.1` or a trusted LAN rather than be exposed to multiple accounts or the public internet.

## Product Purpose
A self-hosted, full replacement for the Hikvision vendor app/cloud: live viewing, recording/playback, and (as it grows) local AI-driven analytics — motion/object events, plate and face recognition, frame enhancement — all running on hardware the user controls, with nothing sent to Hikvision's cloud. Success means the operator never needs the vendor's app, plugin, or cloud account to get full value from their own cameras.

## Positioning
A full self-hosted vendor-app replacement, not just a viewer. Decrypting Hikvision's proprietary "Stream Encryption" (reverse-engineered, see `tools/NOTES.md`) is the enabling first step, not the end goal — it's what lets the rest (live view, recording, local AI analytics) happen without the vendor's plugin, app, or cloud. A neighboring generic NVR viewer could show the streams (if unencrypted) but couldn't truthfully claim to replace the vendor's own analytics stack while keeping everything local and private.

## Operating Context
- Runs against a Hikvision DVR/NVR and its cameras over RTSP on the local network.
- Started via `run.sh` (FastAPI + go2rtc + hikrelay), stopped via `stop.sh`; no build step for the frontend.
- First run seeds `data/settings.json` from `.env`; after that, all configuration (recorder address/login, encryption toggle, channel list, display options) happens in the in-app Settings screen.
- Stage progression: Stage 1 was live viewing; Stage 2+ is adding recording, motion/object events, plate/face recognition, and AI frame enhancement — the product is actively growing toward the "full vendor-app replacement" positioning, not yet feature-complete against it.

## Capabilities and Constraints
- Self-hosted only; LAN/`127.0.0.1`-first. No login/auth exists — access control is "keep it off untrusted networks," not an in-app permission system.
- No cloud dependency, no Hikvision plugin, no vendor app required.
- Frontend is plain ES modules (`web/js/`) with no build step or framework; backend is FastAPI (`app/server.py`).
- Live view supports layouts 1×1 up to 4×4 plus 1+5/1+7/2+8, drag-to-reorder, SD/HD/Auto quality, zoom/pan (wheel, pinch, touch, drag), snapshot, full screen, keyboard shortcuts.
- HD streams transcode H.265→H.264 on the Mac for broad browser compatibility; "Play directly" is opt-in.
- Existing Stage 2+ surfaces already in the codebase: events (list/preview/export), playback/timeline, AI frame enhancement (`enhance_ai.py`, `web/js/enhance*.js`, see `docs/playback-spec.md` section 7.8).

## Evidence on Hand
No fabricated testimonials, customers, benchmarks, or pricing — this is a personal/hobby project run by its own developer, not a product with external customers yet. `docs/playback-spec.md` (the single unified spec, covering playback/review and the AI frame enhancer) and `tools/NOTES.md` (reverse-engineered encryption scheme) are real, current documentation and should be treated as authoritative product detail where relevant.

## Product Principles
1. Everything runs locally — no cloud account, no vendor app, no plugin, ever required.
2. The vendor's own app/cloud is the bar to replace, not just match on live viewing.
3. Single trusted operator, not a multi-tenant product — don't design for logins, roles, or public exposure.
4. No frontend build step — the web UI stays plain ES modules; don't assume a bundler/framework is available.
5. New surfaces (events, playback, enhancement) extend the same self-hosted, privacy-first stack, not bolt-on cloud services.
