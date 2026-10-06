# Adaptive UI validation — adaptive-v33

## Follow-up navigation and Playback chrome — adaptive-v33

Installed Apple PWA headers now stay fixed while their measured spacer reserves the same height in the page flow. The Apple-touch layout had reset those headers to in-flow positioning, causing the header height to be counted a second time and pushing every page body down. The preview now emulates Apple touch detection, and the browser route matrix checks the gap between each header and its page content.

The shared destination switcher and notification/account controls now stay at fixed coordinates for each viewport on iPhone landscape and both iPad orientations. They no longer inherit the per-page grid placement that moved Playback and Events to a different row. Live’s fullscreen action reserves space before that cluster; Events moves its filters to a second line at narrow widths; short landscape Playback keeps speed/export on its lower row. iPhone portrait keeps its existing labeled bottom dock.

Desktop Playback fullscreen now uses a full-width bottom chrome panel with the same opaque surface and edge treatment as the top bar. Touch-device and TV fullscreen styles remain separately scoped.

The landscape-device follow-up includes iPhone-sized 932×430 as well as iPad landscape. Playback's two control rows keep a 10px separation in short landscape while the header's outer vertical padding is reduced, so the toolbar stays legible without pushing the stage farther down. In installed-PWA fullscreen, the selected Playback pane no longer reserves the status-bar and home-indicator insets inside the media rectangle; the video can use the full pane while the controls retain their own safe-area placement. A synthetic iPhone-landscape fullscreen measurement showed a 932×430 stage and a centered 750×422 16:9 picture, with no page overflow. The Apple-touch-aware 442-case light/dark route sweep across 17 device profiles reported no clipped header controls or preview errors; all 286 PWA page checks measured a zero-pixel gap from header to content. Native iPhone/iPad rendering and live camera footage still need device confirmation.

The iPad landscape Live Overview caption now sits 16px lower in installed-PWA fullscreen, giving the Overview and Channel zero labels more room from the top edge. The rule is limited to landscape Apple PWA viewports at least 1000 CSS pixels wide, so iPhone landscape, non-fullscreen Live, TV and desktop placement remain unchanged.

Event preview now anchors its canvas to the full stage bounds and uses `object-fit: contain`, keeping the decoded picture centered even when camera-frame dimensions differ from the stage. This removes the intrinsic-canvas left alignment seen in iPad landscape while preserving the full frame on narrower devices.

The signed-in Account page's top-bar Sign out action now sits before the fixed navigation/avatar cluster on iPhone landscape and both iPad orientations. A signed-in route audit found no corresponding action overlap on Live, Playback, Events or Settings; desktop positioning is unchanged.

Local verification included 80 light/dark combinations across Live, Playback, Events, Settings and Account for eight phone/tablet profiles. Shared controls had identical coordinates across routes within each profile, with no interactive-control overlap or horizontal page overflow. A desktop fullscreen browser measurement confirmed the Playback panel spans the viewport bottom edge. `node tools/test_shell_update.mjs` checks cache revision rollover and fullscreen/header style contracts; `node tools/test_viewer.mjs` passed 60 behavior checks; `node tools/test_pwa_bootstrap.mjs` passed eight platform-detection cases. Native iPhone/iPad compositor and real-recorder acceptance still require on-device checks.

Implementation and local validation continued on 2026-10-06 on `fix/ios-status-bar`. The user previously confirmed that the installed iPhone/iPad top blur is gone; that accepted header treatment is preserved. Native iOS/iPadOS 27, physical TV, connected-recorder and Docker runtime acceptance remains pending. Browser dimensions and injected PWA signals cannot establish native compositor, keyboard or hardware-decoder behavior.

## Follow-up device-layout audit — adaptive-v26

The latest pass confirms that compact Live keeps its grid-layout choice in the top toolbar; the phone version uses a 44px icon target with an explicit accessible name so it can sit beside the Overview toggle without pushing the title or account actions. At 390×844 the header has no horizontal overflow. At 820×1180, the iPad portrait Live heading has equal rendered and scroll widths (34px), so “Live” is not clipped.

At 390×844, selecting four Playback cameras produces a 2×2 pane grid (two 171px columns, two 103px rows) rather than a vertical strip. Pane names fit within their label bounds and ellipsize when needed; the selected-camera chips remain horizontally scrollable and each keeps the complete name in its title. Camera inspect buttons now change to the collapse icon and “Show all selected cameras” label when that pane is expanded. The fullscreen Exit corner control stays suppressed in Focus and Playback where the lower transport or selected-pane control already provides the return action. Touch auto-hide has an 8-second floor; open menus, keyboard focus, and edit/selection modes continue to hold controls visible. Touch Playback may auto-hide while paused, with tap-to-reveal; desktop pause behavior remains unchanged.

The final landscape Playback pass at 844×390 and 667×375 keeps all four selected-camera chips plus the camera picker fully visible before the speed/export group, with no overlap or horizontal page overflow. At 667×375 the date is a compact, tappable calendar label and the previous/next arrow pair collapses; all playback speeds remain in its speed menu, and Export remains on the same control row. The four panes stay in a 2×2 grid. TV Focus and Playback now suppress the redundant top-corner Exit chip and retain one dynamic Full screen/Exit full screen control in the lower bar. A shell regression check guards that rule.

The v24 phone follow-up fixes two regressions found after that pass. On a 390×844 portrait fixture, Live Overview's wall, tile and stage all fill the 602px below the 148px app header; previously the mobile scrolling-wall rule let the aspect-ratio-free single tile collapse. The preview has no real camera source, so its video surface is expected to show a connecting/black state; the geometry check confirms it has a nonzero 390×219 video box. In compact Playback fullscreen, the bottom transport now restores its fullscreen toggle even though compact normal mode hides it. A phone-profile browser check entered immersive playback, found a visible lower-bar button labeled “Exit full screen” below the header, and exited with the same control. Short mobile landscape moved the navigation destinations into the header.

The v25 follow-up makes navigation icon-only across Apple touch layouts: iPhone keeps its bottom destination dock; iPad uses 44px icon links in the top bar. Each link retains an accessible name. Playback fullscreen now gives iPhone and iPad the same opaque, edge-to-edge bottom transport panel as the app header; both panels fade after the configured idle time, with an 8-second minimum on touch devices, and a tap on the video wakes them. Synthetic 390×844 iPhone and 820×1180 iPad runs confirmed hidden top and bottom chrome after 8.25 seconds, successful tap wake, one-action exit, no horizontal overflow, and zero-corner-radius dock placement. The Settings Connection channel selector now draws a centered muted arrow in its own 40px field instead of relying on browser-native arrow placement. A 78-case route/theme sweep across iPhone portrait, iPad portrait and desktop reported no page/header overflow or preview errors. The preview validates layout and pointer behavior only; actual iOS/iPadOS rendering, live streams and status/home-indicator composition still require device acceptance.

The v26 navigation refinement restores visible destination names in the iPhone portrait bottom pill; the 64px dock still fits 22px icons, 11px labels and 44px targets. Short landscape stays icon-only. On iPad, Playback and Events now use the same natural-width top-bar mode switch: four 44px icon targets in a 186×48px container, followed by notification and account actions. Browser measurements confirm identical switcher dimensions on both pages and zero horizontal overflow at iPhone portrait/landscape and iPad portrait/landscape widths. The final 156-case route/theme sweep across six phone, tablet, desktop and TV profiles reported no clipping or preview errors.

The iPad landscape event-preview dialog uses balanced safe-area padding to center the entire dialog and its video stage. PWA route changes now replace the view synchronously; the outgoing-page fade was removed because it exposed the black shell between views and overlapping transitions could abort during rapid navigation. The landscape route sweep now passes without transition errors. Actual installed iOS rendering and decoded event-video centering still need confirmation on the user's iPhone and iPad.

## Fixes verified locally

| Reported problem | Final behavior and evidence |
| --- | --- |
| Blank login card | An existing server returned 302-to-login for newly imported helper paths while returning 200 JavaScript for `ui.js`. Shared public code now lives in the already-public `ui.js`, and shared styles live in `app.css`. Login no longer depends on a backend allow-list change/restart. The real anonymous import graph passes HTTP checks; signed-out forms render across the matrix. The existing running server also loads the updated authenticated app. |
| Floating phone navigation too high | Installed shells anchor navigation to the full app height and bound the reported bottom inset. An injected 86px raw inset produces a 22px portrait / 12px landscape capsule gap. Browser tabs retain their dynamic browser inset. Actual device geometry remains an acceptance item. |
| Desktop navigation misplaced / header heights inconsistent | Page controls precede destinations; destinations sit immediately left of Notifications and Account. Main desktop headers measure 60px at 1440px across Live, Playback, Events and Settings. Tablet context wraps separately; compact/TV profiles have their own measured heights. |
| Fullscreen controls duplicated / Live overview icon changed after first use | Focus and Playback keep one stateful lower-bar fullscreen toggle and suppress the redundant top-corner Exit chip on desktop, touch and TV. Live grid/Overview uses one input-appropriate Exit control; TV Live keeps its title-bar toggle. Live overview, Focus and Playback normalize icon, label and pressed state on bind, enter and exit. Browser interaction checks cover one-action return. |
| iPad Events search separated from its context | Tablet Events places Back, title and Search first; time-range controls follow, then destinations, Notifications and Account. At iPad portrait widths the range remains available in the Filters sheet; at iPad landscape widths the range chips fit inline. Both profiles measure zero horizontal overflow. |
| Landscape Playback crowded | In the installed-app fixture at 844×390, the final stage is 161px high; at 667×375 it is 146px. Both keep four selected cameras in a 2×2 grid, with all four labeled camera chips and the picker fitting before the speed/export controls. The tappable date label remains available, and all eight speeds and existing review actions remain reachable. |
| Phone portrait Live Overview collapsed | The 390×844 compact single-camera wall now flexes into the available content height and clips its own stage instead of collapsing to zero height. Geometry was checked in the PWA fixture; a real feed still needs on-device confirmation. |
| Phone Playback fullscreen had no reachable exit | Compact immersive Playback shows the stateful expand/collapse action in the bottom transport. iPhone and iPad synthetic touch runs entered and exited with that same action, and confirmed that both top and bottom chrome hide after idle and return on a video tap. |
| iPhone/iPad navigation labels crowded compact chrome | iPhone portrait uses the bottom dock with icons and titles; phone landscape remains icon-only. iPad uses the top-bar destination group with 44px icon targets. All links retain accessible names and selected state. |
| Touch Playback fullscreen bars looked like separate floating controls | On iPhone and iPad, the lower transport docks edge-to-edge with the opaque app header and includes the safe-area inset. Desktop/TV layout is unchanged. |
| Settings Connection test selector arrow misaligned | The channel selector now uses a centered, theme-aware CSS chevron rather than variable native select decoration; the wrapper and field align at 40px. |
| Expand buttons unsupported in installed Apple apps | The shared controller enters app immersion without requesting native element fullscreen on installed Apple devices. Supported desktop/TV browsers additionally request native fullscreen; denial retains app immersion. |
| Fullscreen exit leaves floating controls / no escape route | Same-button exit, explicit return, and native fullscreen exit restore normal composition. Playback inspection resets without replacing selected player panes. A persistent return remains reachable when chrome hides. A late native-entry promise cannot reopen a view after exit. |
| Giant empty wall capsule | The pager uses intrinsic width/height and explicit positioning; it disappears when there is only one page. Exit has its own compact control. TV immersion uses one pager presentation. |
| Exit/camera actions overlap | Actions in the exit corner receive measured clearance; compact portrait grid content clears the safe top/exit area. Normal TV overview actions and captions clear the measured header. The camera-menu sweep caught and corrected a click hitting Account instead of the intended camera action. |
| Camera quick tools clipped in small tiles | More opens a bounded, scrollable menu. Zoom, quality, snapshot, replay and picture adjustments stay reachable. Unavailable snapshots are disabled until a frame exists. Old inline source controls are hidden and inert. Auto-rotation holds while a menu/dialog is open. |
| Channel-zero duplicate bookmark | One top-right all-camera bookmark remains, including on touch/TV. Its meaningless duplicate expand action is removed. Viewer accounts do not receive the bookmark action. |
| TV permissions and entry | Viewer TV destinations are Live/Settings; operator/admin also receive Playback/Events. Entry expands the camera grid when channel-zero is unavailable and describes that behavior accurately. |
| Settings disconnected from the visual language | Compact Settings uses grouped 52px section rows, inset dividers and a separate Account row. Forms, cards, save controls and headers use shared theme materials. Drafts survive rotation and route discard protection remains active. |
| Authentication heading jumps out of view | Short forms scroll from a reachable top; initial touch login does not open the keyboard automatically. Two-factor/recovery transitions reset their scroll and focus without scrolling the heading away. |

The installed bottom-inset correction is informed by WebKit's report of standalone safe-area values including absent browser chrome: [WebKit bug 301172](https://bugs.webkit.org/show_bug.cgi?id=301172#c8). Its applicability to the user's iOS 27 device is an inference, not a measured native root cause. The bounded inset and shell anchoring passed synthetic geometry checks; verify the physical home-indicator clearance on both devices.

## Executed checks

### Fullscreen follow-up — adaptive-v12

The follow-up uses the same isolated PWA preview with synthetic safe-area values, not a native iPhone/iPad compositor or a connected recorder. In portrait at 390×844, the measured usable-area video center is 444.5px (45px below the physical viewport center, matching the injected 79px top and 34px bottom content insets). The single-camera Exit control sits below the measured 144px header; after idle it has zero opacity and no pointer events. At 844×390, the camera remains centered at y=195, the Playback Exit control begins below its 128px toolbar, and the transport remains clear at the bottom. Desktop 1440×900 verifies Live grid and Playback fullscreen labels/icons change to collapse/“Exit full screen” on entry and return to expand/“Full screen” on exit. Pointer movement reveals controls, and both Live Focus and Playback Exit actions leave their current route intact.

`tools/test_viewer.mjs` covers independent Exit auto-hide, keyboard wake, immediate touch wake, and paused Playback auto-hide on touch devices. Physical iPhone/iPad orientation, native fullscreen APIs, actual touch/tap timing and connected-recorder behavior remain release acceptance items.

### Desktop and tablet refinement — adaptive-v13 (previous)

The current follow-up hides the extra upper-corner Exit chip only for desktop-pointer Focus and Playback; their bottom-bar toggles remain present and return to the same route with the enter icon restored. Browser interaction checks entered and exited both views, verified the chip stayed hidden, and checked the Live grid control's icon, label and pressed state before entry, while expanded, and after return. A 768×1024 installed-app preview retained the corner Exit control in Focus and returned with one bottom-button action. TV navigation still exposes Live/Settings to viewer accounts and all four destinations to operators.

The Events toolbar was measured at iPad portrait 768×1024 and landscape 1024×768 / 1180×820. Portrait keeps Back, Events and Search on the first row, then Filters/navigation/Notifications/Account; the range is selectable in the Filters sheet. Both landscape widths keep Back, Events, Search, Today/24h/7d/Custom, destinations, Notifications and Account on one row. All three have zero page overflow. Selecting a range in the portrait sheet updates its pressed state.

The additional browser sweep passed 260 route/theme checks across nine phone, tablet, desktop and TV profiles; 12 login/pairing checks; and 12 camera-menu checks. Viewer controller tests pass 54 checks, PWA detection passes eight device cases, and service-worker/shell delivery passes 63 checks. These preview checks use synthetic app states and cannot replace native iOS/iPadOS 27 or physical TV verification.

| Suite | Result | What it establishes |
| --- | --- | --- |
| Browser route layout matrix | 442 passed | 17 profiles × 2 themes × 13 routes; requested dimensions/theme, horizontal overflow, header control clipping and fixture script/resource errors |
| Authentication/pairing layout matrix | 68 passed | Both entry points × both themes × 17 profiles; rendered controls, card positioning, width and script delivery; TV login includes its pairing-code state |
| Camera menu matrix | 34 passed | Bounded menu geometry, complete action access, unavailable snapshot state and background interaction scope in both themes on all profiles |
| Additional browser workflows | 59 passed | Fullscreen/inspection return, menus, calendar, keyboard focus, role filtering, drafts/discard, two-factor/recovery, clip-list UI, enhancer result/Details, event-to-Playback, Account cancel/password visibility, actual synthetic streams, TV entry, filter outside-dismissal and stacked/global keyboard guide |
| `node tools/test_viewer.mjs` | 60 passed | Real viewer/gesture implementation with deterministic input/timers: idle, holds, touch recognition, cancellation, legacy inert fallback, remote wake, native rejection/exit/races and teardown |
| `node tools/test_shell_update.mjs` | 84 passed | Worker cache/update behavior, redirect exclusion, missing offline assets, slow network, install identity, shipped imports, named ESM export linking for all entries, no-fade PWA route swaps, fullscreen media sizing, short-landscape toolbar spacing and trailing-edge navigation/account anchoring, tablet-width Events alignment, single TV viewer exit, fixed PWA header/spacer geometry, iPad landscape Overview caption placement, centered Event preview video, and Account action placement |
| `node tools/test_pwa_bootstrap.mjs` | 8 passed | Installed iPhone/iPad detection, desktop-UA iPad, browser-tab exclusions and other platforms |
| `.venv/bin/python tools/test_auth_core.py` | 96 passed | Real account/session, 2FA/recovery, pairing, trusted-network and CLI logic in temporary data |
| `.venv/bin/python tools/test_auth_http.py` | 97 passed | Anonymous entry import graph, route/WebSocket access by role, login flows and network bypass rules in the isolated test app |
| `.venv/bin/python tools/test_playback_service.py` | 9 passed | Coverage/backfill failures retain recoverable state and clear running flags |
| `.venv/bin/python tools/test_enhance_models.py` | 21 passed | Model catalog, SHA-256-verified downloads, same-size corrupt-cache replacement, upscaler reference release and settings logic in temporary data. A separate fallback check skipped because the scratch directory has no Real-ESRGAN weights; this is not real inference validation. |
| JavaScript syntax, Python compilation, `git diff --check` | Passed | Shipping JS modules and changed Python test/preview files parse; no whitespace errors |

These are bounded checks with synthetic fixtures, not a claim to have exercised every possible hardware/recorder combination. Expected unavailable-media errors are excluded in the no-recorder preview; unexpected script/resource failures remain visible. See [adaptive-ui-matrix.json](adaptive-ui-matrix.json) for the executed browser measurements and workflow inventory.

### Viewports and routes

| Profile family | Tested browser dimensions |
| --- | --- |
| Phone portrait | 320×568, 375×667, 390×844 |
| Phone landscape | 667×375, 844×390, 932×430 |
| Tablet portrait | 768×1024, 820×1180 |
| Tablet landscape / larger window | 1024×768, 1180×820, 1366×1024 |
| Desktop | 800×450, 1440×900, 1920×1080, 2560×1080 |
| TV browser profile | 1280×720, 1920×1080 |

Every route sweep includes Live, Playback, Events, Settings root, Connection, Channels, Display, Channel-zero, Enhancement, Status, Security, Settings Account and direct Account. Profile tests cover both light and dark. Targeted workflows additionally cover Focus, event preview, enhancer selection/result/inspection, export trimming/clip-list, menus, dialogs, authentication challenges and TV mode entry.

## Feature and state coverage

| Area | Executed coverage | Acceptance still needed |
| --- | --- | --- |
| Live / Focus | Four decoded streams in the isolated rig; actual 960×480 SD and 1920×1080 HD; quality menu, enabled snapshot state, next camera and return; wall/overview expansion, one bookmark, exit placement and menu zoom/filter actions | Native touch gestures, physical TV decoder/remote behavior and recorder channel-zero playback |
| Playback | Normal/compact layouts; date/calendar and all speeds; Timeline/More; selected-camera expansion; two-pane restoration/rotation; filters, range/export entry and persistent return; unsupported/rejected fullscreen covered in controller tests | Real synchronized multi-camera recordings, seeking/frame-step accuracy, reconnect and recorder session limits |
| Events | Demo events/thumbnails, filters/layouts, preview scope/close and event-selected camera/time routing into Playback | Actual alarm data, recordings, previews and download jobs |
| Export / Verify | Trim handle keyboard input, add-to-clips, list mode, packaging controls, Back and landscape fit; existing export/signing/standalone verifier backend code is unchanged | Real MP4/package generation, ranges, multi-clip jobs, hashes/signatures and offline `verify.html` on produced artifacts |
| Enhancement | All mode choices in short layout; synthetic result/comparison, provenance, inspector and fullscreen return; model suite | Real GPU/CPU inference, crop/OCR accuracy, saved result/original/provenance files and job survival across app updates |
| Settings / Account / Security | All sections in matrix, draft rotation, save/navigation clearance, explicit discard guard, Account editing cancellation and password visibility; backend auth suites cover security mutations | Native keyboard/AutoFill, photo picker/upload and physical cross-device pairing/session revocation |
| Input / overlays | Browser clicks, pointer movement, keyboard/remote focus, Escape; scoped dialogs/popovers, filter backdrop dismissal, stacked-dialog focus and global guide; deterministic tap/double-tap/pan/pinch/cancel/idle/hold tests | Actual touchscreen gestures, accessibility settings and Safari/native compositor interaction |
| Install / update | Stable manifest ID/start/scope/orientation; worker network-first/old-cache removal; uncached API/auth; missing offline assets surface a failure; public entry compatibility and module delivery | On-device close/relaunch upgrade, launch offline after warm cache, update during an active review/job, Docker rebuild/runtime |

No real recorder settings or accounts were changed by these tests. The video rig has its own scratch settings/data and fake RTSP test patterns. The UI preview uses in-memory jobs and synthetic account/role responses; it does not write to a recorder or run AI inference.

## Screenshots and reproducibility

The README gallery uses optimized progressive JPEG captures. All 14 screenshots are generated deterministically using a unified 4-channel residential camera rig (`tools/synthetic_scenes.py` and `tools/capture_screenshots.py`). The images are interface evidence, not production camera footage: all scenes and event thumbnails are 100% synthetic, and the enhancer image demonstrates the interface rather than image quality.

| Capture | Dimensions | Source |
| --- | --- | --- |
| [Live grid](screenshots/live-grid.jpg) | 1440×900 | Four synthetic residential camera streams (Driveway, Front Door, Backyard, Side Gate) |
| [Focus](screenshots/focus.jpg) | 1440×900 | Synthetic 1080p Driveway camera in Focus with settled controls |
| [Phone Live](screenshots/mobile-live.jpg) | 390×785 | Phone portrait live view 2-column grid with bottom capsule navigation (status area cropped) |
| [Playback](screenshots/playback.jpg) | 1440×900 | Review workspace with synthetic Driveway stream, timeline coverage span and transport |
| [Events](screenshots/events.jpg) | 1440×900 | Synthetic events with matching camera scene thumbnails and filter sidebar |
| [Enhancer](screenshots/enhancer.jpg) | 1440×900 | Vehicle license plate comparison slider with active plate OCR reading panel (`CAB 4821 100%`) and ENHANCED banner |
| [Settings](screenshots/settings.jpg) | 1440×900 | Display and layout settings fixture |
| [TV profile](screenshots/tv-mode.jpg) | 1920×1080 | Fullscreen Channel-zero 4-camera composite overview with persistent top navigation bar and clock |
| [Landscape Playback](screenshots/phone-landscape-playback.jpg) | 844×390 | Phone landscape review with shallow transport and on-demand Timeline |
| [iPad Playback](screenshots/ipad-playback.jpg) | 1180×796 | iPad landscape review workspace with timeline coverage span and speed controls (status area cropped) |
| [Light Events](screenshots/light-events.jpg) | 1440×900 | Light-theme event review workspace |
| [Phone Settings](screenshots/mobile-settings.jpg) | 390×785 | Phone compact grouped settings sections and bottom navigation |
| [Landscape Export](screenshots/export-landscape.jpg) | 844×390 | Signed evidence package export dialog with interactive trimming |
| [Phone login](screenshots/login-phone.jpg) | 390×844 | Mobile login card with TV pairing option |

Run `.venv/bin/python3 tools/capture_screenshots.py` to regenerate all 14 screenshots automatically via headless Chrome.
Run `.venv/bin/python3 tools/pwa_preview.py --port 8083` for the interactive isolated UI preview fixture. Its URL flags select `theme`, `pwa`, `top`, `bottom`, `apple=1` (simulate Apple touch-device detection), `tv`, `role`, `signed`, `overview`, `demo`, `unsupported` and a capture overlay (`screen=enhancer` or `screen=export`). `capture=1` hides fixture instrumentation. Injected device flags are fixture-only, not production detection logic.

`tools/adaptive_browser_checks.mjs` exports the profile list and `runRoutes`, `runEntries`, `runCameraTools` for the documented Browser skill runtime's tab/viewport APIs. Run profiles in small batches and save results between batches. This module is a runtime helper, not a standalone CLI test. `tools/test_rig.sh start` prepares the fake camera rig; `serve` keeps it under a foreground session owner when detached children would be reaped. UI settings tests belong only in this rig or the preview.

## Native and deployment acceptance

1. On the user's installed iPhone and iPad running iOS/iPadOS 27, completely close and reopen online. Check `window.SentinelPWA.diagnostics()` locally if needed: HTML, CSS and JS revisions should all read `adaptive-v33`. It reports geometry/version only, without recorder/account/video data.
2. Check all routes, both orientations/themes, the status-area sharpness, home-indicator/nav spacing and keyboard/AutoFill. Exercise Focus, channel-zero wall and one/two-camera Playback expansion; return in one action after chrome hides and after rotation. Verify tap, double tap, pinch, pan and menus separately.
3. Verify a physical TV with viewer/operator accounts, directional remote, OK, Back, play/pause, page changes and idle/reveal. Confirm controls hide without blacking out the hardware-decoded video and that return remains usable if native fullscreen is absent.
4. With a connected recorder, complete the Playback/export/enhancement acceptance items above, including session cleanup, time alignment, produced evidence files and background jobs.
5. Docker's daemon was unavailable locally. Static Docker asset inclusion passed; image build, container update and runtime smoke tests remain pending. Existing native static serving needs no Python restart for these frontend/public-entry changes; Docker updates still require rebuilding the image as documented in the README.

The redesign does not change manifest installation identity, recorder protocols, authentication policy, export signing, AI models or database schema. It does not force a reload over an active job or draft. Warm-cache launch is distinct from offline camera playback: live/recorded media still requires its existing services.


### Toolbar and Live fullscreen refinement — adaptive-v14

- Desktop Live fullscreen now places its auto-hiding Exit action in the bottom-center control dock, alongside page navigation. Single-page and Channel-zero Overview layouts keep the dock visible; camera tiles retain their corner actions. Touch and TV layouts keep their established return controls.
- Tablet Live keeps Overview/Grid and layout selection on one row. Tablet Playback uses two intentional rows: title/navigation above, with date/cameras and speed/export together below. Other bars share aligned control heights.
- iPad Events search is width-capped; range presets stay in the toolbar when there is room and move into the Filters sheet at narrow widths.
- Checks: `node tools/test_viewer.mjs`, `node tools/test_pwa_bootstrap.mjs`, `node tools/test_shell_update.mjs`, JS syntax checks, and `git diff --check`. Browser preview checks cover desktop Live grid and Overview exit/dock auto-hide, iPad toolbar geometry, and TV/touch control visibility. Physical iOS/iPadOS 27 and live-recorder verification remain device acceptance items.
