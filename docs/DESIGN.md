---
name: Sentinel Eye
description: A dark, calm operations dashboard for watching and reviewing your own Hikvision cameras — one accent color reserved for "this is live."
colors:
  accent-blue: "#0074e8"
  accent-blue-ink: "#ffffff"
  accent-blue-soft: "rgba(0, 116, 232, 0.16)"
  live-red: "#ff453a"
  live-red-soft: "rgba(255, 69, 58, 0.16)"
  armed-green: "#34d399"
  armed-green-ink: "#052e22"
  armed-green-soft: "rgba(52, 211, 153, 0.14)"
  tamper-purple: "#bf5af2"
  tamper-purple-soft: "rgba(191, 90, 242, 0.16)"
  gunmetal-bg: "#0b0e13"
  gunmetal-panel: "#131820"
  gunmetal-panel-2: "#1a2029"
  gunmetal-line: "#262e3a"
  gunmetal-line-2: "#313b4a"
  text-primary: "#e7ebf1"
  text-muted: "#8b97a8"
  text-faint: "#5c6878"
  warn-amber: "#fbbf24"
  danger-red: "#f87171"
  danger-red-soft: "rgba(248, 113, 113, 0.14)"
  info-teal: "#2dd4bf"
  video-tile: "#05070a"
  scrim: "rgba(0, 0, 0, 0.55)"
  ov-scrim-soft: "rgba(0, 0, 0, 0.4)"
  ov-scrim: "rgba(0, 0, 0, 0.5)"
  ov-scrim-strong: "rgba(0, 0, 0, 0.55)"
  ov-ink: "#fff"
  ov-ink-dark: "#052e22"
  ov-roi: "rgba(59, 130, 246, 0.12)"
  ov-btn-bg: "rgba(255, 255, 255, 0.08)"
  ov-btn-bg-hover: "rgba(255, 255, 255, 0.16)"
  ev-motion: "#eab308"
  ev-videoloss: "#6b7280"
  ev-bookmark: "#22d3ee"
  cam-1: "#60a5fa"
  cam-2: "#f472b6"
  cam-3: "#34d399"
  cam-4: "#fb923c"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.03em"
rounded:
  xs: "5px"
  sm-tight: "7px"
  sm: "8px"
  sm-wide: "9px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent-blue}"
    textColor: "{colors.accent-blue-ink}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 13px"
  button-secondary:
    backgroundColor: "{colors.gunmetal-panel-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 13px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 13px"
  pill-status:
    backgroundColor: "{colors.gunmetal-panel-2}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.full}"
    height: "24px"
    padding: "0 9px"
  card:
    backgroundColor: "{colors.gunmetal-panel}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
---

# Design System: Sentinel Eye

## Overview

**Creative North Star: "The Watch Room, Redesigned"**

Redesign v2 (see `ROADMAP.md`) keeps the Watch Room's calm, low-contrast, stare-at-it-for-hours character but moves from one color carrying three meanings to four colors each carrying exactly one: a system blue for everything interactive (selected, primary, focus, in progress), red for "this is live right now," green for "this succeeded / is healthy," and amber/purple for the two event categories that need their own identity (motion, tamper). Nothing is decorative — every one of those four still only appears when it's specifically meaningful, never ambient — but status and selection no longer compete for the same pixel the way a single accent forced them to. Spacing stays tight, controls stay compact (28–36px), numbers stay tabular, and the interface still gets out of the way of the footage it exists to show.

The controls themselves lean refined rather than purely mechanical: hover and pressed states get real (if subtle) treatment — brightness shifts, soft accent washes, ring outlines, a couple of places real spring motion — so the density reads as considered, not thrown together.

**Key Characteristics:**
- Dark by default (`color-scheme: dark`), with a fully-specified light theme as a first-class alternate, not an afterthought.
- Four semantic colors, each with exactly one job: blue = interactive, red = live, green = success/healthy, amber/purple = event category. Never mixed, never decorative.
- Flat surfaces at rest; shadow appears only on things that float above the normal layout.
- Small, functional type scale — no hero/display type anywhere; this is an instrument panel, not a marketing page.
- Tabular numerals on every timestamp, clock, duration, zoom percentage, and count.

## Colors

A near-monochrome gunmetal-dark UI with four semantic hues, each scoped to exactly one meaning — never decorative, never doubled up.

### Primary — interactive
- **Accent Blue** (`#0074e8` dark theme / `#0072ef` light theme): primary buttons, selected/active nav and tabs, focus rings, selection state, the layout/quality picker's pressed state, drag-target highlight, zoom badge — anything that is interactive, selected, or the primary action in its group. Text-on-accent is white (**Accent Blue Ink**, `#ffffff`) in both themes. A low-opacity wash, **Accent Blue Soft** (`rgba(0,116,232,.16)` dark / `rgba(0,114,239,.12)` light), marks the "currently selected/active" background for nav items, pressed buttons, and cards. Both theme values are the minimum darkening (same hue/saturation, WCAG relative-luminance formula, not eyeballed) off Apple's own system blue that clears 4.5:1 as white button text: dark theme's `#0A84FF` only cleared 3.65:1 on its own; light theme's `#007AFF` only cleared 4.02:1.

### Status — one meaning each
- **Live Red** (`#ff453a` dark / `#ff3b30` light): the one and only "this is live right now" signal — the live dot, nothing else. Matches the near-universal recording-indicator convention (camcorder tally lights, video-call recording dots) and, now that blue carries "selected," can never be confused with it the way a shared accent could. A pulsing dot has no text-contrast requirement to audit; the value is Apple's own dark/light system red, used as-is.
- **Armed Green** (`#34d399` dark / `#048059` light): "this succeeded, this is healthy, this is connected" — a passed connection test, an "ok" status badge, a success toast. This is the exact value the single accent used to carry pre-redesign (already WCAG-AA audited: the original `#059669` cleared only 3.77:1 as white button text and 3.45:1 as text-on-background, both under the 4.5:1 AA floor; `#048059` is the minimum darkening that clears 4.5:1 in both roles) — narrowed to this one meaning now that it no longer also means "selected" or "live." Text-on-fill uses **Armed Green Ink** (`#052e22` dark / `#fff` light); the wash is **Armed Green Soft** (`rgba(52,211,153,.14)` dark / `rgba(4,128,89,.12)` light).
- **Tamper Purple** (`#bf5af2` dark / `#af52de` light): tamper events specifically, where they get their own themed treatment (distinct from the On-Video family's fixed `--ov-danger` used for tamper/video-loss badges painted on footage — see below). Previously tamper reused Danger Red directly; purple keeps "a camera was physically tampered with" visually distinct from both "a destructive action" and "this is live."

### Neutral — "Gunmetal Night"
Cool, dark blue-black grays that carry almost the entire UI; the light theme swaps in an equivalent light gray-blue family at the same structural roles.
- **Gunmetal Bg** (`#0b0e13` dark / `#f3f5f8` light): app background, input fields.
- **Gunmetal Panel** (`#131820` dark / `#fff` light): topbar, sidebars, cards, dialogs, menus — the primary raised surface.
- **Gunmetal Panel-2** (`#1a2029` dark / `#f0f3f7` light): secondary surface for buttons, pills, and nested controls sitting on a panel.
- **Gunmetal Line / Line-2** (`#262e3a` / `#313b4a` dark, `#dfe4ec` / `#c9d1dd` light): hairline dividers and borders; Line-2 is the stronger, hover/focus-adjacent border.
- **Text Primary** (`#e7ebf1` dark / `#16202e` light): body and heading text.
- **Text Muted** (`#8b97a8` dark / `#5d6b7e` light): secondary text, labels, hints, inactive nav.
- **Text Faint** (`#5c6878` dark / `#808ea0` light): placeholder-level text, disabled/empty-state icons, inactive dots. Light theme's value was audited and darkened from an earlier `#8f9bab` (2.58:1 against the light background, below even the lenient 3:1 UI-component floor) to `#808ea0` (3.05:1) — dark theme's value already cleared AA.
- **Video Tile** (`#05070a`, same in both themes): the near-black backdrop behind every camera tile and video stage — always darker than the surrounding chrome so footage reads as the visual floor of the screen.

### Semantic
- **Warn Amber** (`#fbbf24` dark / `#b45309` light): warning states only (e.g. a pending/waiting connection dot, storage-pool warnings).
- **Danger Red** (`#f87171` dark / `#da2323` light) + **Danger Red Soft** wash: destructive actions, offline/error states, form validation errors. Light theme's value was audited and darkened from `#dc2626` (4.42:1 against the light background, just under the 4.5:1 AA floor) to `#da2323` (4.53:1).
- **Info Teal** (`#2dd4bf` dark / `#0d9488` light): reserved, low-frequency informational accent — not actually used anywhere in the UI yet. Shifted off its original blue (`#60a5fa`/`#2563eb`) in redesign v2 specifically because that blue now collides with Accent Blue; teal keeps it genuinely distinct whenever something does reach for it.

### On-Video Overlay (theme-invariant)
Chrome painted directly over live camera footage — tile/focus overlays, event badges, ROI boxes, playback's floating transport buttons. The video underneath never re-themes, so this whole family is fixed across light and dark rather than switching with the rest of the UI — switching would read as broken, not adaptive. Consolidated here (audited, not assumed) from what were several slightly-different ad-hoc opacities scattered through the stylesheet; every value is unchanged, only centralized and named.
- **Ov Scrim Soft / Ov Scrim / Ov Scrim Strong** (`rgba(0,0,0,.4)` / `.5` / `.55`): gradient washes and dark overlays behind on-video text and controls (tile name bar, event veils, ROI dimming).
- **Ov Ink / Ov Ink Dark** (`#fff` / `#052e22`): text/icon color on the dark chips and badges above (tile action buttons, event badges, nav arrows, pane labels) — Ov Ink Dark is the rare exception for a *bright* on-video badge (the motion event badge, `--ev-motion` gold) where white text fails contrast outright (1.92:1); it's its own theme-invariant token rather than reusing a themed ink color, since those flip to white in light theme and would fail the exact same way there too. Ov Ink is not used for the toggle switch's knob, which is a separate, non-video, always-white UI element.
- **Ov Btn Bg / Ov Btn Bg Hover** (`rgba(255,255,255,.08)` / `.16`): translucent white button fills for controls floating on video (playback's transport bar, `.tag`).
- **Ov Roi** (`rgba(59,130,246,.12)`): the draggable region-of-interest box fill (frame enhancer, Playback).
- **Ov Danger** (`#dc2626`): tamper/video-loss event badges specifically — fixed rather than reusing Danger Red, since a badge over a clip shouldn't shift color when the operator's app theme does, and this predates (and no longer numerically matches) either theme's Danger Red.
- **Scrim** (`rgba(0,0,0,.55)`): the *general* modal backdrop (dialogs) — a different concept from the family above (dims the whole page behind a modal, not chrome painted on video) that happens to share Ov Scrim Strong's exact value today; kept as its own token so the two can diverge later without one dragging the other.

### Qualitative — Timeline
Event-kind and per-camera-lane colors on the canvas-drawn timeline (`timeline.js`). Categorical, not semantic state, so — like the on-video family above — these intentionally stay the same in both themes: their job is telling lanes/kinds apart, not matching a light/dark mood. Defined as CSS custom properties (`--ev-motion`, `--ev-videoloss`, `--ev-bookmark`, `--cam-1..4`) and read via `getComputedStyle` at draw time rather than baked into the canvas code as hex literals.
- **Ev Motion** (`#eab308`): motion event spans.
- Line-crossing / intrusion / tamper events reuse **Danger Red** directly (already the exact value) rather than a duplicate token.
- **Ev Video-loss** (`#6b7280`): video-loss event spans.
- **Ev Bookmark** (`#22d3ee`): the bookmark flag glyph.
- **Cam 1-4** (`#60a5fa`, `#f472b6`, `#34d399`, `#fb923c`): the left-edge lane-identity dot when more than one camera's events share the timeline.

### Named Rules
**The On-Video Invariance Rule.** Anything painted directly over live footage (badges, overlays, ROI boxes, floating transport controls) stays fixed across light/dark theme — the video itself never re-themes, so its chrome shouldn't either. Everything else in this document does adapt per theme; this is the one deliberate exception.
**The One-Job-Per-Color Rule.** Accent Blue is the only color used for emphasis, selection, or primary action — if a control isn't active, selected, or the primary action in its group, it does not get colored, it stays gunmetal/muted. Live Red, Armed Green and Tamper Purple are each scoped the same way to their own single status meaning; none of the four ever stands in for another, and none is used decoratively.

## Typography

**Body/UI Font:** the system font (`-apple-system`/San Francisco on macOS and iOS, Segoe UI on Windows, Roboto on Android/ChromeOS), falling back to Inter on anything with none of those — redesign v2, was Inter alone.

**Character:** One typeface for everything — no serif, no display face, no mono except for the odd `<kbd>` hint. The hierarchy is carried entirely by size, weight, and color (muted vs. primary text), not by a second font.

### Hierarchy
- **Title** (600, 20px, 1.3 line-height): pane headings (`.pane h1`). Smaller title-weight text (600, 19px / 15px) is reused for card-scale headings like empty-state and focus-view titles.
- **Body** (400, 14px, 1.45 line-height): the base UI size — nearly everything reads at or near this size.
- **Small** (400, 13px): the system's actual secondary-text size — hints, sub-labels, result rows, muted supporting lines under a heading. Sits one step below Body; audited and normalized here after being the single most-repeated undocumented size in the implementation (17 uses).
- **Micro** (600, 11px): compact badges and tags (`.tag`, event badges) where Label's 12px/uppercase treatment would be too loud for a small pill sitting on video.
- **Label** (700, 12px, 1.2 line-height, `0.04em` uppercase tracking): section labels, table headers, form group labels — always uppercase, always this weight, wherever the UI needs a small structural header.

### Named Rules
**The Tabular Numbers Rule.** Every numeric read-out — the clock, timestamps, durations, zoom percentage, event counts — uses `font-variant-numeric: tabular-nums`, so digits never shift width as they change on a screen meant to be glanced at repeatedly.

## Layout

A fixed-header, fill-the-viewport shell: a 52px topbar, then a flex-1 body that owns the rest of the screen (`overflow: hidden` on `html`/`body` — the app never scrolls as a whole page; individual panes scroll internally). Settings and Playback use a fixed-width side rail (210px / 232px, collapsing to a horizontal strip under ~800px) next to a fluid main pane. The live grid is a CSS grid sized to fill available space with a 4px gutter; video tiles keep their real aspect ratio via `aspect-ratio` + container queries rather than letterboxing crudely.

Spacing is tight and functional rather than airy: card padding is 18–20px, pane padding 22–28px, control gaps mostly 6–14px. Responsive behavior collapses side rails and multi-column forms to single columns around 760–900px, and hides secondary chrome (clock, nav labels) below 800px rather than wrapping it.

## Elevation & Depth

Flat at rest. Panels, cards, tiles, and the topbar sit at the same visual depth as their background — a single 1px border (`Gunmetal Line`) is the only separation, no shadow. Depth is otherwise reserved for layers that float above the normal document flow (popover menus, modal dialogs, toasts, the settings save bar) and, since redesign v2, for the one in-flow element that lifts in direct response to a pointer: a hovered live-grid tile.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 10px 30px rgba(0,0,0,.45)` dark / `0 10px 30px rgba(16,24,40,.14)` light): the floating-chrome shadow. Used on `.menu`, `.dialog`, `.toast`, the settings `.savebar`, and small floating pills (zoom tag, jump-to-playhead) that need to read above video content.
- **Hover-Lift** (`--shadow-float`; `box-shadow: 0 14px 32px -6px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4)` dark / `0 14px 32px -6px rgba(16,24,40,.22), 0 2px 10px rgba(16,24,40,.14)` light, paired with `transform: translateY(-2px)`): a live-grid tile under a real pointer (`.tile:hover`, gated on `(hover: hover)` so it never half-triggers on touch). Distinct from Float — this is in-flow content responding to attention, not chrome floating above the layout — hence its own token rather than reuse of Float.

### Named Rules
**The Floating-Only Shadow Rule.** If it's part of the normal page layout at rest, it's flat with a border. A layer floats above the page (menu, dialog, toast, save bar) → Float. A live-grid tile has the pointer directly on it → Hover-Lift, and only while the pointer stays there. Nothing else gets a shadow.

## Shapes

A small, consistent radius scale rather than one blanket value. Containers get a modest, soft-technical radius; anything representing status or a compact selectable chip goes fully round.

- **Extra-small — 5-6px:** the smallest interactive chips (`.tag`, `kbd`, `.grip`, OCR result rows) — one step down from Small, for elements too compact for even a small-button radius.
- **Small-tight — 7px:** compact interactive rows and small buttons one step under Small — `.seg button`, `.tile-actions button` (video overlay controls), `.cal-day`, `.events-presets button`. Audited and normalized here after being the second most-repeated undocumented radius (5 uses).
- **Small — 8px:** buttons, inputs, the brand mark square.
- **Small-wide — 9px:** containers a touch softer than Small but not yet Medium — `.seg`/`.pb-macros` (segmented-control and toolbar-cluster wrappers), `.result`, `.ev-row`. Audited and normalized here after being the third most-repeated undocumented radius (4 uses).
- **Medium — 10px:** video tiles, layout-option buttons, generic small containers (the system's default, `--r`).
- **Large — 12px:** cards, popover menus, event cards.
- **Extra-large — 14px:** modal dialogs, the AI-enhancer's larger popovers.
- **Full (999px):** pills, tags, badges, the theme/quality segmented-control thumb, the toggle switch track and knob.

### Named Rules
**The Pill-for-Status Rule.** Full-round shape is reserved for things that represent state or a compact choice (status pills, event badges, quality tags, toggles). Containers that hold content — cards, tiles, dialogs — never go fully round; they stay in the 8–14px range.

## Components

Controls stay compact and restrained: real but understated hover/pressed feedback (brightness lift, accent-soft wash, ring outline) rather than large motion or decoration — refined, not flashy.

### Buttons
- **Shape:** 8px radius, 34px height (28px in the `.sm` variant), icon-only variants are square (34px/28px).
- **Primary:** Accent Blue background, Accent Blue Ink (white) text, 600 weight — the one emphasized action in a group.
- **Secondary (default `.btn`):** Gunmetal Panel-2 background, 1px Gunmetal Line-2 border, primary text color.
- **Ghost:** transparent background and border, muted text; fills to Panel-2 + primary text on hover.
- **Hover / Pressed:** primary brightens (`filter: brightness(1.08)`); secondary/ghost border or background shifts toward Line/Panel-2; a toggled/pressed button (`aria-pressed="true"`) takes the Accent Blue Soft wash with an Accent Blue border and text.

### Pills, Tags & Badges
- **Pill (status chip):** Panel-2 background, 1px Line border, full radius, muted text, 24px tall — used for connection status, quality/HD tags on tiles, and filter-active indicators.
- **Event Badge:** solid, slightly translucent dark chip (`rgba(15,20,28,.82)` + blur) that floats over video — Ev Motion gold (with dark Ov Ink Dark text, the one badge that needs it) for motion, Ov Danger red for tamper/video-loss, amber-orange for line-crossing. White text otherwise, since it sits on live footage.
- **Toggle Switch:** 38×22px full-round track, Line-2 when off, Accent Blue when on, white knob — the only binary control style in the system (no separate checkbox skin for on/off settings).

### Cards / Containers
- **Corner Style:** 12px radius.
- **Background:** Gunmetal Panel on Gunmetal Bg.
- **Shadow Strategy:** none — flat, per Elevation & Depth.
- **Border:** 1px Gunmetal Line.
- **Internal Padding:** 18px top/bottom, 20px sides.

### Inputs / Fields
- **Style:** Gunmetal Bg background, 1px Line-2 border, 8px radius, 36px height.
- **Focus:** system focus ring (2px Accent Blue outline, 2px offset) via `:focus-visible`.
- **Hover:** border brightens to Faint.
- **Error / Disabled:** invalid inputs get a Danger Red border; disabled inputs drop to 50% opacity with a Panel-2 fill.

### Navigation
- **Style:** flat icon+label links, 8px radius, muted text at rest, Accent Blue Soft background + Accent Blue text when the current page (`aria-current="page"`) — same active-state language used across topbar nav, settings side rail, and segmented view controls.

### Signature Component — The Eye Mark
A 26×26px dark square (Gunmetal `#111827`, 8px radius) containing a ring-and-dot iris drawn entirely in Accent Blue (2.5px ring, solid center dot) — the product's mark, reused unchanged as the browser favicon. It's the only place the accent is used purely as identity rather than state, and it should stay that way: a single blue iris on a dark square, nothing more.

## Do's and Don'ts

### Do:
- **Do** treat each of the four semantic colors as a state signal first — reach for Accent Blue when something is selected, primary, or on; Live Red only for live status; Armed Green only for success/healthy; never as general brand color to sprinkle around.
- **Do** keep numeric displays (clocks, timestamps, durations, percentages, counts) on tabular numerals.
- **Do** keep containers flat with a 1px border; reserve the Float shadow strictly for popovers, dialogs, toasts, and the save bar.
- **Do** use full-round shape only for status/selection chips and toggles, never for content containers.

### Don't:
- **Don't** introduce a fifth semantic hue for "brand" purposes — warn-amber, danger-red and info-teal stay semantic-only, and the four redesign-v2 colors already cover interactive/live/success/event-category meaning between them.
- **Don't** add shadow to any surface that's part of the normal page flow (cards, tiles, panels, topbar) — that's reserved for floating layers only.
- **Don't** add a display/hero type size anywhere; this is an Operate-mode instrument panel, not a marketing surface, and the type scale stays functional.
- **Don't** widen the touch/click targets or padding much past the current compact scale (28–36px control heights) — density is a deliberate trait of a screen meant for long monitoring sessions, not a gap to close.
