---
name: Sentinel Eye
description: A dark, calm operations dashboard for watching and reviewing your own Hikvision cameras — one accent color reserved for "this is live."
colors:
  sentinel-green: "#34d399"
  sentinel-green-ink: "#052e22"
  sentinel-green-soft: "rgba(52, 211, 153, 0.14)"
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
  info-blue: "#60a5fa"
  video-tile: "#05070a"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
rounded:
  sm: "8px"
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
    backgroundColor: "{colors.sentinel-green}"
    textColor: "{colors.sentinel-green-ink}"
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

**Creative North Star: "The Watch Room"**

Sentinel Eye reads like the inside of a quiet, dark operations room: everything stays low-contrast and still at rest, built to be stared at for long unattended sessions without wearing on the eyes. Nothing is decorative. Spacing is tight, controls are compact (28–36px), numbers are tabular so they don't jitter, and the interface gets out of the way of the footage it exists to show. The one deliberate exception is color: a single accent green means "this is live, this is on, this is selected" everywhere in the app, and it is used sparingly enough that its appearance is always meaningful, never ambient. Amber and red are reserved the same way — warning and danger, never decoration. The whole system is engineered so that when something actually needs attention, it is the only colored thing on the screen.

The controls themselves lean refined rather than purely mechanical: hover and pressed states get real (if subtle) treatment — brightness shifts, soft accent washes, ring outlines — so the density reads as considered, not thrown together.

**Key Characteristics:**
- Dark by default (`color-scheme: dark`), with a fully-specified light theme as a first-class alternate, not an afterthought.
- One accent color, used for state (live/selected/primary), never for branding flourish.
- Flat surfaces at rest; shadow appears only on things that float above the normal layout.
- Small, functional type scale — no hero/display type anywhere; this is an instrument panel, not a marketing page.
- Tabular numerals on every timestamp, clock, duration, zoom percentage, and count.

## Colors

A near-monochrome gunmetal-dark UI with exactly one accent hue. Every other color (amber, red, blue) is semantic, not decorative, and appears only for its specific meaning.

### Primary
- **Sentinel Green** (`#34d399` dark theme / `#048059` light theme): live status, primary buttons, selected/active nav and tabs, focus rings, selection state, "HD" tag, zoom badge. Text-on-accent uses **Sentinel Green Ink** (`#052e22` dark / `#fff` light). A low-opacity wash, **Sentinel Green Soft** (`rgba(52,211,153,.14)` dark / `rgba(4,128,89,.12)` light), marks the "currently selected/active" background for nav items, pressed buttons, and cards. Light theme's value is deliberately darker than dark theme's — audited directly (WCAG relative-luminance formula, not eyeballed): the original `#059669` cleared only 3.77:1 as white button text and 3.45:1 as text-on-background, both under the 4.5:1 AA floor for normal text; `#048059` is the minimum darkening (same hue/saturation) that clears 4.5:1 in both roles.

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
- **Danger Red** (`#f87171` dark / `#da2323` light) + **Danger Red Soft** wash: destructive actions, offline/error states, tamper and video-loss event badges, form validation errors. Light theme's value was audited and darkened from `#dc2626` (4.42:1 against the light background, just under the 4.5:1 AA floor) to `#da2323` (4.53:1).
- **Info Blue** (`#60a5fa` dark / `#2563eb` light): reserved, low-frequency informational accent (kept distinct from Sentinel Green so it never reads as "live").

### Qualitative — Timeline
Event-kind and per-camera-lane colors on the canvas-drawn timeline (`timeline.js`). Categorical, not semantic state, so — unlike every color above — these intentionally stay the same in both themes: their job is telling lanes/kinds apart, not matching a light/dark mood. Defined as CSS custom properties (`--ev-motion`, `--ev-videoloss`, `--ev-bookmark`, `--cam-1..4`) and read via `getComputedStyle` at draw time rather than baked into the canvas code as hex literals.
- **Ev Motion** (`#eab308`): motion event spans.
- Line-crossing / intrusion / tamper events reuse **Danger Red** directly (already the exact value) rather than a duplicate token.
- **Ev Video-loss** (`#6b7280`): video-loss event spans.
- **Ev Bookmark** (`#22d3ee`): the bookmark flag glyph.
- **Cam 1-4** (`#60a5fa`, `#f472b6`, `#34d399`, `#fb923c`): the left-edge lane-identity dot when more than one camera's events share the timeline.

### Named Rules
**The Single Accent Rule.** Sentinel Green is the only color used for emphasis, selection, or primary action. If a control isn't live, active, selected, or the primary action in its group, it does not get colored — it stays gunmetal/muted.

## Typography

**Body/UI Font:** Inter (with `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)

**Character:** One typeface for everything — no serif, no display face, no mono except for the odd `<kbd>` hint. The hierarchy is carried entirely by size, weight, and color (muted vs. primary text), not by a second font.

### Hierarchy
- **Title** (600, 20px, 1.3 line-height): pane headings (`.pane h1`). Smaller title-weight text (600, 19px / 15px) is reused for card-scale headings like empty-state and focus-view titles.
- **Body** (400, 14px, 1.45 line-height): the base UI size — nearly everything reads at or near this size.
- **Label** (700, 12px, 1.2 line-height, `0.04em` uppercase tracking): section labels, table headers, form group labels — always uppercase, always this weight, wherever the UI needs a small structural header.

### Named Rules
**The Tabular Numbers Rule.** Every numeric read-out — the clock, timestamps, durations, zoom percentage, event counts — uses `font-variant-numeric: tabular-nums`, so digits never shift width as they change on a screen meant to be glanced at repeatedly.

## Layout

A fixed-header, fill-the-viewport shell: a 52px topbar, then a flex-1 body that owns the rest of the screen (`overflow: hidden` on `html`/`body` — the app never scrolls as a whole page; individual panes scroll internally). Settings and Playback use a fixed-width side rail (210px / 232px, collapsing to a horizontal strip under ~800px) next to a fluid main pane. The live grid is a CSS grid sized to fill available space with a 4px gutter; video tiles keep their real aspect ratio via `aspect-ratio` + container queries rather than letterboxing crudely.

Spacing is tight and functional rather than airy: card padding is 18–20px, pane padding 22–28px, control gaps mostly 6–14px. Responsive behavior collapses side rails and multi-column forms to single columns around 760–900px, and hides secondary chrome (clock, nav labels) below 800px rather than wrapping it.

## Elevation & Depth

Flat by default. Panels, cards, tiles, and the topbar sit at the same visual depth as their background — a single 1px border (`Gunmetal Line`) is the only separation, no shadow. Depth is reserved entirely for layers that float above the normal document flow: popover menus, modal dialogs, toasts, and the settings save bar all get the same shadow token.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 10px 30px rgba(0,0,0,.45)` dark / `0 10px 30px rgba(16,24,40,.14)` light): the one shadow in the system. Used on `.menu`, `.dialog`, `.toast`, the settings `.savebar`, and small floating pills (zoom tag, jump-to-playhead) that need to read above video content.

### Named Rules
**The Floating-Only Shadow Rule.** If it's part of the normal page layout, it's flat with a border. If it floats above the layout (menu, dialog, toast, save bar), it gets the Float shadow. Nothing in between.

## Shapes

A small, consistent radius scale rather than one blanket value. Containers get a modest, soft-technical radius; anything representing status or a compact selectable chip goes fully round.

- **Small — 8px:** buttons, inputs, the brand mark square.
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
- **Primary:** Sentinel Green background, Sentinel Green Ink text, 600 weight — the one emphasized action in a group.
- **Secondary (default `.btn`):** Gunmetal Panel-2 background, 1px Gunmetal Line-2 border, primary text color.
- **Ghost:** transparent background and border, muted text; fills to Panel-2 + primary text on hover.
- **Hover / Pressed:** primary brightens (`filter: brightness(1.08)`); secondary/ghost border or background shifts toward Line/Panel-2; a toggled/pressed button (`aria-pressed="true"`) takes the Sentinel Green Soft wash with a Sentinel Green border and text.

### Pills, Tags & Badges
- **Pill (status chip):** Panel-2 background, 1px Line border, full radius, muted text, 24px tall — used for connection status, quality/HD tags on tiles, and filter-active indicators.
- **Event Badge:** solid, slightly translucent dark chip (`rgba(15,20,28,.82)` + blur) that floats over video — Sentinel Green for motion, red for tamper/video-loss, amber-orange for line-crossing. White text always, since it sits on live footage.
- **Toggle Switch:** 38×22px full-round track, Line-2 when off, Sentinel Green when on, white knob — the only binary control style in the system (no separate checkbox skin for on/off settings).

### Cards / Containers
- **Corner Style:** 12px radius.
- **Background:** Gunmetal Panel on Gunmetal Bg.
- **Shadow Strategy:** none — flat, per Elevation & Depth.
- **Border:** 1px Gunmetal Line.
- **Internal Padding:** 18px top/bottom, 20px sides.

### Inputs / Fields
- **Style:** Gunmetal Bg background, 1px Line-2 border, 8px radius, 36px height.
- **Focus:** system focus ring (2px Sentinel Green outline, 2px offset) via `:focus-visible`.
- **Hover:** border brightens to Faint.
- **Error / Disabled:** invalid inputs get a Danger Red border; disabled inputs drop to 50% opacity with a Panel-2 fill.

### Navigation
- **Style:** flat icon+label links, 8px radius, muted text at rest, Sentinel Green Soft background + Sentinel Green text when the current page (`aria-current="page"`) — same active-state language used across topbar nav, settings side rail, and segmented view controls.

### Signature Component — The Eye Mark
A 26×26px dark square (Gunmetal `#111827`, 8px radius) containing a ring-and-dot iris drawn entirely in Sentinel Green (2.5px ring, solid center dot) — the product's mark, reused unchanged as the browser favicon. It's the only place the accent is used purely as identity rather than state, and it should stay that way: a single green iris on a dark square, nothing more.

## Do's and Don'ts

### Do:
- **Do** treat Sentinel Green as a state signal first — reach for it when something is live, selected, primary, or on; not as a general brand color to sprinkle around.
- **Do** keep numeric displays (clocks, timestamps, durations, percentages, counts) on tabular numerals.
- **Do** keep containers flat with a 1px border; reserve the Float shadow strictly for popovers, dialogs, toasts, and the save bar.
- **Do** use full-round shape only for status/selection chips and toggles, never for content containers.

### Don't:
- **Don't** introduce a second accent hue for "brand" purposes — amber/red/blue are semantic-only and Sentinel Green already carries all positive/selected/live meaning.
- **Don't** add shadow to any surface that's part of the normal page flow (cards, tiles, panels, topbar) — that's reserved for floating layers only.
- **Don't** add a display/hero type size anywhere; this is an Operate-mode instrument panel, not a marketing surface, and the type scale stays functional.
- **Don't** widen the touch/click targets or padding much past the current compact scale (28–36px control heights) — density is a deliberate trait of a screen meant for long monitoring sessions, not a gap to close.
