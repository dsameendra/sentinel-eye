# Sentinel Eye: unified interface and viewing experience

**Status: approved by the user; implementation and local validation completed in `adaptive-v13`. Native device and recorder acceptance remains a release gate.**

Prepared 2026-10-04 against the current working tree on `fix/ios-status-bar`, including the previous PWA fix. The user has confirmed that the top blur is gone on their installed iPhone/iPad apps. That behavior is an accepted baseline to preserve.

## 1. Scope and intended result

Improve the **whole application on desktop, TV, iPhone and iPad**, including portrait, landscape, small windows, fullscreen and both themes. This is a cohesive refinement of the working product: navigation, layout, control hierarchy and interaction become consistent while cameras, playback, review, exports, enhancement, accounts and installation retain their behavior.

The aesthetic direction is quiet, precise and content-led: footage has priority; controls appear where they are useful; spacing and materials explain hierarchy. Use the existing system typography, graphite/daylight palette, rounded controls and semantic colors. Add an Apple-inspired floating phone navigation bar without depending on native UIKit effects or bringing blur back into the protected status area.

Approval covers the phased frontend implementation, relevant tests, design documentation and final README/screenshots. Publishing/deployment remains a separate action. Changes to recorder protocols, playback synchronization, export integrity, AI models, authentication policy and installation identity are outside the redesign.

## 2. Audit: what needs changing

| Finding | Evidence in the current implementation | Planned response |
| --- | --- | --- |
| Landscape phones inherit desktop layouts | Most phone rules stop at 640 px; wrapped bars stop at 900 px. No layout rules based on viewport height or orientation were found | Add a shared short-height layout and coordinate width, height, safe areas and input capability |
| Playback can become mostly controls | Synthetic 844×390 preview: header 98.2 px, controls/timeline 229.1 px, video stage 62.6 px. At 1440×900, the same controls leave a 610.9 px stage | Give short-height playback a compact transport and on-demand detailed timeline/tools |
| Phone navigation disappears on rotation | `.tabbar` is shown only at ≤640 px. At 844×390 it is absent and desktop actions return | Keep the four destinations available in compact touch landscape too |
| Focus/replay touch only reveals controls | `_bindFocusAutoHide()` listens to `touchstart`, `mousemove`, `mouseenter`, `focusin`; no background-tap hide toggle | Add one shared input-aware visibility controller |
| Touch can leave controls pinned | Focus tests unconditional `:hover` and `:focus-visible` before hiding; sticky touch hover is a plausible contributor to the reported device behavior | Use actual input events for hover ownership; distinguish touch, keyboard and remote focus |
| Visibility rules differ between viewers | Focus/replay and wall use hardcoded 2600 ms; Playback uses `controls_autohide_sec`; TV wall uses its own 6-second cycle. Paused behavior and interaction guards differ | Share the mechanism; document explicit profiles and use the existing setting consistently where it applies |
| Gesture handling already has valuable safeguards | `zoom.js` consumes pan/pinch clicks and has a 320 ms double-tap recognizer; tiles support long press | Integrate tap recognition with these paths; preserve zoom, pan and long press |
| Intermediate-width enhancer loses mode access | At 641–900 px, `.enh2-bar .bar-actions` is hidden; synthetic 844 px snapshot lacks Auto/Face/Plate/General | Move choices into an accessible compact selector rather than hiding them |
| Top and bottom materials disagree | The accepted PWA top is solid; Focus bottom, Playback panels, save bars and tab bar still use different glass treatments | Define materials by role and make docked top/bottom chrome match |
| Desktop global navigation is concentrated in Live | Other route headers generally provide Back to Live instead of persistent destination access | Provide consistent top-level navigation on all main desktop/tablet routes |
| TV treatment is uneven | Live/Focus get substantial TV-specific sizes; other pages mostly retain fixed pixel sizes. `tvnav.js` tests the candidate's style, so ancestor visibility also needs review | Make every supported TV screen readable and remotely operable; verify ancestor visibility and focus ownership |
| Some touch controls remain small | Coarse-pointer styles still include 36–40 px targets and narrow trim/split handles | Expand hit areas and provide accessible alternatives without enlarging every visual icon |
| Settings has a numeric presentation mismatch | Synthetic display settings reports slider value 2.5 and label 2.60 for the current 2.6-second default with a 0.5 step | Align slider precision with stored values without silently changing saved settings |
| Fullscreen means different things today | Camera Focus is an app view; Live, Playback and enhancer request different elements through the Fullscreen API | Define normal, immersive app viewing and browser fullscreen explicitly |
| Installation/update code is deliberately simple | Plain ES modules, three HTML entries, anonymous resource allow-list, shell cache v10, `COPY web/` in Docker | Keep deployment simple and verify new shared resources in every entry/build/update path |

Source anchors: `web/css/app.css`; `web/js/live.js` visibility methods; `web/js/playback.js` build/visibility/fullscreen methods; `web/js/zoom.js`; `web/js/tile.js`; `web/js/bar.js`; `web/js/tvnav.js`; `web/js/enhancePopup.js`; `web/js/settings.js`; `web/js/main.js`; `web/js/pwa.js`; `web/sw.js`; `app/auth_api.py`; `Dockerfile`; `run.sh`.

Evidence boundaries: measurements above use desktop Chrome with synthetic content and emulated dimensions/insets, not native iOS compositing, touch or a connected recorder. TV findings here are source audits; the TV entry dialog was inspected and cancelled because it can enable Channel-zero globally. The actual touch-hide failure is user-reported; sticky hover is a hypothesis to verify on-device, not a proven sole cause. Temporary preview buttons are test instrumentation, not proposed product UI.

## 3. Design rules shared by every screen

1. **Make the main task obvious.** Watching: picture first. Reviewing: picture and time. Editing: clear fields and a reachable commit action. Security: clear consequences and confirmation.
2. **Unify roles, not screen density.** The same action uses the same icon, label, state and dismissal behavior everywhere. Desktop shows more controls; touch groups them; TV prioritizes distance and focus.
3. **Keep features discoverable.** Secondary actions move into a labeled menu, sheet or inspector. They are never removed solely to make a screenshot cleaner. Disabled/locked actions explain why.
4. **Preserve user state.** Rotation, window resizing, showing/hiding chrome and entering/exiting fullscreen must not change camera selection, stream quality, time, zoom, filters, clip ranges or unsaved edits.
5. **Use restrained motion.** Short fades and modest position changes establish relationships. Respect reduced motion and keep the accepted stationary PWA top treatment.
6. **Fit footage faithfully.** Preserve source aspect ratio. Keep the current Fit/Fill choice and zoom behavior; do not introduce automatic cropping to fill a new layout.
7. **Keep interaction predictable.** A video-background tap controls chrome, not play/pause. Transport buttons and existing shortcuts control playback. Editing gestures do not dismiss tools.

## 4. One adaptive layout contract

Use a small shared layout contract for page headers, navigation, toolbars, sheets and viewers. CSS handles most adaptation; JavaScript observes real container/viewport changes only where layout or existing state needs coordination. Do not make separate page-by-page device guesses.

| Layout | Starting criteria to validate | Result |
| --- | --- | --- |
| Compact width | Available width roughly ≤640 px | Single-column pages, floating bottom destinations, tools in sheets, scrollable forms |
| Short touch workspace | Available height roughly ≤540 px, landscape proportions and touch capability; validate at 667–1024 px wide | Compact titles, shallow controls, persistent compact destinations, video-first review |
| Medium workspace | Roughly 641–1100 px with usable height | Tablet/narrow desktop arrangement; context controls and inspectors adapt to their containers |
| Wide workspace | Enough width/height for video plus inspectors | Full review tools, consistent top destinations, restrained sidebars |
| Short desktop window | Limited height with mouse/keyboard use | Compact header/context controls and collapsible detail panels; keep desktop navigation conventions |
| TV profile | Explicit TV mode, independent of window width | Distance-readable text, generous spacing, remote focus, opaque surfaces and overscan margins |
| Immersive viewer | Explicit user action, independent of the above | Picture fills available viewport; grouped controls overlay it and follow visibility policy |

These are starting thresholds, not a claim that every iPad or phone has a fixed width. Use **available container space**, browser zoom and visual viewport as well as window dimensions. A narrow iPad window can use the compact arrangement; a touch-enabled laptop still supports its mouse and keyboard. Use each pointer event's type for interaction, rather than treating an entire hybrid device as permanently touch-only.

Shared geometry must account for top protection, left/right notch insets, home indicator, navigation footprint, action-footer footprint and keyboard obstruction exactly once. Reserve measured wrapped-header heights using the existing PWA helper. Extend that helper deliberately if new header classes are introduced. Centralize bottom offsets and scroll padding so the last form field, timeline lane or focused button never sits under a fixed surface.

Use dynamic viewport sizing with a fallback, minimum-height-zero flex/grid children, explicit scroll owners and container-aware inspectors. No page-wide horizontal scrolling; intentional camera-chip/frame-strip/timeline scrolling remains available. Keyboard appearance reduces the sheet/form area while preserving scroll-to-focused-field behavior.

## 5. Navigation and bottom surfaces

### iPhone and compact touch layouts

- Replace the edge-attached tab slab with a **floating rounded capsule** containing Live, Playback, Events and Settings in that order. Keep labels, accessible names, selected state and current permission feedback. The entire destination cell is a touch target.
- Portrait: icon above label; roughly 56–64 px capsule height, modest side margins and separation above the home indicator. Landscape: icon beside label in a shallow capsule, centered with a bounded width. Exact dimensions follow fit/target tests.
- Keep the capsule stable during normal browsing. Do not add scroll-to-minimize behavior in the first implementation; stable navigation is easier to validate with timelines, forms and nested scrolling.
- Hide global navigation only in an intentional immersive viewer or a covering app overlay. Restore it on exit. When the keyboard is open, adapt visibility/space coherently instead of leaving a floating bar over text input.
- Place route-specific tools above navigation using the shared bottom footprint. A save/export footer and navigation cannot independently claim the same bottom edge.
- Keep Account and notifications reachable from a consistent header location/menu. Secondary Settings pages use an accurate Back label to the section list; full-screen overlays use Close/Back to the actual originating view.

### iPad

- Full-size portrait/landscape: persistent, restrained **top destination group** for the same four sections, plus notifications/account in the same locations. Keep route context separate from destination navigation.
- Settings and Events can have their own sidebar/inspector within the page. Avoid stacking an app sidebar and a second permanent section sidebar unless measured space justifies it.
- Narrow windows use the compact navigation contract. Short-height windows collapse context into selectors/sheets; attaching a keyboard or trackpad does not remove touch access.

### Desktop

- Give every main route the same compact destination group, notifications and account access. Remove the need to return to Live just to find another section.
- Keep page title/context/action ordering consistent. Wide screens expose useful context controls; narrower windows offer named selectors and overflow tools. Do not add decorative empty header rows.
- Retain nested Back behavior and all hash/deep links. Account is an account destination, not a fifth top-level tab.

### TV

- Use the same four destinations in a large, remote-readable navigation panel/header. Every main route has a reliable way to reveal navigation and return to Live.
- During viewing, global navigation joins the TV visibility policy. On forms, lists and settings it stays available and never auto-hides while editing.
- Retain the existing TV entry confirmation and local quality/layout/theme settings. The design must not silently change global Channel-zero or other clients' preferences.

### Material roles, including the newly solid top

| Role | Dark | Light | Usage |
| --- | --- | --- | --- |
| App chrome | Existing `--bg` / `--chrome-bg`, near-black | Existing daylight background | Solid page header and docked non-immersive footer; same surface at top and bottom |
| Floating navigation / panels | Same neutral family with a modest lift, border and shadow | Light neutral panel with a subtle border/shadow | Capsule navigation, menus, save capsule and sheets; no arbitrary black/gray mismatch |
| Media controls | High-contrast dark neutral plate over footage | Same dark media plate over footage | Floating viewing controls; footage has its own contrast needs |
| Protected PWA top | **Accepted solid theme treatment** | **Accepted solid theme treatment** | No glass or animation that reintroduces the status blur |

Floating navigation gets its shape, spacing and selected capsule from the Apple-inspired direction. Any translucency is optional, conservative and confined to that floating role; it must pass moving-content contrast and performance checks. Prefer an opaque default over camera grids, in TV mode and when transparency is reduced/unsupported. Avoid glass over four moving Playback panes. The status-area fix takes precedence over decorative material.

Focus/replay currently mix themed solid top chrome with glass bottom chrome. Bring their grouped controls into the same visual family. If the installed PWA header owns the protected top area, keep its accepted surface even while the lower transport uses the shared dark media plate. This is a deliberate app-chrome/media-control distinction, not a different theme for each page. Update `docs/DESIGN.md` to make this distinction explicit and remove conflicting old glass rules.

## 6. A consistent viewing/fullscreen model

There are three states, each with a clear exit and preserved context:

| State | App navigation | Controls | Fullscreen API |
| --- | --- | --- | --- |
| Normal page/review | Available | Docked tools and page context | Not required |
| Immersive app viewer | Hidden | Floating viewer controls, tap/idle policy | Not required; works within installed/browser viewport |
| Browser fullscreen viewer | Hidden | Same immersive composition and behavior | Requested from user interaction if supported; track actual success/exit |

Use a shared viewer controller for entry, exit, visibility, focus restoration and overlay ownership. Live Focus, replay, Playback and enhancer inspection bind their own actions to it rather than owning separate timing/gesture/fullscreen mechanisms. Event preview can reuse its viewing treatment while remaining a preview, not become a second full review implementation. Export/crop/security forms remain editing surfaces even when they occupy the whole screen.

**Fullscreen request failure:** keep the immersive app view usable, with an accurate state/exit icon. Do not claim the browser is fullscreen when the promise rejects. Do not force a native video-only player for canvas Playback, enhancement or multi-camera viewing; that would lose custom features. Do not automatically enter fullscreen just because the device rotated.

**Return behavior (updated after user feedback):** the same expand button, explicit Exit view, or browser fullscreen exit restores normal composition in one action. Selected-pane expansion restores all existing panes. Close/Back returns to the originating route/pane. Browser Escape may exit fullscreen itself; respond to `fullscreenchange` without also navigating away accidentally. Restore selected camera(s), playback epoch/play state, timeline view, filters, zoom and scroll as applicable. Reuse the existing player/canvas; do not duplicate streams or create extra recorder sessions to change presentation.

**Layer ownership:** menus, tool sheets, dialogs, notifications and recovery controls mount inside the active viewer/fullscreen subtree where necessary. Only the active viewer responds to reveal/hide input. Background pages are not interactive under covering views. Make disposal explicit when a route/viewer closes; running jobs may continue through their existing job mechanism and must not be cancelled merely by closing a presentation.

## 7. Shared control-visibility behavior

Use one controller with visible, hidden and interaction-held states. Track the last meaningful input, explicit manual hiding and why hiding is held. The core state machine is shared; timing and available controls can have documented input/view profiles.

| Trigger | Touch viewer | Mouse/keyboard viewer | TV remote |
| --- | --- | --- | --- |
| Open viewer or enter fullscreen | Reveal controls briefly | Reveal controls briefly | Reveal controls with an initial focus/default action |
| Valid single tap/click on video or empty viewer background | Toggle shown ↔ hidden; never pause footage | Click toggles chrome; mouse movement can reveal it | OK on the watching surface reveals controls |
| Idle while live/playing | Hide after configured interval | Hide after interval unless using a control | Hide viewing chrome after remote inactivity; return focus to watching surface first |
| Tap/click a control | Perform its action, reveal/hold relevant controls | Same | Focused action executes normally |
| Open menu/sheet/dialog | Keep its owner available | Keep its owner available | Scope remote navigation to the overlay |
| Background tap with a menu open | Dismiss the menu first; do not also hide chrome | Same | Back dismisses innermost overlay first |
| Pause replay/Playback | Show and keep controls by default; background tap may explicitly hide | Same | Pause reveals transport; explicit viewing/hide action remains available |
| Resume playback | Reveal briefly, restart idle timer | Same | Same within remote profile |
| Pinch, pan, scrub, ROI, wipe or trim drag | Hold tools during gesture; do not interpret release as tap | Same | Slider/range interaction holds controls |
| Keyboard/assistive focus enters a control | Reveal and keep that focused control visible | Pin while keyboard focus is within controls | Distinguish actively navigating from a stale remote focus left after activation |
| Close overlay or finish gesture | Re-evaluate holds, then restart timer | Same | Restore a visible focus target, then apply idle policy |
| Return from background/rotation | Reconcile bounds and reveal briefly unless an editing hold applies | Same | Same; resume the current viewing context |

Important details:

- Use Pointer Events and input-aware hover ownership. A touch-created `:hover` state cannot pin chrome forever. Mouse hover over an actual control still protects it.
- Cooperate with `ZoomPan`'s 320 ms double-tap recognition and consumed gestures. Do not attach an unrelated touchstart/click pair. A confirmed double tap zooms without hiding controls; long press, cancelled pointer, pan and pinch do not count as a toggle. Evaluate tap delay during device testing before changing thresholds.
- Use the existing `display.controls_autohide_sec` for Focus, replay and Playback. Preserve its stored/default value. TV wall's existing ambient idle profile can remain 6 seconds; that is distinct from viewer playback timing. Update the setting's label/help text to explain paused/manual-hide behavior accurately.
- Hidden actionable chrome is removed from keyboard/remote interaction, not merely transparent. Use scoped `inert`/focusability handling with a compatible fallback. Keyboard-focused controls are not silently hidden; a TV remote's idle focus can return to a labeled watching surface and restore the previous action when revealed.
- Keep critical disconnected/error information accessible. Do not hide a recovery action while the user is resolving failure. Routine time/frame/status refreshes do not restart idle timers.
- Clean up timers/listeners on close, camera swap, route teardown and page visibility changes. Test for duplicates after repeated entry/exit.
- Preserve existing playback shortcuts. Escape/Back dismisses the innermost editor/menu before closing a viewer; do not intercept browser/system fullscreen escape semantics.

## 8. All-screen and feature plan

Every row is in scope on every supported device. An overflow destination is a real, labeled place with the same enabled/permission state, not a hidden feature. TV codec limitations remain explicit capability states.

| Screen / feature group | iPhone portrait and landscape | iPad / windows | Desktop | TV |
| --- | --- | --- | --- | --- |
| Live grid and paging | Legible tiles, stable camera order; short-height layout favors usable tile sizes; layout/paging/rotation controls in compact tools | Container-aware tiles, useful asymmetric layouts where space permits; clear page state | Preserve dense/asymmetric layouts; cleaner grouping and stable labels | Keep cheap local defaults, Overview priority, large page/focus actions and ambient camera identity |
| Arrange / camera quality / quick actions | Tap opens Focus; visible More alternative to long press; no missed tiny targets | Touch, trackpad and keyboard actions coexist | Retain drag reorder, hover actions, keyboard shortcuts and quality state | Remote-accessible supported actions; do not require hover or drag |
| Channel-zero Overview | Clear Overview/Grid toggle and status; no false per-camera replay/export actions | Same semantics with adequate tools | Same semantics and stable global navigation | Preserve single-stream efficiency, local grid fallback, idle return and wake lock |
| Single-camera Focus | Picture-led immersive view; compact Back/title/More and grouped replay/snapshot/review actions | Same viewer contract with more exposed tools when space permits | Retain arrows, snapshot/bookmark/quality/filter/zoom access with calmer chrome | Large camera name, quality/replay, camera arrows and navigation; supported secondary actions reachable |
| Instant replay | Compact time/transport/Back to live; consistent tap/idle; accessible paused state | Same transport, larger scrub/readouts if already supported | Keep current playback/restart keys and return context | Remote transport, clear live-vs-recorded state; codec failure is recoverable |
| Playback, 1–4 cameras | Portrait keeps readable video/transport; landscape removes permanent large timeline/context stacks; camera/date selectors and tools are compact | Adaptive panes and timeline; avoid oversized empty stage in portrait | Full review workspace; timeline and metadata hierarchy improved; useful collapsed detail at small heights | Larger labels, time and remote transport; clear active pane and session-budget feedback |
| Selected-pane / multi-camera full screen | Active pane can be enlarged as presentation while retaining selected cameras/time; expand/collapse is explicit | Same, with easy return to all panes | Same, preserving synchronized review | Full-picture inspection and return via remote; no duplicate sessions |
| Seek / frame steps / speed / time | Play/pause and short skips primary; frame steps/speed/exact time easy to reach; detailed timeline in a sheet for short-height mode | More tools visible; thin timeline remains usable in windows | Keep frame steps, all speeds, zoom/pan lanes and exact time; group low-frequency actions | Arrow/slider-safe transport, readable time, speed options respecting recorder limits |
| Timeline / bookmarks / range selection | Accessible controls supplement gestures; large drag hit areas; range edit holds chrome | Adaptive lane heights and scroll ownership | Preserve coverage/events, snap seeking, range tools and incident notes | Keyboard/remote alternatives to precision drag; no hidden keyboard-only dependency |
| Playback empty / queued / error / unsupported | Context, retry and camera/date changes stay reachable, without endless blank video | Same | Same | Same; do not promise WebCodecs support where absent |
| Real-time picture adjustments | Scrollable sheet with presets, grouped sliders and reset; preserve values when resized | Popover/inspector chosen by space, both touch and pointer usable | Anchored panel with clear changed values and active state | Remote-readable preset/slider panel for supported filters; opaque/performance-conscious |
| ROI / flashlight / zoom minimap | No gesture conflict; explicit reset; flashlight touch interaction made discoverable; minimap only when useful | Touch/trackpad/keyboard alternatives | Preserve pointer tracking, wheel, ROI and zoom controls | Keep supported remote zoom/reset; no pointer-only instruction without alternative |
| AI enhancer pick / mode / crop | Mode selector always reachable; frame strip and crop tools fit; primary action accessible | Repair 641–900 px mode loss; adaptive image/editor composition | Cleaner selection/reference/primary-action hierarchy | Supported editing via large controls and keyboard alternatives; clear capability message otherwise |
| AI loading / result / wipe / OCR / save | Image first; details/progress/OCR in a sheet; landscape inspector on demand; crop/wipe/OCR hold tools | Optional side inspector only with enough room; comparison fullscreen uses shared viewer | Preserve before/after wipe, fidelity, live filters, OCR, model provenance and both downloads | Readable progress/result controls, usable remote sliders; retain provenance and source distinction |
| Export trim / exact times / package / clip list | Scrollable workspace with reachable sticky action; portrait stacked, short landscape compact preview and tools; drag handles have larger hit areas | Side-by-side only when both columns remain usable | Refine preview/trim/package hierarchy; preserve multi-cut list and progress | Large actions and time inputs; remote range alternatives; unsupported download behavior explained |
| Export background jobs / failure / completion | Closing presentation preserves existing job behavior; state remains discoverable on return | Same | Same | Same where supported; never silently duplicate jobs |
| Events / search / cameras / kinds / date filters | Full-height filter sheet or compact landscape side sheet; results retain useful thumbnails/list rows | Sidebar only when results still have room | Consistent navigation, aligned search/filter/result hierarchy | Readable event cards, remote filters and pagination/scroll |
| Event preview / open Playback / download | Bounded picture with accessible Close and actions; adapt to short height | Same shared presentation primitives | Calm preview preserving return to search | Remote Close/Restart/Open in Playback and supported download access |
| Settings section list / recorder / channels | Compact list/detail flow in both orientations; forms scroll, channels use labeled cards rather than squeezed tables | Sidebar/list choice follows container, not device name | Clear grouped forms; bounded line lengths, readable dense channel tables | Large labeled fields/options, predictable focus and scrolling; no hover-only edit |
| Settings display / enhancement / status | Theme/fit/quality/layout, model choices/download progress and status remain reachable; exact slider values | Same | Same | Local TV theme/quality/layout remain local; distinguish synced settings and retain confirmations |
| Security: users / roles / sessions / pairing / network / audit | Card/list conversion for dense tables; clear action states and confirmations | Adaptive table/list; readable columns | Efficient administration, consistent row actions and focus return | Remote-readable supported administration; no silent security-policy changes |
| Account: profile / avatar / password / 2FA / recovery / sessions | Single-column sheets/forms; keyboard-safe actions and copy/download recovery codes | Well-proportioned cards, optional multi-column layout | Consistent nested navigation and dialogs | Legible account/device forms and pairing status; image/file features retain capability handling |
| Sign-in / 2FA / recovery / device-pair QR / approval | Both orientations and keyboard states; safe centered/scrollable card; no clipped submit buttons | Adapt QR/form placement to available size | Restrained centered entry UI, existing redirects and form semantics | Large QR/code and instructions, remote-friendly inputs and clear expiration/retry |
| First-run onboarding / testing / discovery / Done | Same form/presentation system; failure and final actions reachable | Same | Same | Clear setup steps and remote focus; preserve actual probe/save semantics |
| Notifications / bell / toasts / menus / dialogs / shortcuts | Safe placement, sheet alternatives and non-conflicting tap dismissal | Popovers or sheets chosen by available room | Consistent anchoring, keyboard dismissal and focus restoration | Large opaque panels, correct remote scope and Back behavior |
| Loading / offline / recorder down / permission / revoked session | Legible action-oriented states; no stale data represented as live | Same | Same | Same; persistent failure cues do not vanish with idle controls |

The evidence-package `app/export_assets/verify.html` is a separately exported offline document, not an app navigation screen. Verify its responsive readability in all viewport classes and preserve its verification behavior. Only change its styling if the audit identifies an actual issue; do not couple it to app scripts, authentication, a service worker or online fonts.

## 9. Concrete viewing layouts

### Phone portrait Playback

Small route header with camera/date selectors; useful aspect-correct video; one clear transport group; timeline/detail area that can expand; a tools sheet for speed, stepping, bookmark, enhancement and export; floating destinations below the shared bottom action footprint. Preserve multi-camera selection and a clear active pane instead of showing four unusably small pictures without an inspection path.

### Phone landscape Playback

Compact single-line route/context header. Video gets the majority of the working area. Primary transport is shallow; the full timeline/precision tools open on demand rather than consuming 173 px permanently. Compact floating destinations stay available in normal review and disappear when the user chooses immersive viewing. Primary controls remain at least 44×44 CSS px; compactness comes from grouping and fewer simultaneous items, not smaller hit targets.

Acceptance target: at reference 844×390/top-inset-zero, a one-camera normal review should allocate at least half the viewport height to its video stage with detailed tools collapsed, compared with the current approximately 63 px. Immersive idle viewing uses the available picture viewport. Validate the smaller 667×375 case too; adapt when keyboard/large text legitimately reduces space rather than clipping tools to hit a percentage.

### iPad review and inspection

Use a balanced video stage and timeline, not the phone portrait stack stretched to tablet size. In portrait, cap unhelpful empty video-stage space and use it for meaningful timeline/context while preserving image aspect. In landscape, optional inspectors sit beside the picture only when both have comfortable widths. In narrow/windowed modes the same tools become sheets. Enlarge one selected pane without losing the multi-camera review context.

### Desktop review

Expose date, selected cameras and constrained speed clearly, with export as the review action. Keep transport centered, timeline legible and low-frequency image tools grouped. Use space productively on large displays; constrain forms/details while letting footage and timeline span the workspace. Short desktop windows can collapse detail panels without losing shortcuts or becoming a touch-only UI.

### TV viewing and review

Quiet wall/Overview idle state; large, deliberate navigation when requested; one consistent remote control overlay for Focus/replay/Playback. Always distinguish live camera viewing from recorded footage and show the selected camera/time when controls are revealed. Keep per-camera names and the existing ambient/hardware-plane safeguards where needed. Menus, Events, Settings, Account and authentication receive real TV sizing and focus work, not only a scaled Live header.

## 10. Theme, accessibility and performance

- Audit dark, light and auto throughout the inventory. Existing semantic color meanings remain unchanged. Use filled-vs-text tokens correctly; selection, motion, live, success, tamper and destructive actions remain distinguishable.
- Make docked page headers/footers share `--chrome-bg`. Use panel elevation deliberately for floating surfaces. Keep media plates readable over bright, dark and high-motion synthetic footage in both themes.
- Target 44×44 CSS px touch hit areas, including icons, calendar days, navigation cells and editing handles. Provide visible keyboard controls for exact trim/crop/seek, and leave browser zoom available outside deliberate picture gestures.
- Check text/control contrast, 200% zoom, larger text, reduced motion/transparency, keyboard Tab/Shift-Tab, VoiceOver names/order, modal focus trapping, focus return and no focus concealed by sticky surfaces. Hidden controls cannot remain tabbable or become remote targets.
- TV uses a dedicated size/spacing scale across supported screens, with roughly 56–64 px primary control targets and a safe overscan margin. Validate at actual viewing distance; do not simply increase the root font while fixed-pixel components stay small.
- Do not render every page twice or remount players on layout changes. Reuse DOM/player instances and existing streaming budgets. Prefer CSS layout, bounded observers and cleanup; avoid polling for hover/layout or adding per-frame UI work.
- Preserve the TV black-screen mitigation and opacity/visibility approach until real TV tests prove an alternative safe. No decorative blur across a wall of streams; new transitions cannot blanket-transform the protected PWA header.

## 11. Implementation sequence after approval

| Phase | Work | Exit gate |
| --- | --- | --- |
| 0. Preserve the working baseline | Record the current diff and accepted PWA files; keep unrelated untracked duplicates untouched. Run relevant baseline checks against isolated data; record current geometry, stream/session counts and important state transitions | Reproducible baseline; accepted status fix and current functional behavior identified |
| 1. Shared design/layout foundation | Update tokens/material roles and design docs; define layout modes, measured top/bottom footprints, reusable presentation primitives and complete action inventory | Phone/tablet/desktop/TV shell prototypes fit, roles agree, no accepted status-area regression |
| 2. Viewer behavior | Add shared visibility/fullscreen/gesture ownership; migrate Focus, replay, wall and Playback incrementally; adapt enhancer inspection | Touch toggle/idle/paused/menu/gesture behavior works; native/fallback exit and focus tests pass |
| 3. Navigation and review layouts | Floating compact navigation, persistent tablet/desktop destinations, TV navigation; phone landscape and all multi-camera Playback modes; selected-pane inspection | Feature access and deep links preserved; short-height video allocation and target-size gates pass |
| 4. Every page and editor | Events/preview, enhancer all states, export/clip list, all Settings/security/account screens, sign-in/pairing/onboarding; common dialogs/menus/notifications/error states | Every inventory row has a tested presentation on each supported profile |
| 5. Device and packaging validation | Full matrix, recorder/video regressions on scratch rig, native installed devices, TV hardware, cache/update and native/Docker delivery checks | No unresolved release-blocking regressions; unsupported capabilities explicitly represented |
| 6. Documentation and screenshots | Capture validated synthetic screenshots, replace affected images, update README interaction/install guidance and design inventory | Documentation describes shipped behavior and actual screenshots match it |

Reviewable commits should separate baseline preservation, shared mechanisms, layout migrations and documentation. Consolidate CSS precedence deliberately instead of appending another stack of competing mobile overrides. Preserve the existing static ES-module deployment unless a demonstrated need justifies additional build tooling. No dependency/framework rewrite is proposed.

Expected implementation locations: `web/css/app.css`; `web/js/bar.js`, `main.js`, `pwa.js`, `ui.js`, `live.js`, `playback.js`, `zoom.js`, `zoomhud.js`, `tile.js`, `tvnav.js`, `enhancePopup.js`, `eventPreview.js`, `events.js`, `settings.js`, `security.js`, `account.js`, `login.js`, `pair.js`, `onboarding.js`; small shared layout/viewer/presentation modules as needed; all three HTML entries; `web/sw.js`; anonymous static allow-list if an entry imports a new helper; targeted tests/fixtures; `docs/DESIGN.md`, `README.md`, screenshots. Backend business behavior is not to be refactored as part of UI work.

## 12. Regression and acceptance matrix

### Viewports and actual devices

| Profile | Required reference coverage |
| --- | --- |
| iPhone portrait | 375×667, 390×844, 430×932; real user's iPhone/iOS 27; installed app and Safari |
| iPhone landscape | 667×375, 844×390, 932×430; actual notch/home-indicator insets; installed app and Safari |
| iPad portrait | 768×1024, 820×1180, 1024×1366; user's iPad/iPadOS 27 |
| iPad landscape | 1024×768, 1180×820, 1366×1024; touch and attached keyboard/trackpad |
| iPad windowing | Narrow 320–600 px windows, medium 768–900 px windows, short-height windows; rotate/resize repeatedly and test supported Split View/Stage Manager modes |
| Desktop | 1024×768, 1280×720, 1440×900, 1920×1080 and ultrawide; short resized windows, 200% zoom; Safari, Chromium and Firefox for supported capabilities |
| TV | 1280×720 and 1920×1080 CSS viewports plus available 4K display; keyboard simulation and the actual supported TV browser/remote; dark/light/auto |

All inventory rows receive normal-size/light/dark checks in each applicable profile. Then test the risky combinations: short viewport + multi-camera, long labels + large text, keyboard + form, fullscreen + popover/dialog, network failure + resume, and TV + hidden chrome/remote focus. Do not claim an exhaustive Cartesian product or native verification from viewport emulation.

### Required behavior tests

1. **Visibility controller:** touch reveal/hide, configured idle, pause/manual hide/resume, mouse hover on controls only, keyboard focus, remote wake/idle, nested overlays, pointer cancellation, pan/pinch/double tap, crop/wipe/scrub/trim holds, repeated mount/dispose and background/resume.
2. **Geometry:** no page-wide overflow; all primary actions visible/reachable; no action behind notch/home/navigation/keyboard; correct single safe-area application; measured content reservation; layouts at breakpoint edges; landscape video target; drawers fit and scroll; large/long content does not clip.
3. **Live:** paging, auto-rotation/prewarming, asymmetric layouts, rearrangement/persistence, quality/fallback, Channel-zero semantics, zoom/pan, camera swap, reconnect, snapshots, bookmarks and notifications. Layout changes cannot create additional streams.
4. **Playback/replay:** 1/2/4 selected cameras, synchronization, current epoch, frame steps, seek/snap/zoom timeline, recorder speed limits, queued-session states, play/pause, selected-pane/fullscreen return, unsupported/HTTPS error, cleanup releasing sessions. Existing stream/session behavior is the comparison baseline.
5. **Review/editing:** range selection and exact time inputs, clip list and signed/plain exports, progress/failure/background completion, bookmark notes, filter presets/ROI, AI frame selection/crop/fidelity/wipe/OCR/source-vs-result labeling and downloads. Presentation changes cannot alter exported footage, package verification or model output.
6. **Settings/auth:** all sections and roles, draft/save/discard and navigation guard, TV entry/global-setting confirmation, theme/slider values, model/status states, account/profile/2FA/recovery/sessions, sign-in redirects, pairing waiting/expiry/approval, onboarding discovery/failure. Test with disposable accounts and isolated settings only.
7. **Navigation:** direct links, Back, browser history, Events/search alias, selected destination, permission feedback, menu focus restoration and underlying-page inactivity. No accidental double action from click/touch propagation.
8. **Real fullscreen:** entry/exit, browser Escape, rejected API and app-immersive fallback, menus/dialogs/notifications inside fullscreen, camera swap, rotation and resume. Test installed iPhone/iPad and desktop separately; a rejected local browser request is not a passing fullscreen test.
9. **Accessibility/performance:** target sizes, contrast, VoiceOver, remote focus, zoom, reduced settings, player/session counts before/after resizing and visibility toggles, observer/timer leaks, and native TV picture continuity while chrome hides.

Reuse `tools/test_pwa_bootstrap.mjs`, auth suites, `tools/e2e_ui.py`, `e2e_live.py`, `e2e_zoom.py` and playback service tests where relevant. Run UI suites only against `tools/test_rig.sh` or a new disposable rig because they edit settings. Its existing three channels are insufficient for four-camera regression; extend the isolated fixture intentionally. Use synthetic recordings/events and mocked AI results for routine UI checks, plus a real end-to-end scratch verification for features mocks cannot establish. Bring browser assertions into the supported browser testing workflow; do not weaken checks merely because an old runner/interface needs adaptation.

Maintain a screen/device checklist with Pass / Fail / Unsupported / Pending and evidence paths. No-release gate: accepted PWA blur returns, primary task clips, feature becomes inaccessible, hidden chrome intercepts input, playback/exports/session counts change unintentionally, TV picture blanks, or install/update/auth entry breaks.

## 13. Installation, update and rollback protection

- Keep manifest identity, scope, start URL, icon paths and Apple status metadata stable. The redesign does not require users to reinstall their Home Screen app.
- New shared resources must be present in native serving and Docker images and load anonymously where needed by login/pairing. A denied helper import must not blank an entry screen. Keep existing local/HTTPS capability messages accurate.
- Keep the shell revision aligned across worker, HTML, CSS, diagnostics and docs. The redesign shipped as v12; this desktop/tablet follow-up advances it to v13 and verifies old-shell removal, modules/deep imports and offline fallback. API, footage, thumbnails, auth forms and live sockets retain their existing cache exclusions.
- Test an existing installed client updating online, a page kept open during deployment, complete close/relaunch, slow network, offline shell launch and resume. The existing network-first cache does not imply atomic HTML/module updates; verify mixed-version behavior and coherent static delivery.
- Do not auto-reload over unsaved settings, active trim/crop/OCR editing or running exports/enhancement. If freshness needs an in-app notice, make it a deferred user-controlled refresh with safe state handling. Normal close/relaunch remains the first refresh step, not removal of the install or clearing all Safari data.
- Verify `run.sh` native update and Docker rebuild include the same frontend without changing credentials, mounted data, signing keys, schemas, recorder configuration or service ports. Use scratch instances; do not run an update against the user's active installation as a design test.
- Keep the accepted header fix separately identifiable so a redesign rollback preserves it. Revert only redesign commits and serve a fresh cache revision; restore neither old mixed-material status sampling nor unrelated user files. Preview and tests must not mutate production configuration.

## 14. README and screenshot completion

Update documentation **after the implementation and acceptance checks**, rather than illustrating a proposal as if it had shipped.

| Existing image | Final capture requirements |
| --- | --- |
| `live-grid.png` | Validated desktop grid with meaningful camera/layout state |
| `focus.png` | New grouped Focus controls visible; companion idle example if useful |
| `playback.png` | Desktop multi-camera review with the final timeline/transport hierarchy |
| `events.png` | Search/filter/results with synthetic events and updated navigation |
| `settings.png` | Updated Display & layout and truthful visibility-setting help |
| `enhancer.png` | Synthetic source/result comparison, provenance/ENHANCED distinction and OCR controls |
| `tv-mode.png` | Actual validated TV-style viewer/navigation; identify browser capture versus TV hardware evidence |
| `mobile-live.png` | Final iPhone portrait layout with floating destinations |

Add a small, selected set of new images: phone landscape Playback, iPad landscape review, and a light-theme example. Include a native installed-PWA capture to show real safe areas; capture chrome-visible and chrome-hidden viewer states when needed to demonstrate behavior. Avoid a huge gallery of near-identical screenshots.

Capture procedure: use isolated synthetic cameras/recordings/events, test accounts and mock enhancer data; load the validated final release; choose consistent viewport/theme/state; hide test instrumentation through the fixture's capture mode; capture via the browser tool for desktop/emulation and the actual device for native PWA; inspect every image; optimize without making labels unreadable. Record capture metadata (viewport, theme, input/profile, installed/emulated, revision) in a small screenshot index. Screenshots must contain no real surveillance, credentials, sensitive device addresses or personal account details.

Replace affected canonical filenames where the new view supersedes the old one; add only useful new canonical names. Update captions/alt text, the navigation/fullscreen/TV sections, touch/keyboard/remote instructions, paused/manual-hide behavior and update advice. Keep feature claims and installation commands accurate. The existing untracked `… 2…` files are unrelated working-tree artifacts and are not automatically replacement candidates.

Update `docs/DESIGN.md` with the approved layout/material/input contract, resolve outdated/conflicting glass wording, and document which native/device combinations were actually verified. Check README image links and ensure screenshots match the final UI and chosen light/dark colors. Exported `verify.html` stays independently usable offline.

## 15. Research informing the proposal

These sources guide the design; native Swift/UIKit behavior is not a claim that web CSS can reproduce every system effect.

- [Apple: Build a UIKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/284/) describes floating phone tabs and adaptive tablet navigation. Use that hierarchy and restraint for a web navigation capsule; preserve stable destinations and allow controls to adapt to available space.
- [Apple: Playing video](https://developer.apple.com/design/human-interface-guidelines/playing-video?changes=_3) recommends familiar playback behavior and preserving aspect ratio. Sentinel Eye's custom video/canvas pipelines remain, with consistent viewing controls.
- [Apple: Going full screen](https://developer.apple.com/design/human-interface-guidelines/going-full-screen?changes=l__3__6) supports keeping important features available/revealable in fullscreen. [Apple's archived fullscreen-energy guidance](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/HideControlsInFullScreenVideo.html) discusses showing controls on demand; retain necessary TV hardware-plane safeguards rather than blindly deleting every overlay.
- [Apple: UI design tips](https://developer.apple.com/design/tips/) supports fitting primary content, deliberate alignment/spacing, contrast and generous touch targets.
- [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum) and [orientation](https://www.w3.org/WAI/WCAG22/Understanding/orientation.html) inform hit areas, fixed-surface/focus handling and rotation coverage. A 44 px project target is stricter than the minimum AA target-size requirement; do not claim a conformance level from isolated checks.
- [MDN: requestFullscreen](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen) documents asynchronous success/failure and user-activation requirements. Implement capability-aware fullscreen plus a usable app-level immersive state; verify actual platform behavior instead of relying on an OS-version string.

## Approval and implementation record

The user approved this whole-app scope and authorized implementation, regression checks, documentation and screenshot replacement. Subsequent feedback also authorized right-aligned desktop navigation, consistent header heights, a lower iPhone navigation capsule, grouped mobile Settings, and reliable expanded-view exits on every input profile.

Implemented: shared adaptive geometry and materials; destinations immediately left of notifications/Account; portrait and short landscape navigation; grouped Settings and responsive forms/tables; compact Playback transport with Timeline/More; selected-pane expansion without replacing players; shared viewer tap/idle/gesture/focus behavior; installed Apple app expansion without depending on native element fullscreen; accessible persistent return controls; scoped overlays and lifecycle cleanup; all-entry static delivery and cache revision; refreshed synthetic screenshots and README/design documentation.

Follow-up audit: anonymous login helpers/styles remain in existing public assets, so an already-running backend does not need a new asset allow-list; camera quick actions use a bounded menu instead of a clipped inline strip; wall actions clear the persistent Exit corner and measured TV header; channel-zero has one discoverable bookmark for permitted roles; TV destinations respect viewer/operator access; native-entry races cannot reopen a view after exit; short-screen two-factor forms preserve their heading and scrolling. The v13 refinement removes duplicate desktop Exit chips while preserving touch/TV exits, synchronizes Live overview fullscreen icons on first render and every state change, and keeps iPad Events search adjacent to its title before the date controls.

See [adaptive-ui-validation.md](adaptive-ui-validation.md) for executed evidence, screenshot provenance, update checks, and the remaining native iOS/iPadOS, TV, recorder and Docker runtime acceptance steps. These device/deployment gates are not represented as passed by desktop emulation.
