---
name: Sentinel Eye
description: A dark, calm operations dashboard for watching and reviewing your own Hikvision cameras — solid app chrome and neutral floating controls over a graphite ground, one accent color reserved for "this is interactive."
colors:
  accent-blue: "#0074e8"
  accent-blue-text: "#2e97ff"
  accent-blue-ink: "#ffffff"
  accent-blue-soft: "rgba(0, 116, 232, 0.16)"
  live-red: "#ff453a"
  live-red-soft: "rgba(255, 69, 58, 0.16)"
  armed-green: "#30d158"
  armed-green-text: "#30d158"
  armed-green-ink: "#06220f"
  armed-green-soft: "rgba(48, 209, 88, 0.14)"
  tamper-purple: "#bf5af2"
  tamper-purple-soft: "rgba(191, 90, 242, 0.16)"
  graphite-bg: "#09090b"
  graphite-panel: "#18181b"
  graphite-panel-2: "#222226"
  graphite-line: "rgba(255, 255, 255, 0.09)"
  graphite-line-2: "#2c2c31"
  text-primary: "#f5f5f7"
  text-muted: "#a1a1a6"
  text-faint: "#6e6e73"
  warn-amber: "#ffd60a"
  danger-red: "#f87171"
  danger-red-soft: "rgba(248, 113, 113, 0.14)"
  info-teal: "#2dd4bf"
  video-tile: "#060608"
  glass-fill: "rgba(28, 28, 31, 0.66)"
  glass-fill-heavy: "rgba(18, 18, 20, 0.86)"
  glass-border: "rgba(255, 255, 255, 0.1)"
  glass-highlight: "rgba(255, 255, 255, 0.06)"
  scrim: "rgba(0, 0, 0, 0.55)"
  ov-scrim-soft: "rgba(0, 0, 0, 0.4)"
  ov-scrim: "rgba(0, 0, 0, 0.5)"
  ov-scrim-strong: "rgba(0, 0, 0, 0.55)"
  ov-ink: "#fff"
  ov-ink-dark: "#052e22"
  ov-roi: "rgba(59, 130, 246, 0.12)"
  ov-btn-bg: "rgba(255, 255, 255, 0.08)"
  ov-btn-bg-hover: "rgba(255, 255, 255, 0.16)"
  ev-motion: "#ff9f0a"
  ev-line: "#0a84ff"
  ev-videoloss: "#8e8e93"
  ev-bookmark: "#e5e5ea"
  tl-rec: "#2a2a2f"
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
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "22px"
  xl: "30px"
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
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-secondary:
    backgroundColor: "{colors.graphite-panel-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  pill-status:
    backgroundColor: "{colors.graphite-panel-2}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.full}"
    height: "24px"
    padding: "0 9px"
  card:
    backgroundColor: "{colors.graphite-panel}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
---

# Design System: Sentinel Eye

## Overview

**Creative North Star: "The Watch Room, Redesigned"**

Redesign v2 (see `ROADMAP.md`) rebuilt the Watch Room three times. The third pass rebuilt every screen to its design board — one bar per screen (Live is home with the brand mark and the global cluster; every other screen leads with a back chevron and carries its own context), Playback, Export, Verify, Events, Settings, Account, Sign in, Pairing, the AI Frame Enhancer, TV mode and the phone/iPad layouts — on the foundation described below. Before that, The first pass kept the pre-redesign app's dense, flat, blue-tinted architecture and only swapped its single accent color for four single-job colors. The second, larger pass — this one — rebuilt the foundation itself to actually match the approved mockups: a neutral graphite ground (not blue-tinted), glass material on floating and page chrome (not flat panel fills), a bigger and rounder radius scale topped out by fully-pill buttons (not an 8px-radius rectangle), and real press feedback. The calm, low-contrast, stare-at-it-for-hours character survives intact — spacing stays tight, numbers stay tabular, the interface still gets out of the way of the footage it exists to show — but the material language is now genuinely Apple-adjacent rather than merely re-colored.

Four colors, four jobs: a system blue for everything interactive (selected, primary, focus, in progress), red for "this is live right now," green for "this succeeded / is healthy," and purple for tamper events specifically. Status and selection never compete for the same pixel the way a single accent used to force them to.

The foundation history above describes redesign v2. The adaptive-v13 material, navigation and input contract below supersedes its broad glass treatment and large destination headers. Destination selection now uses a neutral raised surface; blue remains for primary actions, interactive focus and selected editing controls.

**Key Characteristics:**
- Dark by default (`color-scheme: dark`), with a fully-specified light theme as a first-class alternate, not an afterthought.
- Four semantic colors, each with exactly one job: blue = interactive, red = live, green = success/healthy, purple = tamper. Never mixed, never decorative.
- Solid themed chrome for headers, docked tools, navigation, menus, dialogs and authentication. Floating viewer controls use a dark media plate; footage retains its own colors in either theme. Transient notification effects retain their existing treatment.
- A six-step radius scale running from a 6px chip to a fully-round 999px pill — buttons, segmented controls and status pills are pills now, not rounded rectangles.
- Small functional type: consistent 16px desktop header titles, 22px compact titles, and larger section headings. TV text and targets grow for distance. No hero/display type.
- Tabular numerals on every timestamp, clock, duration, zoom percentage, and count.

## Colors

A near-monochrome graphite UI with four semantic hues, each scoped to exactly one meaning — never decorative, never doubled up.

### Primary — interactive
- **Accent Blue** (`#0074e8` dark theme / `#0072ef` light theme): primary button fills, selected/active nav and tabs' background wash, focus rings, the layout/quality picker's pressed-state border, drag-target highlight, zoom badge fill — anything that is a *filled* interactive surface. Text-on-accent is white (**Accent Blue Ink**, `#ffffff`) in both themes. Both fill values are the minimum darkening (same hue/saturation, WCAG relative-luminance formula) off Apple's own system blue that clears 4.5:1 as white button text.
- **Accent Blue Text** (`#2e97ff` dark / `#0061cc` light): the same blue used as *foreground* — nav-link text, a pressed chip's label, an icon-only link — rather than as a fill. A separate, necessarily brighter/darker token: `#0074e8`/`#0072ef` were solved for white text sitting *on* them, and only clear 3.0–4.4:1 when used the other way round, as text sitting on Accent Blue Soft or directly on a panel. Accent Blue Text clears 4.5:1 against every surface it actually appears on (Accent Blue Soft composited over any of Graphite Bg/Panel/Panel-2, and each of those surfaces directly) — verified by computing contrast against each pairing, not assumed from the fill color passing a different test. A low-opacity wash, **Accent Blue Soft** (`rgba(0,116,232,.16)` dark / `rgba(0,114,239,.12)` light), marks the "currently selected/active" background for nav items, pressed buttons, and cards, with Accent Blue Text as its text color.

### Status — one meaning each
- **Live Red** (`#ff453a` dark / `#ff3b30` light): the one and only "this is live right now" signal — the live dot, nothing else. A pulsing dot has no text-contrast requirement to audit; the value is Apple's own dark/light system red, used as-is.
- **Armed Green** (`#30d158` dark — Apple's system green, per the Design Language board / `#048059` light): "this succeeded, this is healthy, this is connected" — a passed connection test, an "ok" status badge, the Status page's "video engine running" indicator, a success toast. As text-on-fill it's **Armed Green Ink** (`#06220f` dark / `#fff` light); the wash is **Armed Green Soft** (`rgba(48,209,88,.14)` dark / `rgba(4,128,89,.12)` light). As *foreground on the wash* (e.g. a success badge's label) dark theme reuses `#30d158` directly (already 6.2–7.1:1 there); light theme needs its own darkened **Armed Green Text** (`#04724f`, was 3.8–4.2:1 on the composited wash, under AA — now 4.55+), the same fill-vs-text split Accent Blue needed.
- **Tamper Purple** (`#bf5af2` dark / `#af52de` light): tamper events specifically, where they get their own themed treatment (distinct from the On-Video family's fixed `--ov-danger` used for tamper/video-loss badges painted on footage — see below). Purple keeps "a camera was physically tampered with" visually distinct from both "a destructive action" and "this is live."

### Neutral — "Graphite"
Neutral, cool-grey surfaces that carry almost the entire UI — true neutral, not blue-tinted (redesign v2's foundation pass: the previous "Gunmetal" family measurably leaned blue, which read as "a dark blue app" rather than "glass over black"). The light theme swaps in an equivalent light grey family at the same structural roles.
- **Graphite Bg** (`#09090b` dark / `#f2f2f5` light): app background, input fields.
- **Graphite Panel** (`#18181b` dark / `#fff` light): cards, dialogs, menus and authentication — the primary raised surface. Navigation and docked chrome use opaque fills; transient toasts retain their existing glass treatment.
- **Graphite Panel-2** (`#222226` dark / `#f2f2f5` light): secondary surface for buttons, pills, and nested controls sitting on a panel. In light theme this equals Graphite Bg rather than a separate near-white tone — a hover/pressed surface reading as "a step toward the ground," the same relationship the mockups' own minimal-tonal-range Daylight theme uses.
- **Graphite Line / Line-2** (`rgba(255,255,255,.09)` / `#2c2c31` dark, `rgba(0,0,0,.08)` / `#e3e3e8` light): hairline dividers and borders. Line is translucent-over-whatever's-behind-it (true glass-era hairline, not a solid gray); Line-2 is the stronger, solid, hover/focus-adjacent border.
- **Text Primary** (`#f5f5f7` dark / `#1d1d1f` light): body and heading text.
- **Text Muted** (`#a1a1a6` dark / `#6e6e73` light): secondary text, labels, hints, inactive nav.
- **Text Faint** (`#6e6e73` dark / `#8b8b91` light): placeholder-level text, disabled/empty-state icons, inactive dots. Re-audited against the graphite ground in the foundation pass — light theme's first attempt (`#aeaeb2`, carried over from the old Gunmetal-era audit) measured as low as 1.98:1 against the new, slightly darker ground, well below even the lenient 3:1 UI-component floor; `#8b8b91` clears 3.0–3.4:1 everywhere it's used. Dark theme's value needed no change.
- **Video Tile** (`#060608`, same in both themes): the near-black backdrop behind every camera tile and video stage — always darker than the surrounding chrome so footage reads as the visual floor of the screen.

### Semantic
- **Warn Amber** (`#ffd60a` dark — the board's Caution yellow / `#b35309` light): warning states only (e.g. a pending/waiting connection dot, storage-pool warnings). Light theme's value was re-audited against the new ground and darkened a touch from `#b45309` (4.49:1, just under AA) to `#b35309` (4.52:1).
- **Danger Red** (`#f87171` dark / `#d72323` light) + **Danger Red Soft** wash: destructive actions, offline/error states, form validation errors. Light theme's value was re-audited against the new ground and darkened a touch from `#da2323` (4.43:1, just under AA against the new, slightly lighter ground) to `#d72323` (4.52:1).
- **Info Teal** (`#2dd4bf` dark / `#0d9488` light): reserved, low-frequency informational accent — not actually used anywhere in the UI yet.

### Chrome and media materials
The adaptive-v13 contract replaces the foundation's broad glass treatment with opaque structural surfaces. Headers, normal Playback transport/timeline and save controls use `--chrome-bg`; menus, dialogs, authentication and phone navigation use Panel. Installed Apple headers retain the accepted stationary status-area surface.

Floating Focus/replay controls, immersion transport and permanent return controls use the theme-invariant `--media-plate` (`#18181b`) with light media text. Navigation arrows and small existing on-video badges retain their local scrims. Legacy Glass Fill/Fill Heavy/Border/Highlight tokens remain for transient notifications and compatibility; they do not define the page header, navigation or forms.

### On-Video Overlay (theme-invariant)
Chrome painted directly over live camera footage — tile/focus overlays, event badges, ROI boxes, playback's floating transport buttons. The video underneath never re-themes, so this whole family is fixed across light and dark rather than switching with the rest of the UI.
- **Ov Scrim Soft / Ov Scrim / Ov Scrim Strong** (`rgba(0,0,0,.4)` / `.5` / `.55`): gradient washes and dark overlays behind on-video text and controls (tile name bar, event veils, ROI dimming).
- **Ov Ink / Ov Ink Dark** (`#fff` / `#052e22`): text/icon color on the dark chips and badges above (tile action buttons, event badges, nav arrows, pane labels) — Ov Ink Dark is the rare exception for a *bright* on-video badge (the motion event badge, `--ev-motion` gold) where white text fails contrast outright (1.92:1).
- **Ov Btn Bg / Ov Btn Bg Hover** (`rgba(255,255,255,.08)` / `.16`): translucent white button fills for controls floating on video (playback's transport bar, `.tag`).
- **Ov Roi** (`rgba(59,130,246,.12)`): the draggable region-of-interest box fill (frame enhancer, Playback).
- **Ov Danger** (`#dc2626`): tamper/video-loss event badges specifically — fixed rather than reusing Danger Red.
- **Scrim** (`rgba(0,0,0,.55)`): the *general* modal backdrop (dialogs) — a different concept from the family above (dims the whole page behind a modal, not chrome painted on video).

### Qualitative — Timeline
Event-kind and per-camera-lane colors on the canvas-drawn timeline (`timeline.js`). Categorical, not semantic state, so these intentionally stay the same in both themes. Defined as CSS custom properties (`--ev-motion`, `--ev-videoloss`, `--ev-bookmark`, `--cam-1..4`) and read via `getComputedStyle` at draw time.
- **Ev Motion** (`#ff9f0a`): motion event spans, the motion tile ring and pill. The playhead itself is a small white rounded handle with a drop shadow (redesign v2 — was an accent-colored flag), so it reads as "the scrubbable grip" against every lane color it crosses rather than blending into whichever lane shares its hue.
- **Ev Line** (`#0a84ff`): line-crossing and intrusion. Tamper uses **Tamper Purple**.
- **Ev Video-loss** (`#8e8e93`): video-loss event spans.
- **Ev Bookmark** (`#e5e5ea` dark / `#6e6e73` light): the bookmark flag glyph.
- **Timeline Recorded** (`--tl-rec`, `#2a2a2f` dark / `#e3e3e8` light): recorded spans on the coverage lane; gaps are hatched.
- **Cam 1-4** (`#60a5fa`, `#f472b6`, `#34d399`, `#fb923c`): the left-edge lane-identity dot when more than one camera's events share the timeline.

### Named Rules
**The On-Video Invariance Rule.** Anything painted directly over live footage (badges, overlays, ROI boxes, floating transport controls) stays fixed across light/dark theme and never gets glass/blur — the video itself never re-themes and is itself the "material" there.
**The One-Job-Per-Color Rule.** Accent Blue is the only color used for emphasis, selection, or primary action — if a control isn't active, selected, or the primary action in its group, it does not get colored, it stays graphite/muted. Live Red, Armed Green and Tamper Purple are each scoped the same way to their own single status meaning; none of the four ever stands in for another. A mode-switch button whose own label already states which mode you're in (e.g. the live view's Overview/Grid toggle) is *not* a "selected option" and does not get the pressed-accent treatment, even though it sets `aria-pressed` for assistive tech — that treatment means "this is the choice among several," not "this button is currently on."
**The Fill-vs-Text Rule.** A semantic color has two numerically distinct values when it's used both as a filled background (optimized for white/ink text on top of it) and as foreground text elsewhere (Accent Blue vs. Accent Blue Text, Armed Green vs. Armed Green Text in light theme) — never assume a fill color passes as text just because the fill itself is accessible.

## Typography

**Body/UI Font:** the system font (`-apple-system`/San Francisco on macOS and iOS, Segoe UI on Windows, Roboto on Android/ChromeOS), falling back to Inter on anything with none of those.

**Character:** One typeface for everything — no serif, no display face, no mono except for the odd `<kbd>` hint. The hierarchy is carried entirely by size, weight, and color (muted vs. primary text), not by a second font.

### Hierarchy
- **Large Title** (600–700, 22–24px): compact route titles and Settings section headings.
- **Title** (600, 16–20px): consistent desktop screen-bar titles, card headings, empty states and Focus titles. Settings panes retain their section heading and explanatory text.
- **Body** (400, 14px, 1.45 line-height): the base UI size — nearly everything reads at or near this size.
- **Small** (400, 13px): the system's actual secondary-text size — hints, sub-labels, result rows, muted supporting lines under a heading.
- **Micro** (600, 11px): compact badges and tags (`.tag`, event badges) where Label's 12px/uppercase treatment would be too loud for a small pill sitting on video.
- **Label** (700, 12px, 1.2 line-height, `0.04em` uppercase tracking): section labels, table headers, form group labels.

### Named Rules
**The Tabular Numbers Rule.** Every numeric read-out — the clock, timestamps, durations, zoom percentage, event counts — uses `font-variant-numeric: tabular-nums`, so digits never shift width as they change on a screen meant to be glanced at repeatedly.

## Layout

A viewport-filling shell with one shared header per screen (`bar.js`). Main desktop headers use the same 60 px height. Left to right: title/context, page actions, four destinations, notifications, Account. Tablet headers wrap context onto a separate row when needed. Compact touch windows use the same four destinations in a bounded floating bottom capsule; notifications and Account remain in the header. Compact means width ≤640 px, or touch landscape with height ≤540 px and width ≤1100 px. TV has a distinct larger profile on every route.

The body stays fixed; each workspace owns scrolling. Settings uses a sidebar on wide screens and a grouped section list on phones, with inset dividers and a separate Account row. Compact detail forms and channel tables preserve the same input elements during rotation. Events filters become a scoped sheet. Short Playback keeps a shallow transport and puts precision tools in Timeline and More. Export and enhancement remain editing workspaces with reachable primary actions.

Navigation and save controls share a measured bottom footprint. Installed Apple apps anchor navigation to the full app shell, normalize inflated bottom insets, and preserve the accepted opaque status-area treatment. Browser tabs retain browser-toolbar safe areas. See the validation record for the native-device acceptance boundary.

## Elevation & Depth

App headers and docked review chrome use the same solid theme background. Floating destinations, menus, dialogs, save controls and touch sheets use opaque neutral panels with restrained borders and shadows. Media controls use a dark plate with light text in either theme. In-flow cards stay quiet; moving footage never changes the app's chrome color.

### Shadow Vocabulary
- **Shadow-1** (`0 1px 2px rgba(0,0,0,.4)` dark / `rgba(0,0,0,.08)` light): the lightest lift — reserved for future fine-grained use; not yet wired to any rule.
- **Float** (`--shadow`; `0 10px 30px rgba(0,0,0,.45)` dark / `rgba(16,24,40,.14)` light): the general floating-chrome shadow, paired with Glass fill on most of the surfaces above.
- **Shadow-3** (`0 24px 64px -8px rgba(0,0,0,.55)` dark / `rgba(0,0,0,.16)` light): the heavier lift for Glass-Heavy surfaces (popovers, dialogs, toasts, the save bar, the auth card, touch drawers), usually paired with an inset Glass Highlight top edge.
- **Hover-Lift** (`--shadow-float`; `0 14px 32px -6px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4)` dark / `0 14px 32px -6px rgba(16,24,40,.22), 0 2px 10px rgba(16,24,40,.14)` light, paired with `transform: translateY(-2px)` to `-3px`): a live-grid tile or Events card under a real pointer (gated on `(hover: hover)` so it never half-triggers on touch).

### Named Rules
**The Floating-Only Shadow Rule.** If it's part of the normal page layout at rest, it's flat with a hairline border. A layer floats above or apart from the page → Float or Shadow-3, usually with Glass. A live-grid tile or Events card has the pointer directly on it → Hover-Lift, and only while the pointer stays there. Nothing else gets a shadow.
**The Media Contrast Rule.** Floating viewing controls use a high-contrast dark neutral plate. Auto-hide follows input and editing state, not CSS hover left behind by touch. The protected installed-app header stays opaque and stationary.

## Shapes

A six-step radius scale (redesign v2 foundation — was a denser 8-step 5/7/8/9/10/12/14px scale matching the pre-redesign compact app) running from a 6px chip to a fully-round pill, now that rules actually reference these tokens instead of repeating literal numbers.

- **Extra-small — 6px:** the smallest interactive chips (`.tag`, `kbd`, `.grip`, OCR result rows, `.seg button`'s old scale, small event-preset buttons).
- **Small — 10px:** buttons' icon-square variants in dense contexts, inputs, generic small containers (layout-option buttons, toasts, the zoom/jump popovers).
- **Medium — 16px:** video tiles, Playback panes — the system's default for anything that frames a picture.
- **Large — 22px:** cards, popover menus, event cards.
- **Extra-large — 30px:** modal dialogs, the center-card empty states, the auth card.
- **Full (999px):** buttons, segmented controls, pills, tags, badges, the toggle switch track and knob. Buttons and segmented controls joined this category in the foundation pass — they were an 8/9px rounded rectangle before. The date-picker's day cells (`.cal-day`) use `50%` instead of the token for the same fully-round result on a true 1∶1 square.

### Named Rules
**The Pill-for-Status-and-Action Rule.** Full-round shape is reserved for things you act on or that represent a state — buttons, segmented controls, status pills, event badges, quality tags, toggles. Containers that hold content — cards, tiles, dialogs — never go fully round; they stay in the 16–30px range.

## Components

Controls stay compact and restrained in density, but read as tactile now (redesign v2): real press feedback (`:active { transform: scale(.96) }`, new in the foundation pass — the app had none before), brightness/wash shifts on hover, and restrained depth on floating controls — refined, not flashy, but no longer flat-only.

### Buttons
- **Shape:** full-round pill (redesign v2, was 8px-radius rectangle), 36px height (28px in the `.sm` variant, was 34px), icon-only variants are square (36px/28px).
- **Primary:** Accent Blue background, Accent Blue Ink (white) text, 600 weight — the one emphasized action in a group.
- **Secondary (default `.btn`):** Graphite Panel-2 background, 1px Graphite Line-2 border, primary text color, 600 weight.
- **Ghost:** transparent background and border, muted text; fills to Panel-2 + primary text on hover.
- **Input profiles:** compact targets are at least 44px; TV targets are at least 56px. Destination selection uses a neutral raised surface. Camera More opens a bounded, scrollable menu; hidden inline source controls are inert. Wall actions move below the permanent Exit corner and the TV header rather than covering them.
- **Hover / Pressed:** primary brightens (`filter: brightness(1.08)`); secondary/ghost border or background shifts toward Line/Panel-2; every button presses with `scale(.96)` on `:active`; a toggled/pressed *selection* button (`aria-pressed="true"`) takes the Accent Blue Soft wash with an Accent Blue border and Accent Blue Text — except a mode-switch button like the live view's Overview/Grid toggle, which stays neutral regardless of state (see the One-Job-Per-Color Rule).

### Segmented Controls & Pills
- **Seg (`.seg`):** full-round, borderless, Panel-2 background (redesign v2 — was a bordered 9px-radius rectangle); its buttons are full-round too, with the pressed option taking a Panel background + Shadow-1.
- **Pill (status chip):** Panel-2 background, no border (redesign v2 — border removed), full radius, muted text, 24px tall — used for connection status, quality/HD tags, and filter-active indicators. A compact variant (`.tile-status`, 20px, translucent dark fill) wraps just the live-grid tile's status dot.
- **Event Badge:** solid, slightly translucent dark chip (`rgba(15,20,28,.82)` + blur) that floats over video — Ev Motion gold (with dark Ov Ink Dark text) for motion, Ov Danger red for tamper/video-loss, amber-orange for line-crossing. White text otherwise.
- **Toggle Switch:** 44×26px full-round track, Line-2 when off, Accent Blue when on, white knob with a soft shadow.
- **Row Card (`.srow`):** a titled row with its control on the right — the Settings board's "Stream Encryption" card. Grouped rows join into one inset list (`.srows`) with hairline dividers.
- **Toast:** system messages only (saved, failed, copied) — one glass pill dropping in at the top centre with a filled status glyph; newest on top, at most three, tap to dismiss.
- **Event notification (`notify()`):** something happened on a camera — a Mac-style glass banner under the bar's right end (top centre on a phone): a kind-coloured glyph tile, "Motion · Gate", and a thumbnail of the picture at that moment. Hover holds it, a tap opens the camera, × dismisses; at most three.
- **Zoom HUD (`zoomhud.js`):** wherever a picture zooms (Focus, grid tiles, Playback panes), while zoomed: a minimap with a live thumbnail and the visible part outlined — click or drag it to pan there — and a − / % / + cluster where the percentage resets. Plain dark, not glass.
- **Adjust picture (live filters):** Photos-style — status and Reset, a swipeable preset row, collapsible slider groups in inset cards; a slider's accent fill runs from its resting value to the thumb, and double-click resets it.

- **Instant replay:** looks and behaves like Focus — the picture fills the screen (scaled up as well as down), solid media controls fade while it plays and stay while it's paused; a background tap can explicitly hide them. The bottom bar stays simple: start over and a white round play/pause in the middle, the footage's time and how far behind live it is on the left, Back to live on the right.
- **Focus transitions:** one continuous picture — the tile grows into Focus and shrinks back into its own cell (uniform scale plus a rounded clip, never a stretch); the previous/next camera slides in over a fading still of the last one. Off for reduced motion; a plain fade on TV.
- **AI Frame Enhancer:** pick step — the reference frame (the middle of the selected ones, which the server aligns to) large and centred, or just the region when one is set; under it a strip of up to 11 frames (a yellow dot marks the paused one, a white bar the reference) and the actions. Result step — a before/after wipe; the **ENHANCED** label is an amber strip directly under the picture (never over it), on screen whenever any enhanced pixels are.
### Cards / Containers
- **Corner Style:** 22px radius (redesign v2, was 12px).
- **Background:** Graphite Panel on Graphite Bg — flat, not glass (see Elevation & Depth).
- **Shadow Strategy:** none at rest; Hover-Lift on Events cards specifically, on real pointer hover.
- **Border:** 1px Graphite Line.
- **Internal Padding:** 18px top/bottom, 20px sides.

### Inputs / Fields
- **Style:** filled — Panel-2 background, 1px Graphite Line border, 10px radius, 40px height; labels sit above in Muted 12.5px.
- **Focus:** Accent Blue border with a 3px Accent Blue Soft halo via `:focus-visible`.
- **Hover:** border brightens to Faint.
- **Error / Disabled:** invalid inputs get a Danger Red border; disabled inputs drop to 50% opacity with a Panel-2 fill.

### Navigation
- **Screen bar:** brand mark (Live) or back chevron, title (+ optional subtitle), the screen's own context controls, then its actions; Live alone carries the global cluster (Playback, Events, notifications, Settings, account avatar — locked with an explanation for a viewer, never hidden).
- **Sidebars:** plain icon+label rows; the current one takes a soft Panel-2 fill and primary text, not an accent tint.
- **Tab bar (phones):** four destinations in one neutral floating capsule, with a filled neutral selection; tab-root screens drop their back chevron.
- **TV mode:** its own appearance (Dark by default). The stage is black and the Overview full-bleed; header and hints float over the picture and fade when idle. A remote moves focus spatially (`tvnav.js` — rows stay rows, the end of one turns the page), OK presses, Back steps out (Focus → grid → Overview), Play/Pause switches Overview and grid. Focus style is Apple TV's: the focused control turns white and lifts; the focused camera gets a white ring.

### Live-Grid Tile Anatomy
Redesign-v2 foundation: identity moved from a single top bar to a top/bottom split, matching the mockups.
- **Top-left:** a compact status pill (`.pill.tile-status`) wrapping just the live/wait/off dot — was a bare inline dot next to the name.
- **Top-right (hover-reveal):** the action-button cluster (zoom, snapshot, replay, bookmark, enhance, focus) — unchanged position, already matched the mockups.
- **Bottom bar (always visible, redesign v2 — was hover-only):** camera name on the left, HD/SD quality tag (now full-round) on the right. Only the resolution/fps/codec detail line stays hover-only within this bar — real supplementary detail, not identity.
- Event badges (motion/tamper/video-loss/line) stack directly under the status pill.

### Signature Component — The Eye Mark
A dark rounded tile (`#141417`, radius 30/108) holding a white iris — a ring and a solid pupil — with Live Red's record dot at the upper right. The same drawing is the bar mark, the favicon, the app icons (any, maskable, Apple touch — full-bleed sizes keep it inside the safe zone), the sign-in and pairing mark and the Verify page header. The red dot is the one place Live Red is used as identity, and it stays that way.

## Do's and Don'ts

### Do:
- **Do** treat each of the four semantic colors as a state signal first — reach for Accent Blue when something is selected, primary, or on; Live Red only for live status; Armed Green only for success/healthy; never as general brand color to sprinkle around.
- **Do** use Accent Blue Text / Armed Green Text (not the fill color) whenever a semantic color is the *foreground* of text or an icon rather than a filled background.
- **Do** keep numeric displays (clocks, timestamps, durations, percentages, counts) on tabular numerals.
- **Do** keep containers flat with a hairline border; reserve Float/Shadow-3 strictly for chrome that floats above or sits apart from the page.
- **Do** use full-round shape for buttons, segmented controls, status/selection chips, and toggles — never for content containers (cards, tiles, dialogs stay in the 16–30px range).

### Don't:
- **Don't** put a label, badge or banner over evidence the operator is studying — the enhancer's ENHANCED strip sits under the picture, not on it.
- **Don't** introduce a fifth semantic hue for "brand" purposes — warn-amber, danger-red and info-teal stay semantic-only.
- **Don't** add shadow to any surface that's part of the normal page flow at rest (cards, tiles, panels) — that's reserved for floating layers and the hover-lift exception.
- **Don't** add blur to structural chrome or the protected installed-PWA status area. Hide inactive viewer controls without changing the footage or its player.
- **Don't** ship designer annotations or invented numbers from the boards ("this click simulates…", an estimated size nobody can compute) — when a board shows data the app doesn't have, show what it does have, honestly labelled.
- **Don't** add a display/hero type size anywhere; large titles are as big as it gets — this is an Operate-mode instrument panel, not a marketing surface.
- **Don't** give a mode-switch button (one whose own label already states which mode is active, like Overview/Grid) the pressed-accent treatment — that treatment means "the selected option among several," not "this is currently on."

## Shared viewer contract (adaptive-v13)

Normal review, app immersion, and browser fullscreen share one input policy. A confirmed single background tap toggles controls; double tap, pinch, pan, scrub, crop, OCR, trim, and wipe retain their gesture ownership. Paused playback holds controls by default. Menus/editors hold their owner; hidden chrome is inert, including a tabindex fallback. Keyboard focus pins its controls. TV idle returns focus to the watching surface; wake restores the previous action without activating it.

Installed Apple apps use app immersion for custom video/canvas views. Desktop and TV request browser fullscreen when supported and keep app immersion if denied. The same button, Exit view, or system fullscreen exit restores normal composition in one action; there is no intermediate floating-toolbar state. Playback camera expansion preserves every selected player. An explicit Exit view or Back to live/all cameras remains reachable while other chrome is hidden. Return controls are excluded from the reveal-on-pointer behavior so they cannot disappear on activation. Escape dismisses the innermost layer first. Rotation changes presentation rather than stream/session state.

Local evidence and native acceptance: [adaptive-ui-validation.md](adaptive-ui-validation.md).
