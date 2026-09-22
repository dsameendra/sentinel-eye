# Sentinel Eye — Playback & Review: Specification

Status: **DRAFT for approval, round 2** · Author: Claude · Date: 2026-09-22
Round 1 decisions (recorded here): no local video recorder — the DVR is the only video store; milestone order
accepted; multi-operator accounts approved; ML/AI dependencies approved; DVR-config and export are "give me
recommended + possible options" (done in sections 6 and 10); browser floor accepted; the `smartSearch` spike
is approved. Section 11 lists what is still open.

---

## 1. Goals

Let an operator find and review the footage that matters — quickly — from a DS-7208HQHI-K1 (8 analog channels,
encrypted streams, no AcuSense), and export a verifiable clip, all through Sentinel Eye, with no plugin and no
manual DVR menus. The same building blocks improve the live view.

Non-goals: PTZ, audio, two-way talk, cloud sync, mobile apps, editing/re-encoding footage, a second video archive
(the DVR is the one archive — see section 2).

---

## 2. What your DVR actually gives us (measured, not assumed)

Everything below was measured on your DVR with read-only requests, most of it twice, on 2026-09-22.

### 2.1 Recordings

| Fact | Evidence | Consequence |
|---|---|---|
| **Only the main (HD) streams are recorded** (tracks 101…801). Sub-stream tracks 102…802 exist but are disabled. | `record/tracks`; playing `tracks/102` → `400 Bad Request` | **All playback is HD.** There is no recorded SD to fall back to — this matters for how many channels can play at once (2.2). |
| Recording is **continuous 24/7** (`CMR`, schedule type "timing"). No motion-tagged recording. | schedule blocks; search returns only `timing` | The DVR's *recordings* carry no motion metadata by themselves — events come from its **logs** (2.3), a separate system. |
| ~**43 days** of history: **2026-08-10 19:02 → now**, confirmed by querying every month (July: none, August: 10–31, September: 1–22) and the earliest search result. Disk (1 TB) is **full and looping** (0 free, `quota` mode) ⇒ intake ≈ **22 GB/day**. | `dailyDistribution` × 3 months; `search`; `Storage` | The oldest day disappears every day, at roughly the same rate a new day is added. Anything you want to keep past ~43 days has to be exported (section 10) before it rolls off. |
| Search returns **merged spans**, not files (e.g. one span 00:00:00 → 10:57:49). Gaps between spans are real recording holes (power loss, disk swap, etc). | `ContentMgmt/search` | The timeline's "coverage" lane is exact and cheap to draw — a handful of rows per day, not per second. |
| Main streams are **H.265, 1080p (ch 1,3,5,6,7,8) / 720p (ch 2,4), 15 fps**. | probe | Same codec/decrypt path the live view already uses. |

### 2.2 Playback (RTSP) — the number that shapes this whole spec

| Fact | Evidence | Consequence |
|---|---|---|
| Playback is `rtsp://…/Streaming/tracks/<ch>01?starttime=…&endtime=…`, `PLAY` with `Range: clock=…`. Same **AES-128 encryption**, same key — our relay decrypts it unchanged. | decoded a recorded frame end-to-end | No new crypto work. |
| **Hard cap: 4 simultaneous playback sessions.** The 5th request gets `453 Not Enough Bandwidth`, every time, regardless of channel mix. | ladders of 4/5/6/8/12/16 sessions, always exactly 4 succeed | **This is the ceiling for the whole feature**, not a queuing detail: without local recording, **at most 4 channels can play back at once, and every one is HD.** A "16-camera synchronized playback" wall is not physically possible against this DVR. See section 4 for what we build instead. |
| The 4-session cap is **playback-only** — confirmed separately with zero live sessions running (still 4), and with 4 playback sessions held open, all 8 live sessions still connected fine. | isolated re-tests | Watching live video never competes with reviewing recordings; the two use different budgets. |
| Seek inside a session is fast: first frame in **70–100 ms**. `PAUSE`/resume work. | seek test | Scrubbing is smooth for however many channels you have open (≤4). |
| Speed via `Scale:` **⅛×, ¼×, ½×, 1×, 2×, 4×, 8×, 16×** work. **32×/64× → 453 Not Enough Bandwidth.** **Reverse (`Scale: -1`) → 400 Bad Request.** | scale sweep | Reverse play and ≥32× speed do not exist on the wire; we build both ourselves on top of the forward feed (section 5.4–5.5). |
| Playback starts at the **previous keyframe**, 2–9 s before the time you asked for (channel 5 was 9 s early in one test). | requested 20:40:00, on-screen clocks read 20:39:58 / :57 / :49 / :56 across 4 channels | "Frame-exact" seek means: start a bit early, decode forward, discard until the exact target frame. Budget up to ~9 s of throwaway decode per seek. |

### 2.3 Events

| Source | What it contains | Notes |
|---|---|---|
| **Alarm log** (`ContentMgmt/logSearch`) | `motionStart/Stop/<ch>`, `lineDetectionStart/Stop/<ch>`, `hideStart/Stop/<ch>` (camera covered/tampered) | Real, per-channel, timestamped. Example: Sep 21 → 755 entries (motion on ch 1,2,3,7; line-crossing on ch 4 ×156; tamper on ch 1/4). **Hard cap: 2,000 entries per query** (a 10-day query silently returned only Sep 1–5) → we must query per day, and split by hour on any day that hits the cap. |
| **Exception log** | `videoLost/<ch>` (explains recording gaps — e.g. all channels lost video 2026-09-17 14:50:53), `illlegealAccess` (failed logins) | Used to label gaps in the coverage lane with a reason instead of leaving them blank. |
| **Live event stream** (`Event/notification/alertStream`) | Same event types, pushed live, heartbeat ~9 s | Captures events from the moment Sentinel Eye is running, in real time — no polling needed for "now". |
| **Analytics capability** | Line-crossing + intrusion ("field") **supported but disabled** on most channels; face detection is *advertised* in capabilities but returns `403 notSupport` when actually queried — it does not work on this hardware. Motion is enabled per-channel already. | No object attributes, no human/vehicle classification, no face recognition, no plates from the DVR, ever. That is entirely our own AI (section 4.3). |
| **DVR "smart search"** | `isSupportSmartSearch=true`; the endpoint exists (`400 badXmlFormat`, not `404`) but the request schema is undocumented | **Approved spike** (1–2 h): reverse-engineer the request. If it works, region/motion search over the DVR's *entire* 43-day history becomes possible without decoding it ourselves. Section 6.3 covers the fallback either way. |

### 2.4 Timing — the foundation of any synchronised playback

* The DVR's `…Z` timestamps are **DVR local time (UTC+5:30, no DST) mislabelled as Z**. We store UTC internally and convert only at the edges (display, DVR requests).
* Playback carries no RTCP clock, but **RTP timestamps behave as one shared 90 kHz clock across channels and sessions.** Verified at **two moments 13.7 hours apart** (crossing the 32-bit counter's ~13.25 h wrap once), cross-checked against each channel's burned-in clock: offsets matched to within about a frame every time. Not yet proven over days or across a DVR reboot — the calibration is re-checked continuously in M0 and any jump is flagged, never silently absorbed.
* One calibration constant converts an RTP timestamp to an absolute time, accurate to about one frame (67 ms). That is the basis for frame-locked multi-camera playback.

### 2.5 This Mac
Apple M3 Pro, 18 GB RAM, 190 GB free. Not a constraint for a DVR-playback-only design — no large local archive is being written (section 4). Small amounts of disk (event thumbnails, exported clips you choose to keep) are the only storage this feature adds.

### 2.6 Two things that could have broken this spec, checked before writing it down

* **Is the playback engine's foundation (WebCodecs H.265 decode) actually reliable on this DVR's video?** Worth
  asking, because this codebase already found that the *browser's other* HEVC decode path (MSE, used for live
  HD viewing) stutters badly on this DVR's stream — 82 of 149 expected frames over 8 s, half the frames dropped.
  Tested directly: a real 10-second, 149-frame recorded clip from this DVR fed to `VideoDecoder` (`hvc1.1.6.L153.B0`,
  no forced hardware decoder) produced **149 outputs, zero errors, in 315 ms**. Different code path, clean result —
  the playback engine in section 7 is built on it. If a future browser/OS update regresses this, section 7.2 names
  the fallback (server-side transcode, already built for live HD).
* **Is the 4-session cap a true limit, or a bandwidth budget that a slow (1×) session could dodge?** Tested: one
  session at 16× speed plus three at 1× all ran together; a 5th session at plain 1× was still refused. **It's a
  count, not a budget** — section 7.3's plain fair-share queue is correct as written, no per-session speed weighting needed.

---

## 3. Decision recorded: no local video recorder

You don't need a second archive — the DVR's disk already holds ~43 days, and that's enough. Sentinel Eye will
**not** write a continuous copy of any stream to this Mac. Concretely, this changes the shape of several features
versus how they're usually described in CCTV software (which normally assumes an NVR with its own array):

* **All time-shifted playback comes from the DVR**, through the 4-session budget in 2.2. That budget is shared by
  every consumer at once: an operator scrubbing a camera, a second operator reviewing another one, a background
  search scan reading history, and a batch export job. Sentinel Eye queues fairly across all of them and always
  tells you what's queued and why — it never silently fails with the DVR's raw "not enough bandwidth" message.
* **Multi-channel synchronized playback tops out at 4 cameras**, always HD (2.1). Not a Sentinel Eye limit — a
  DVR limit. This directly changes feature 2's original ask ("up to 16+"); see 4.1's alternative for wall-scale review.
* **Search over history that predates our own AI index** relies on the DVR's alarm log (motion/line-crossing/tamper
  — channel-dependent, section 2.3) or a background re-scan through the 4-session queue (section 6.3) — it does
  not get the richer categories (vehicle vs. person, colour, plates) unless that footage is re-scanned by our AI,
  which itself needs a playback session per channel being scanned.
* **Nothing about the live view changes.** Live viewing uses its own 8 sessions (already proven independent of the
  playback cap), so the live grid, instant replay and live AI indexing (4.2–4.3) are unaffected by all of the above.

---

## 4. What we build instead

### 4.1 Multi-camera review, within the 4-session ceiling
* The group player supports **up to 4 frame-locked panes** at once (section 5.2) — this is the real ceiling, stated
  plainly rather than implied. Opening a 5th pane pauses the least-recently-active one and shows why (with a
  one-click swap), rather than erroring.
* For scanning *more* than 4 channels' worth of history, the practical pattern is **sequential review**: open 4,
  step through, swap in the next 4 — the UI supports a "channel queue" so this is a few clicks, not manual bookkeeping.
* If this turns out to be too limiting in practice, the fix is a small NVR/recorder box or upgraded DVR firmware —
  outside this spec, but worth knowing the ceiling is a hardware fact, not a software one.

### 4.2 Live-forward AI index (no video storage, events only)
The 8 live sessions are already open for the grid. While a channel is live, we can run our own detectors on that
feed **without recording video** — and persist only what a search needs: a `(time, kind, channel, region, attrs,
confidence)` row plus a small JPEG crop (kilobytes, not video). This means:
* **From the moment a channel's AI index is turned on, forward, region/attribute/object search is instant** (section 6) —
  no DVR session needed, because nothing has to be re-decoded.
* **Before that moment**, only the DVR's own alarm log (motion/line-crossing/tamper, section 2.3) is searchable instantly; anything richer requires an on-demand background scan through the DVR (section 6.3), bounded by the same 4-session budget.
* Per-channel opt-in (CPU cost, section 8), default **off** until you choose which channels matter (section 11.2).

### 4.3 Instant replay ring (RAM only, not a recorder)
A small **in-memory** ring buffer (default 2 minutes) per *live* channel, built from the same 8 live sessions —
nothing is written to disk, and it holds only the last couple of minutes. This is what powers "jump back 10 s"
on a live tile (section 9.2). At the measured SD bitrates (section 2.6-equivalent: ≈195 KB/s for all 8 channels
combined), 2 minutes × 8 channels of **compressed** frames is on the order of **40 MB total**, not written to
disk and discarded on restart. This is a live-view convenience, separate from the "no archive on this Mac"
decision (section 3) — but it is still something on this machine holding recent video in memory, so it's called
out explicitly here rather than left implicit; turn it off per channel if you'd rather not.

---

## 5. Feature assessment (every requested item, updated for "DVR-only")

Legend: ✅ works as asked · 🟡 works with a stated limit · 🔬 needs the approved spike · ❌ not possible as worded (alternative given)

| # | Requested feature | Verdict | Approach |
|---|---|---|---|
| 1 | Multi-scale adaptive timeline, 24 h ↔ 1 s, wheel/gesture zoom | ✅ | Canvas timeline over a pre-aggregated summary; anchored zoom reusing the existing zoom controller. |
| 2 | Synchronised multi-channel playback, "16+" | 🟡 **hard ceiling: 4** | Frame-locked, HD, from the DVR — 4 is the DVR's own limit (section 2.2), not a design choice. Sequential "channel queue" review covers more cameras across time (4.1). Your DVR has 8 channels total; 16 is unreachable on this hardware regardless. |
| 3 | Instant asynchronous review (detach a pane, grid keeps monitoring) | ✅ | Per-pane clock; a pane switches live↔playback independently of its neighbours. |
| 4 | Empty-footage skipping | 🟡 | Instant and precise once a channel's AI index exists (4.2). Before that, only as precise as the DVR's alarm log — which only exists for channels with motion/line-crossing *enabled on the DVR* (today: motion ch 1,2,3,7; line-crossing ch 4). The UI always labels which case applies to the footage you're viewing. |
| 5 | Speed 2×–64× and ½×–⅛× | 🟡 | ⅛×…16× native from the DVR. 32×/64× and reverse speeds are built by us on the decoded feed (5.4); DVR itself refuses ≥32× and reverse outright. |
| 6 | Strict frame-by-frame, forward **and backward** | ✅ | Forward = next decoded frame. Backward = decode the preceding GOP (≤ ~9 s) into memory and step through it — the DVR has no reverse primitive, so this is entirely client-side. |
| 7 | Instant rewind macros (−5/−10/−30 s, custom) | ✅ | Hotkeys + configurable buttons; DVR seek is 70–100 ms. |
| 8 | Draw a box → find clips with change there | 🟡 | **Instant** for anything after a channel's AI index existed (4.2 — a bitmask over a 16×9 motion grid). **Older history:** background scan job through the DVR (≤4 sessions, ≤16× speed) — a progress bar, not instant, and it competes with any live review for the same 4 sessions. The `smartSearch` spike (2.3) may remove this limitation entirely if it works. |
| 9 | Attribute/category search (human/vehicle/two-wheeler/colour/backpack) | 🟡 | Our own AI, only on footage that passed through the live index (4.2) or was explicitly re-scanned. Attribute reliability (backpack, body type) is lower at SD/night than object class. |
| 10 | VCA violation indexing (line-crossing, loitering, counter-flow) | 🟡 | **Line-crossing, intrusion, tamper, motion, video-loss:** DVR's own log — but only where *enabled on the DVR itself* (section 6, recommendations given). **Loitering, counter-flow:** our own AI on tracked objects (needs a tracker; live-forward only, same as feature 9). |
| 11 | Event colour coding | ✅ | Fixed, colour-blind-safe palette (section 5.1). |
| 12 | Digital zoom during playback + enhancement | ✅ | Zoom/pan is already built and shared; enhancement in section 7. |
| 13 | On-the-fly gamma/sharpen/contrast, haze/shadow clean-up | ✅ | WebGL shader chain on the playing frame (tier L0, section 7). |
| 14 | ML frame-enhancement mode | 🟡 | Tier L2, server-side, on a chosen still/short clip, with forensic labelling (section 7). |
| 15 | Multi-cut clipper → one export batch | ✅ | Non-destructive range list; each range exported as a DVR playback session, honouring the 4-session queue. |
| 16 | Dual-format export incl. native `.EXE`/`.DAV` | 🟡 | See section 10 for the full menu of options — a recommended default plus the alternatives, per your request. |
| 17 | Incident tags & bookmarks shared across operators | ✅ | Approved: user accounts + live sync (section 9). |
| 18 | Bandwidth-aware dual streaming (SD in dense grids, HD when maximised) | ✅ | Already true live. In playback everything is HD (2.1 — the DVR never recorded SD), so this specific saving doesn't apply to *playback*; it stays true for the live grid. |
| 19 | Smart event & AI search | 🟡 | One search box over the unified event index (section 6); richness depends on whether a channel's AI index was running at the time (4.2), same caveat as 8–10. |

---

## 6. Recommended DVR configuration (your decision, options given)

Line-crossing/intrusion/motion events only exist in the DVR's log for channels where they're *enabled on the DVR*.
Today: motion is on for ch 1 (Road Right), 2 (Living Room), 3 (Gate), 7 (Road Left); line-crossing is on for ch 4
(Back Right), generating 150–484 events/day — a lot, because the DVR log's 2,000-entry cap (2.3) means a noisy
channel costs more API calls to read fully. Sentinel Eye reads whatever is enabled; it will not change DVR settings
on its own. Three options, in order of recommendation:

1. **Recommended — targeted:** keep motion where it is; add line-crossing only on driveway/road-facing channels
   where a crossing has a clear meaning (candidates: ch 1 Road Right, ch 6 House, ch 7 Road Left — you know the
   layout better than I do). Leave intrusion/field detection off unless you have a specific zone to guard (it adds
   log volume similarly to line-crossing). This keeps the alarm log usable and keeps our own AI (4.2) as the source
   for anything richer.
2. **Broad:** motion + line-crossing on every channel. Simplest to reason about; the cost is a noisier log (more
   `logSearch` calls, more entries to de-duplicate against the live stream) and more false triggers from moving
   shadows/insects on IR cameras at night — the DVR's motion detector has no size/speed filtering.
3. **Minimal:** leave DVR analytics exactly as they are today and rely entirely on our own AI index (4.2) going
   forward, and only the *existing* motion/line-crossing channels for history. Zero DVR changes, at the cost of no
   analytics at all on channels 5, 6, 8 for anything that predates our index.

I'd start with **option 1** and revisit after a week of real events. Changing it is a DVR Web UI action on your
side (Configuration → Event → Motion/Line Detection per channel); Sentinel Eye's Settings will show what's
currently enabled per channel so you don't need to check the DVR UI to know.

---

## 7. Playback UI and engine

### 7.1 Timeline
* **Lanes** (per channel, collapsible, plus a combined lane): coverage, events, bookmarks, selected clips.
* **Colours:** coverage green; motion yellow; AI objects blue; alarms/line-crossing/intrusion red; tamper/video-loss
  grey-hatched (a labelled gap, not a blank one); bookmarks a white flag; selected clips a cyan bracket.
* **Scales** (auto, cross-fade on zoom): 24 h · 6 h · 1 h · 10 min · 1 min · 10 s · 1 s (frame ticks ≤ 2 s), each
  drawn from a pre-aggregated summary so panning cost is pixels, not events.
* **Input:** wheel / trackpad pinch anchored at the cursor (Chrome/Firefox via wheel+ctrl, Safari via its gesture
  events — the same controller already built for the live view's zoom/pan), drag to pan, click/drag to seek,
  shift-drag for a range, `[`/`]` mark in/out, `←/→` step, `,`/`.` frame, `J K L` shuttle.
* Calendar date-jump with recording-day dots (from `dailyDistribution`) and an event-density heat strip.
* DVR-local time shown by default, with a UTC toggle.

### 7.2 Playback engine (browser)
* **WebCodecs `VideoDecoder`** per pane, fed GOPs that carry absolute time; one master clock (speed-scaled) decides,
  every animation frame, which decoded frame of each pane is the latest one ≤ `T` and paints it — this is what
  keeps panes frame-locked and makes stepping/reverse/speed uniform across all of them.
  **Verified on a real recorded GOP from this DVR**: a 10-second, 149-frame H.265 clip fed to `VideoDecoder`
  (`hvc1.1.6.L153.B0`, Annex-B, no hardware-decoder pinning) produced 149 outputs, zero errors, in 315 ms —
  a different, working decode path from the MSE/live-view stutter noted elsewhere in this codebase (that one
  goes through the OS's dedicated HEVC decoder; WebCodecs here ran in software and was clean). If a future
  Chrome/OS update changes that, the documented fallback is server-side H.265→H.264 transcode per pane
  (already built for live HD, ~5–9% CPU each) — reverse and 32×/64× would then buffer transcoded GOPs instead
  of raw ones, everything else in 7.4/7.5 is unchanged.
* Supported: Chrome/Edge 94+, Safari 16.4+, Firefox 130+ (your choice, confirmed). Older browsers get single-camera
  MSE playback (today's live-view path) with no frame-lock or reverse, clearly labelled.
* Up to **4 panes**, each backed by its own DVR playback session (the hard ceiling, section 2.2/3 — **confirmed to be a true count cap**, not a bandwidth budget: a 16× session plus three 1× sessions all ran together, and a 5th session was refused regardless of speed mix).
* **Strict-sync toggle:** ON waits for the slowest pane ("buffering CH5"); OFF lets panes skip to stay closer to real time.
* **Detach pane:** a pane keeps its own clock once detached; "sync to group" re-attaches it.

### 7.3 Session scheduling
Every consumer of DVR history — a playback pane, a background search scan, an export job — draws from the same
4-session pool. A fair-share queue serves them in request order, a maximised/focused pane gets priority over a
background scan, and the UI always shows *why* something is waiting ("3 of 4 sessions busy — CH2 playback queued").

### 7.4 Speed spectrum
⅛×–16× via the DVR's own `Scale` header. 32×/64× ("scan speed") and all reverse speeds are built by decimating or
walking the decoded frames ourselves, because the DVR refuses both on the wire (2.2). No audio (none is recorded).

### 7.5 Frame stepping and reverse
Forward step = next decoded frame. Backward step / reverse play = decode the preceding GOP (≤ ~9 s ⇒ ≤135 frames)
into memory and walk it backwards; the next GOP back is pre-fetched at the boundary. Reverse at ≤4× is smooth on
this hardware; faster reverse uses keyframe-stride "scan" mode.

### 7.6 Rewind macros
Default −5 s / −10 s / −30 s (`1`/`2`/`3` with Shift), fully configurable, plus "jump to previous/next event".

### 7.7 Skip-empty
Toggle. Uses the unified event index (section 8); "not empty" = any motion/AI/alarm span, padded by a configurable
pre/post-roll (default 3 s / 5 s), merged if closer than 10 s. The jump itself is visible on the timeline, never silent.

---

## 8. Event index

One table, one search box:

`events(id, source, channel, kind, start_utc, end_utc, confidence, region_json, attrs_json, snapshot_path)`

| source | kinds | how it gets in |
|---|---|---|
| `dvr-live` | motion, line-crossing, intrusion, tamper, video-loss | `alertStream` subscriber, always on once Sentinel Eye is running, persisted immediately. |
| `dvr-log` | same, backfill | Startup + nightly: per-day `logSearch` (split by hour if a day hits the 2,000 cap) across the DVR's full ~43-day retention; start/stop pairs stitched into spans; de-duplicated against `dvr-live`. |
| `live-ai` | person, vehicle, two-wheeler + colour/attribute, loitering, counter-flow (+ a 16×9 motion grid for region search) | Our detector/tracker on the **live** feed of any channel with AI indexing turned on (4.2) — no DVR session, no video written to disk, only event rows and small crops. |
| `scan-ai` | same kinds, for a chosen historical window | On-demand background job, reads DVR history through the session queue (7.3), decodes and runs the same detector; used for "search before the index existed" or explicit re-analysis of a specific window. |
| `manual` | bookmark, incident | Operators (section 9). |

Search = filters (channel(s), time range, kind, attribute, region box, minimum duration) → ranked, grouped clips
(adjacent events merged with pre/post-roll) → click opens the player at that clip. Results also draw as a dedicated
lane on the timeline, and every result is labelled with which of the five sources produced it.

---

## 9. Collaboration: incidents, bookmarks, handoff (approved)

* **Bookmark** = `(time, channels[], title, note, severity, author, created)`. **Incident** = a named group of
  bookmarks + clips + exported sets + an append-only note log (each entry stamped author/time).
* Shown on the timeline (flag glyph) and a side list; searchable; carried into an export's manifest (10.2).
* **Accounts:** local users (`Viewer / Operator / Admin`), password-hashed, session cookie over **HTTPS** (a
  self-signed cert is fine on a LAN — I'll add a one-click "trust this once" note in Settings, or you can supply
  your own cert/reverse proxy if you have one). An **audit log** records who viewed or exported what, when.
* **Live sync:** one WebSocket carries `bookmark.created`, `incident.note`, and lightweight presence ("Operator X
  is reviewing CH3 at 21:05") to every connected browser.

---

## 10. Export — recommended option and the full menu

Every export is a **stream copy** (no re-encode, no quality loss, fast) of the chosen range(s) from the DVR,
decrypted the same way live/playback video already is. You get to pick the container/packaging per export
(or set a default), from most to least recommended:

| Option | What you get | Why / why not |
|---|---|---|
| **① Recommended — signed evidence package** | `clip.mp4` (H.264/H.265, plays anywhere) + `manifest.json` (SHA-256 of every file, camera, exact DVR time range, source, operator, any enhancement applied) + an **Ed25519 signature** (key lives on this install, public key exportable for a third party to verify) + a single offline `verify.html` (drop the folder on it → ✓/✗, no install) + an optional frame-step `player.html`. | Tamper-evident and portable — this is what a `.EXE`/`.DAV` package is *for*, without needing Hikvision's own tooling. Slightly more files than a bare clip. |
| **② Plain MP4 or MKV** | Just the video file, optionally with a burned-in timestamp/camera-name overlay (this one step re-encodes; off by default). | Fastest, simplest, works in any player. No tamper-evidence — fine for a quick look, not for anything that might be disputed later. |
| **③ Original DVR file, unmodified** | The exact proprietary container the DVR itself would export, fetched via ISAPI `download` and passed straight through — no decryption, no re-encoding, no Sentinel Eye processing at all. | The most "native" and least trustworthy-to-question option precisely because nothing touched it — but it only plays in Hikvision's own player/SDK, and cannot carry our manifest or signature. Offered for the specific case where a recipient (e.g. police, insurer) insists on the original vendor file. |
| ④ `.EXE`/`.DAV` self-contained player, as literally requested | **Not offered.** `.DAV` is a *Dahua* format (wrong vendor); a Hikvision-style self-extracting `.exe` player package cannot be authored outside Hikvision's own SDK. Option ① is the closest available substitute and is stronger in one respect (an open, third-party-verifiable signature instead of a vendor-specific opaque player). | — |

Default going forward: **① for anything that might matter later, ② for a quick look**. Batches (the multi-cut
clipper) can mix — each range in a batch can carry its own choice, or you set one for the whole batch.

---

## 11. Benefits for the live view (built from the same parts)

1. **Seamless grid ↔ focus:** re-parent the already-running player into the focus stage instead of tearing it down
   and reconnecting — no black frame, no stream restart, and the grid's other tiles keep running behind it.
2. **Instant replay on any live tile:** "◀ 10 s" from the RAM-only ring (4.3), with one-click return to live.
3. **Event awareness on live tiles:** motion/line-crossing/tamper/video-loss badges from `alertStream`, optional
   border flash, per-channel mute.
4. **Detach-and-review:** open a tile in playback while the rest of the grid keeps monitoring live.
5. **Live enhancement (L0) presets** on any tile; snapshot saves the enhanced or the original frame, your choice.
6. **Bookmark from live** in one keypress.

---

## 12. Still open — the last few decisions

Everything from round 1 is settled (section 0 header). Two small things remain before I start M0:

1. **Which channels get AI indexing on by default (4.2)?** It costs CPU per channel while running. My suggestion:
   start with the channels facing likely areas of interest (you know which — driveway/gate/road channels are my
   guess from the names) and add more once you've seen the CPU cost in Status. Or start with all 8 and dial back —
   your call.
2. **DVR configuration (section 6):** I'd start with option 1 (targeted). Confirm, or pick 2/3.

Everything else in this document (accounts+HTTPS, export menu, session-queue behaviour, milestone order) is ready
to build as written.

---

## 13. Milestones (each ends with tests and your sign-off)

| M | Deliverable | Acceptance |
|---|---|---|
| **M0 foundations** | Time model (calibrate, unwrap, DVR-local↔UTC, continuous drift check); event ingest (`alertStream` + capped/paginated log backfill); coverage index from DVR search | Backfill matches DVR UI counts for a sampled week; a forced clock jump is detected, not silently absorbed; unit tests for 32-bit wrap and 2,000-entry-cap splitting |
| **M1 single-camera playback** | Full timeline, DVR playback via WebCodecs, ⅛×–16×, forward/back frame-step, rewind macros, calendar | Scrub any minute of any recorded day; each step changes the decoded frame index by exactly 1 (verified by asserting on `VideoDecoder` output count, not by eye); seek < 300 ms; Safari gesture path verified in real Safari (not simulated) |
| **M2 multi-camera sync (≤4) + live-view upgrades** | Group player (≤4 panes, session queue, strict-sync, detach), seamless grid↔focus, instant-replay ring, live event badges | The frame each pane paints is compared by its **RTP-derived absolute timestamp** (section 2.4), not the on-screen clock: median cross-pane skew < 1 frame over 30 min, logged continuously — the burned-in clock (1 s resolution) is used only as a periodic spot-check, not the measurement itself; a 5th requested pane queues visibly, never errors; focus↔grid never shows a black frame |
| **M3 event search** | Unified index, live-forward AI on opted-in channels, region/attribute search, skip-empty, background scan job, `smartSearch` spike | Region search on indexed footage returns in < 1 s; scan job on un-indexed history reports progress and completes; skip-empty behaviour matches the index-vs-log distinction in feature 4 |
| **M4 clipper + export + accounts** | Multi-cut clipper, all three export options, bookmarks/incidents, user accounts + HTTPS + audit log, live sync | Exported clip is frame-identical to source (decode-compare); verifier catches a 1-bit change; two logged-in browsers see each other's bookmark in < 1 s |
| **M5 enhancement L0 + L1** | WebGL live-adjust chain + presets; ffmpeg/OpenCV multi-frame fusion/denoise | Real-time at 1080p on this Mac; L1 measurably improves a test plate crop; originals never modified |
| **M6 AI depth + L2** | Attribute model, loitering/counter-flow, ML enhancement (super-resolution, low-light, denoise) | Precision/recall reported on a hand-labelled 1-hour sample from your cameras; every L2 output is tagged "ENHANCED" and ships with the untouched original |

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| 4-session contention (playback + scan + export all competing) | Fair-share queue, visible wait reasons, priority to the pane you're actually looking at |
| DVR disk loops — oldest day vanishes daily | UI shows the oldest available time and warns when a range you're reviewing is close to rolling off; export early |
| Timestamp model unproven over days/reboots | Continuous re-check, not a one-time calibration; a detected jump halts sync rather than silently drifting |
| Alarm-log noise/cap (line-crossing up to ~480/day on one channel) | Per-day + hourly-split queries; merge-if-close in the UI; section 6 gives a lower-noise DVR config option |
| ML enhancement mistaken for evidence | Mandatory "ENHANCED" tagging, original always exported alongside, L1 (non-hallucinating) is the default for anything evidentiary |
| Accounts/HTTPS add a new attack surface on a LAN device | Self-signed cert acceptable for LAN use; password hashing, no default credentials, audit log from day one |
