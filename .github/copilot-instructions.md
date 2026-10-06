<!--
  Read by GitHub Copilot Chat, code review and the cloud agent. Copilot code review and github.com Chat do
  NOT read AGENTS.md, so the review-critical rules are summarised below. AGENTS.md is the source of truth:
  keep this file short and in sync with it.
-->
# Copilot instructions: Sentinel Eye

Full project guidelines are in [AGENTS.md](../AGENTS.md). Follow them. Summary:

- **Stack:**
  - Python 3 + FastAPI backend in `app/`, run as `uvicorn --app-dir app server:app`, so modules import
    flatly (`import auth`, not `app.auth`).
  - go2rtc for streaming.
  - Plain ES modules in `web/`, with **no build step, framework, TypeScript or npm packages**.
- **Local-only:** no calls off the LAN (no telemetry, CDNs, cloud APIs or remote fonts), except the pinned,
  checksum-verified model downloads.
- **Auth:**
  - Every new `/api/` route needs a deliberate role in `ROUTE_ROLES` (`app/auth_api.py`), since unmatched
    routes fail closed to admin.
  - Every new WebSocket route must call `_ws_admit()` and be added to `tools/test_ws_routes.py`.
  - Non-admins must never receive recorder credentials.
- **Secrets and data:** never commit or log `.env`, `data/`, `*.db`, `*.pem`, the DVR password or
  verification code, or any footage. Screenshots and fixtures use synthetic footage only.
- **AI enhancer:** output always keeps the ENHANCED label and the original frame. Exports are stream copy
  with a signed manifest.
- **PWA shell:** cached shell changes bump the revision in `web/sw.js` (`CACHE_NAME`), `web/css/app.css`
  (`--shell-revision`) and `tools/test_shell_update.mjs`, all together.
- **Tests:** standalone scripts in `tools/` (not pytest). CI runs `py_compile` on `app/` and `tools/`,
  `node --check` on `web/**/*.js`, and `tools/test_ws_routes.py`. Never run the `tools/e2e_*` scripts or
  `tools/test_m0.py` against the real recorder unprompted.
- **Docs:** behaviour or setup changes should update `README.md` and/or `docs/SPEC.md`. UI follows
  `docs/DESIGN.md`.
- **Duplicates:** Finder/iCloud duplicate files (`* 2.*`) are git-ignored; never commit them.
