# iPhone and iPad PWA header audit and proposed fix

Status: approved by the user and implemented locally on `fix/ios-status-bar`. Synthetic layout validation passes; native iOS/iPadOS 27 acceptance and deployment remain pending.

Audited on 2026-10-04 at commit `2206272`, branch `fix/ios-status-bar`, matching the local `origin/fix/ios-status-bar` tracking reference. The user reports iOS 27 and iPadOS 27: the defect appears in the installed PWA; regular Safari works correctly. Freshness of the installed assets remains unverified.

## Intended result

Every screen in the installed iPhone/iPad app should have the same solid top navigation surface, with a matching status area, sharp titles and controls, and consistent safe-area handling. Proposed colors are the existing app background tokens: dark `#09090b`, light `#f2f2f5`. Title sizes and page-specific controls can retain their current layouts.

The PWA-specific geometry and blur workaround must not activate in regular Safari. This plan scopes uniform opaque navigation styling to the installed Apple mobile app as well. It does not redesign desktop or TV navigation.

## Confirmed findings

| Surface | Current implementation | Consequence |
| --- | --- | --- |
| Live, wider layouts | `.topbar` uses translucent `--glass-fill` and `blur(26px)` | Gray appearance depends on the background |
| Live, at or below 640 px | `.topbar.live` overrides the above with solid `--bg`, no blur | Live itself changes material across widths |
| Playback | Ordinary translucent `.topbar`, including its wrapped phone layout | Different from Settings and Events |
| Events, Settings, standalone Account | `.topbar.big` uses solid `--bg` | Near-black in dark mode instead of gray |
| AI Frame Enhancer | Handwritten `.topbar.appbar.enh2-bar` inside fixed `.enh2` | Different mounting/layout path from route headers; separate width overrides |
| Export clip | Shared `barHTML()` inside fixed `.xp` | Must be covered independently of routes |
| Focus and instant replay | Separate absolute `.focus-bar` over black/video surfaces | Translucency and fixed white text need explicit treatment |
| Sign-in and pairing | Separate HTML entry points with `#statusbar`, no `main.js` color sampling | Initial appearance and detection cannot depend solely on the app router |

Source locations: `web/css/app.css` (base bars around 157, Focus around 550, enhancer around 830/957, safe-area strip around 1362, phone around 1831, tablet around 1889); `web/js/bar.js`; `web/js/main.js`; `web/js/enhancePopup.js`; `web/js/playback.js`; `web/index.html`, `web/login.html`, `web/pair.html`.

Read-only browser inspection of the running local app confirmed these computed styles at 390×844 and 820×1180: phone Live and Events/Settings are `rgb(9, 9, 11)` with no backdrop blur; Playback and tablet Live are `rgba(28, 28, 31, .66)` with 26 px blur. Desktop Chrome's top safe inset was zero. This verifies the styling discrepancy, not iOS 27's system compositor behavior. Enhancer, export, auth and fullscreen findings above are source audits, not device test results.

The enhancer's reported black status band is not established as a successful blur fix: its fixed full-screen dark surface differs from the normal in-flow headers. Whether iOS samples that surface, an older cached shell, or another system layer must be measured on the devices.

## Why the current branch is insufficient

1. `#statusbar` is only `env(safe-area-inset-top)` high. It does not protect title/control pixels if the system effect extends below that boundary, or if WebKit reports a zero inset while reserving system space.
2. `syncStatusColor()` samples one point beneath that strip and composites ancestor background colors. That deliberately preserves each screen's different material. It cannot reconstruct actual video/backdrop-filter pixels, sibling surfaces, gradients, or WebKit's native layer.
3. The sampling observer watches child additions/removals, not every class/style/opacity change. The delayed route/startup sampling can also leave a transient previous color.
4. The enormous strip z-index only orders DOM layers; it cannot force the page above native status-bar effects. It also leaves a separate status surface to coordinate with dialogs and fullscreen top-layer elements.
5. The comment in `index.html` still recommends opaque `black`, while the actual meta value is `black-translucent`. Claims that either value universally eliminates blur are not supported by this audit.
6. `sw.js` remains shell cache v9. It is network-first with a 2.5-second cache fallback, and static responses use `Cache-Control: no-cache`, so caching is not proven to cause the issue. Nevertheless, slow/offline launches can serve an old shell, and the device asset version has not been checked.
7. The commit records Chrome safe-area emulation and 43 UI checks. The checked-in UI suite does not contain explicit status-bar/safe-area assertions, and Chrome cannot verify native iOS PWA blur. Those checks are not a release gate for this defect.

## Research and limits

[Apple's archived status-bar metadata reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html) describes different content geometry for `black`/`default` versus `black-translucent`; it is historical documentation, not proof of iOS 27 behavior. [WebKit's safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/) supports retaining `viewport-fit=cover` with inset-aware content placement.

[WebKit issue 301994](https://bugs.webkit.org/show_bug.cgi?id=301994) documents installed-app status-area regressions and includes a maintainer confirmation/reopening on iOS 27 beta. This supports testing native geometry independently of CSS emulation; it does not identify Sentinel Eye's exact cause.

[MeshMonitor PR 5309](https://github.com/Yeraze/meshmonitor/pull/5309) reports an on-device PWA blur extending about 20 px below the top inset and a spacing workaround. [Its follow-up 5319](https://github.com/Yeraze/meshmonitor/pull/5319) records installed-app failure and suspected missing version tokens; [follow-up 5328](https://github.com/Yeraze/meshmonitor/pull/5328) points to fixed versus in-flow header positioning, while explicitly leaving native blur confirmation outstanding. These are first-party implementation reports from another app, not a guaranteed fix for Sentinel Eye or evidence about the user's iPad. The plan therefore tests both positioning and clearance, and does not promise that CSS can disable Apple's native blur.

## Implementation sequence after approval

### 1. Establish the device baseline and compare the two layouts

- Use an isolated test instance and a small temporary diagnostic page with synthetic content, not real camera footage. Record the served commit/asset identifier on the installed client, computed safe insets, standalone signals, viewport dimensions and header/control bounds. Do not collect credentials, camera names or footage in diagnostics.
- Compare the current layout against an opaque viewport-anchored header with the same geometry, then with an additional 20 px of top clearance. Check on both actual devices in portrait and landscape. The 20 px is a starting experiment, not a universal device constant.
- Keep metadata constant during the layout comparison. Only compare `default`/`black`/`black-translucent` separately if necessary, recording any change in usable viewport geometry. Prefer keeping the existing edge-to-edge contract if it works; do not select a permanent black system bar merely to hide the problem.
- Choose the smallest clearance that keeps all header content sharp. If WebKit continues drawing a native effect, leave only a uniform solid background under it and keep interactive content below it. Report any residual native seam explicitly.

### 2. Introduce a shared PWA appearance and spacing contract

- Add small shared initialization before first paint in all three HTML entry points. Treat `navigator.standalone === true` as an important installed-iOS signal; do not depend solely on `(display-mode: standalone)` or Safari version tokens. Capture the actual device signals before deciding whether a version gate is needed.
- Introduce tokens for opaque navigation background, top safe inset, optional measured blur clearance, and total header content inset. Default additional clearance to zero outside the affected installed app; derive geometry from actual insets, not hardcoded iPhone/iPad status heights.
- Apply the same opaque background to normal, large-title and custom headers, and the status-area background. Remove backdrop filtering from these PWA top surfaces. Ensure explicit light/dark/auto theme behavior, including foreground contrast in Focus/replay where text is currently fixed white.
- Replace point sampling as the source of PWA colors with explicit shared tokens and explicit overlay state. Simplify/remove the old parser/observer where redundant. Keep `theme-color` in sync for platforms that use it, without depending on it to control iOS 27 blur.

### 3. Make the top boundary stable on every surface

- If the device comparison validates fixed anchoring, anchor the complete visible PWA header to the viewport, rather than fixing only the safe-area strip. Reserve its actual height in the owning screen so content cannot slide underneath or jump.
- Handle wrapped phone/tablet bars using measured height (for example, `ResizeObserver`) rather than assuming 60 px. Support rotation, Split View and Stage Manager widths. Reuse a small header binding in `bar.js` and the custom enhancer/Focus/replay paths; disconnect observers on teardown.
- Apply the inset exactly once. Consolidate competing normal, large-title, phone, 641–900 px and fullscreen calculations; preserve the useful spacing corrections already made on this branch.
- Inspect ancestors with animations/transforms, backdrop filters and overflow because they can change fixed positioning or clip headers. In particular, enhancer/export entrance animation must not move the protected top surface into the system blur; adjust animation ownership if needed.
- Use deliberate layering for route headers, full-screen overlays, scrims, menus and notifications. A full-screen overlay must replace the underlying header; a small dialog should dim the matching status/navigation surface consistently.
- Treat Fullscreen API views separately. An outside sibling `#statusbar` cannot cover the fullscreen top layer; fullscreened roots must own any required top treatment. Preserve video auto-hide and ensure no permanent stale strip when system chrome is absent.

### 4. Cover the complete screen inventory

| Group | Required checks |
| --- | --- |
| Main routes | Live grid, channel-zero overview, Playback with/without cameras, Events/search alias, all Settings sections, Account |
| Full-screen app overlays | Camera Focus, instant replay, enhancer pick/crop/result/loading/error, Export clip |
| Smaller overlays | Event preview, bookmark/confirmation/2FA dialogs, filter drawer, account/notification/enhancement menus, toast and notification banners |
| Separate entry and fallback states | Sign-in, sign-in 2FA/recovery states, pairing/waiting/success/error, initial loading, server-unreachable state |
| Native fullscreen | Entry/exit for Live, Focus, Playback and enhancer where supported; transitions back to the app |

The exported evidence-package `app/export_assets/verify.html` is not an app navigation route. Check separately only if opened inside the installed app's scope; do not restyle an exported standalone document without need.

### 5. Ensure the installed client receives the fix

- Bump the shell cache version with the final frontend release. Keep API/video caching exclusions and network-first behavior.
- Verify the installed device loads the new HTML, CSS and JS together, including online cold start, resume and slow-network/offline fallback. A cache bump alone does not refresh a page already running.
- Record a controlled close/relaunch and, if necessary, a separate fresh Home Screen installation comparison. Do not ask the user to clear all Safari data or remove the existing install as the first troubleshooting step.
- Align manifest/meta launch color defaults with the chosen PWA surface. Fix contradictory comments and document the measured iOS behavior.

## Validation and completion criteria

Automated regression checks should assert resulting geometry and appearance: shared opaque background, no PWA header backdrop filter, controls below the protected boundary, content starting at the header bottom, no duplicate safe-area padding, and correct overlay ownership. Include detection cases for an installed iPhone, installed iPad desktop-style UA, missing version token, ordinary Safari and non-Apple browsers. Run the existing UI suite only against its isolated scratch rig because it edits settings.

Manual acceptance is required on the user's iPhone/iOS 27 and iPad/iPadOS 27, in installed mode, across the inventory above. Cover portrait/landscape; iPad full screen and supported windowed modes; dark/light/auto; page scroll; keyboard open/close; route/overlay transitions; cold launch and background/resume. Recheck ordinary Safari on both devices and desktop/TV for regressions.

Done means sharp titles/buttons on both installed devices, a matching status/header surface across all screens, no accidental black/gray transition, no overlaps or excessive blank space, and confirmed current assets. Screenshots should focus on chrome or synthetic footage. Any system-owned separator/blur that remains outside page control must be reported rather than described as removed. Emulator results alone cannot establish completion.

Expected edits: `web/css/app.css`, `web/js/main.js`, `web/js/bar.js`, the three HTML entry points, a small shared PWA initializer/header helper as needed, custom overlay bindings in `live.js`, `enhancePopup.js` and `playback.js`, `web/sw.js`, `web/manifest.json` if defaults need alignment, targeted UI checks, and relevant install documentation. No backend business logic changes are expected.

## Implemented change

- `web/js/pwa.js` initializes all three HTML entry points before paint. Installed Apple devices receive the shared opaque surface, viewport-anchored headers and measured content spacers. Removed headers are unobserved and their spacers removed. Focus/replay keep their floating video layout and idle hiding.
- `web/css/app.css` uses a shared top inset and background across route and overlay headers, notifications, menus/dialog positioning and auth pages. Dark uses `#09090b`; light uses `#f2f2f5`. Regular browser tabs keep their original layout and materials. Transformed enhancer/export entrance animations are disabled in the installed app so headers remain anchored.
- The initial clearance is **20 px when the top safe inset is positive**; zero-inset layouts add no clearance. Fixed anchoring and this value are implemented provisionally, based on the research and synthetic checks. They have not been selected through a native device comparison. A zero reported inset with a native reserved/status effect is still an explicit device check.
- Replaced background sampling with shared theme tokens. The status fallback now sits below scrims, so dialogs dim it naturally. Fullscreen roots own their header surface; the outside fallback strip and content spacers are hidden in Fullscreen API mode.
- The shell cache is v10. HTML metadata, CSS and the initializer expose `ios-headers-v10` for consistency checks. The new initializer is on the anonymous static-resource allow-list so sign-in and pairing work with authentication enabled.

## Executed validation

- All **8** installed-device detection cases passed (`node tools/test_pwa_bootstrap.mjs`), including missing Safari version tokens, iPad desktop-style user agents, ordinary tabs and non-Apple installed apps.
- All **89** HTTP authentication checks passed (`.venv/bin/python tools/test_auth_http.py`), including anonymous access to the new initializer.
- Browser assertions against the actual UI with synthetic settings/footage passed for Live, Playback, Events and Settings at 390×844/top 59, 820×1180/top 24, 1180×820/top 24, 600×900/top 24 and 844×390/top 0. These check matching opaque background, no CSS backdrop filter, viewport anchoring, protected title/control bounds and exact measured spacer height.
- Checked all eight admin Settings sections including Account, standalone Your account, Focus, instant replay, enhancer pick/crop/result/loading/service-error, light-theme enhancer, Export clip, a tall date menu, dialog layering, toast position, sign-in and pairing forms. Overlay teardown left one route header and one spacer. The Settings content boundary matched the header bottom.
- Ordinary browser-mode Playback retained relative positioning, its glass material, the original safe inset and no added spacer/status strip. Syntax checks and `git diff --check` passed.
- Fullscreen requests were blocked by the local test browser; **fullscreen entry/exit was not validated**. The existing recorder/video UI suite was not rerun: the preview intentionally has no recorder or video source, and these targeted browser checks used the supported browser control interface. No production settings or camera footage were used.

## Native acceptance and asset refresh

After serving this branch's changes, completely close the installed app and launch it online. A running page can retain old modules despite service-worker activation. First verify the shell; do not start by deleting the installation or clearing all Safari data.

Using Safari's remote Web Inspector for the installed client, evaluate `SentinelPWA.diagnostics()`. `revision`, `htmlRevision` and `cssRevision` should all be `ios-headers-v10`, `installed` should be true, and visible headers should have matching opaque colors with no CSS backdrop filter. The helper reports only geometry/theme/version information, with no recorder, account or footage data. A version mismatch is a stale/mixed-shell problem to resolve before judging the layout.

The native test inventory and completion criteria above remain required. Especially compare normal routes with the enhancer, check iPad windowed modes/zero safe inset, and check keyboard, rotation, fullscreen return, resume, dark/light/auto, and slow/offline launch. Native status-symbol color and any system-owned seam/blur require visual verification; matching CSS cannot prove them correct.

For a separate synthetic device comparison, run `.venv/bin/python tools/pwa_preview.py --host 0.0.0.0` and open the Mac's LAN address on port 8082. This preview starts no recorder and refuses jobs/settings writes. On actual devices **omit `pwa` and `top` parameters** so native standalone detection and safe insets remain real. Compare default clearance with `?gap=0` and, if needed, another measured value (0–40 px). Desktop emulation uses `?pwa=1&top=59` or `?pwa=1&top=24`; it tests layout only. The preview deliberately does not install a service worker, so cache/update acceptance must use the actual served app.
