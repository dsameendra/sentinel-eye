# Sentinel Eye — Specification

Status: **DRAFT for approval, round 2** (playback/review, sections 1–14) · Author: Claude · Date: 2026-09-22.
Round 1 decisions (recorded here): no local video recorder — the DVR is the only video store; milestone order
accepted; multi-operator accounts approved; ML/AI dependencies approved; DVR-config and export are "give me
recommended + possible options" (done in sections 6 and 10); browser floor accepted; the `smartSearch` spike
is approved. Section 11 lists what is still open.

Section 7.8 (the AI frame enhancer, tier L2) was a separate document until this merge; its own status was
**build-as-written, implemented same session · Date: 2026-09-22**. It extends the live-adjust filter chain
(tier L0, section 7 and `web/js/enhance.js`'s own header comment) that section 5 item 13 and section 13's
M5/M6 rows describe.

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
| **Line-crossing/intrusion is a single shared hardware resource for the whole DVR, not per-channel.** Tried to enable it on a second channel (ch 1) while it was already on for ch 4: rejected (`humanEnginesNoResource`). Freed ch 4, ch 1 then enabled fine; with ch 1 on, a third channel (ch 3) was rejected the same way. **Only one channel, system-wide, can run this analytic at a time.** All test changes were reverted; the DVR was left exactly as found (ch 4 only, verified byte-for-byte against a backup taken first). | Direct ISAPI test (enable/disable sequence on ch 1/3/4, each checked against a saved backup) | Section 6's original three-option menu assumed several channels could each get line-crossing — that assumption was wrong. Section 6 is corrected below to reflect the real, single-channel constraint. |
| **DVR "smart search"** | `isSupportSmartSearch=true`; the endpoint exists (`400 badXmlFormat`, not `404`) but the request schema is undocumented | **Spike run, inconclusive — schema not recovered.** `/ISAPI/ContentMgmt/smartSearch` confirmed distinct from a 404 (also confirmed via the capability doc: `isSupportSmartSearch`/`isSupportSmartSearchRecordByUTC`/`isSupportSmartSearchPictureByUTC` all `true`). Tried, over the ~1h budget: the known-good `CMSearchDescription` schema used successfully elsewhere (`ContentMgmt/search`, `logSearch`) as-is and extended with a `metadataList`/`metadataDescriptor` (VMD) block and a `MotionSearchDescription` region block; a `SmartSearchDescription` root with `trackIDList`/region-grid and a minimal no-region form; `channelID` in place of `trackList`; and `?format=json` bodies mirroring each shape (JSON *is* accepted as a request format by this firmware — confirmed by a distinct, more specific error appearing only there — but every JSON body shape still failed identically, suggesting the JSON path independently validates structure before even reading content). Every attempt returned the same generic `badXmlContent`/`badXmlFormat`, with no field-level hint distinguishing a close guess from a wrong one. **Conclusion: not solvable by black-box guessing** — it needs Hikvision's own ISAPI reference for this endpoint (not public), which this project doesn't have access to. **Decision: abandoned, falling back to section 6.3's background scan job** (decode + our own detector through the existing 4-session queue) for pre-AI-index history search, as the spec always planned as the fallback either way. Worth revisiting only if a copy of the vendor's private ISAPI doc turns up. |

### 2.4 Timing — the foundation of any synchronised playback

* The DVR's `…Z` timestamps are **DVR local time (UTC+5:30, no DST) mislabelled as Z**. We store UTC internally and convert only at the edges (display, DVR requests).
* Playback carries no RTCP clock, but **RTP timestamps behave as one shared 90 kHz clock across channels and sessions.** Verified at **two moments 13.7 hours apart** (crossing the 32-bit counter's ~13.25 h wrap once), cross-checked against each channel's burned-in clock: offsets matched to within about a frame every time. Not yet proven over days or across a DVR reboot — the calibration is re-checked continuously in M0 and any jump is flagged, never silently absorbed.
* One calibration constant converts an RTP timestamp to an absolute time, accurate to about one frame (67 ms). That is the basis for frame-locked multi-camera playback.
* **Update, found during later use, not at M0:** that one-frame accuracy is real for playback *near the time a
  channel's `a_const` was (re)calibrated* — recalibration runs every 6 hours per channel and is exactly as
  accurate as originally measured. It is **not** proven, and turned out **not to hold**, for footage recorded
  many calibration cycles ago. Seeking to exact DVR-local midnight on a day ~10 days back: the DVR served the
  exact requested content (confirmed against the frame's own burned-in OSD timestamp, which read the requested
  instant precisely), but this app's own computed absolute time for that same frame was off by roughly 1–2
  hours — varying in size and direction across different days, ruling out a simple fixed offset or an RTP
  32-bit-wrap unwrap picking the wrong period (that would show as a near-multiple of the ~13.26h wrap, which
  this isn't). Coverage and event positions on the timeline are unaffected (they come from the DVR's log/search
  APIs with a fixed, known UTC offset, not from RTP timestamps at all) — this is specific to the *video
  player's* displayed/decoded time, and by extension the exact time range claimed in an export's manifest for
  old footage. Root cause not yet found; likely candidate is that a single `a_const` doesn't stay valid across
  the channel's own RTP-clock behavior over many calibration cycles (drift, or a discontinuity too small to
  trip the existing >2s single-step discontinuity check but real once accumulated). Needs its own investigation
  — a time-varying calibration (store history, use whichever `a_const` was valid when the footage was recorded,
  not always the latest one) is the likely direction, not confirmed. (A related but distinct frontend bug —
  picking a new position while paused updated the displayed playhead without actually repositioning the
  player, so pressing Play resumed from a stale position instead — was found and fixed separately; it does not
  explain or resolve this calibration-drift issue, which is still open.)

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
| 13 | On-the-fly gamma/sharpen/contrast, haze/shadow clean-up | ✅ | WebGL shader chain on the playing frame (tier L0, section 7 and `web/js/enhance.js`'s own header comment). Extended well beyond the original 5: edge-aware sharpen, noise reduction, a fast dehaze approximation, CLAHE-inspired local contrast, chromatic-aberration correction, digital WDR (highlight-rolloff tone mapping), single-scale Retinex illumination correction, temporal-median rain/snow-streak reduction, and auto white balance for IR-tinted night footage — every one independently strength-adjustable and stackable in the same pass, not a fixed preset list, plus a Playback-only draggable ROI (enhance runs only inside the box, cheaper and more concentrated than full-frame) and a cursor-follow "digital flashlight". Deliberately not implemented: blind-deconvolution motion deblur — a misestimated blur kernel fabricates confident-looking structure, the same failure class CCSR's diffusion denoising was rejected for in the L2 AI enhancer (section 7.8.2a), and this app's own stated rule is real pixels only, nothing invented. |
| 14 | ML frame-enhancement mode | 🟡 | Tier L2, server-side, on a chosen still/short clip, with forensic labelling (section 7.8). |
| 15 | Multi-cut clipper → one export batch | ✅ | Non-destructive range list; each range exported as a DVR playback session, honouring the 4-session queue. |
| 16 | Dual-format export incl. native `.EXE`/`.DAV` | 🟡 | See section 10 for the full menu of options — a recommended default plus the alternatives, per your request. |
| 17 | Incident tags & bookmarks shared across operators | ✅ | Approved: user accounts + live sync (section 9). |
| 18 | Bandwidth-aware dual streaming (SD in dense grids, HD when maximised) | ✅ | Already true live. In playback everything is HD (2.1 — the DVR never recorded SD), so this specific saving doesn't apply to *playback*; it stays true for the live grid. |
| 19 | Smart event & AI search | 🟡 | One search box over the unified event index (section 6); richness depends on whether a channel's AI index was running at the time (4.2), same caveat as 8–10. |

---

## 6. Recommended DVR configuration (revised: this DVR shares one analytics engine)

**Correction from the first draft of this section:** I assumed line-crossing could be enabled per-channel
independently, the way motion detection is, and wrote a menu of "targeted vs. broad vs. minimal" options on
that basis. Testing it directly (section 2.3) showed that's wrong: **this DVR has one shared line-crossing/
intrusion engine for all 8 channels combined — only one channel in the entire system can run it at a time.**
Turning it on for a second channel doesn't add coverage, it *moves* the engine away from whichever channel had
it. Today that channel is **ch 4 (Back Right)**, already generating 150–484 line-crossing events/day.

Given that hard constraint, the real options are:

1. **Recommended — leave it where it is (ch 4).** It's already configured, already producing events, and I
   don't know why ch 4 specifically was chosen (possibly deliberately, by whoever set up the DVR). Doing nothing
   costs nothing and risks nothing.
2. **Move it to a different single channel** — if you tell me which one matters most for line-crossing
   specifically (as opposed to plain motion, which is already independent per-channel and unaffected by this
   limit), I'll reconfigure it there instead. Candidates by camera view: ch 1 (Road Right), ch 3 (Gate), ch 6
   (House — actually a road view despite the name), ch 7 (Road Left) all show a road or a driveway suitable for
   a crossing line; I looked at a current snapshot from each before writing this.
3. **Turn it off entirely** and rely only on motion (still independent per-channel, already on for ch 1,2,3,7)
   plus our own AI going forward (section 4.2) — simplest, but loses the one DVR-side line-crossing signal you
   currently have.

I'd keep **option 1** unless you have a specific reason to move it — tell me the channel and I'll do it (with the
same before/after verification I used in testing: read the current config, back it up, change it, confirm the
new state, and I'd show you the result before considering it final). Intrusion/field detection shares the same
one-engine-for-the-whole-DVR limit, confirmed by the same mechanism (`isSupportFieldDetection` sits behind the
same capability the error referenced) — so it competes with line-crossing for the same single slot, not a
separate one. Plain **motion detection has no such limit** — it really is independent per channel, already on for
ch 1, 2, 3, 7, and can be extended to the rest with no trade-off.

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

### 7.8 AI frame enhancer (tier L2)

L0 (the WebGL live-adjust chain covered in section 5 item 13 and `web/js/enhance.js`) runs in real time on a
playing or paused picture. This section is the other enhancement tier the roadmap named but didn't design in
detail: a heavier, server-side, ML-based pass on a single paused frame or short burst, for when L0's classical
adjustments aren't enough to make out a face or plate.

#### 7.8.1 Goal

From a single paused frame, or a short burst of consecutive frames, produce the clearest, sharpest,
highest-resolution version of that moment a forensic reviewer could plausibly use — especially faces and
licence plates — while being explicit, every time, that the output is AI-reconstructed detail and not
proof of what the original pixels actually contained.

Non-goals: real-time enhancement of a live/playing stream (L0 already covers "on the fly"); enhancing a
whole clip/export batch in one action (out of scope for this pass — one frame/burst at a time, from
Playback, paused); any claim that L2 output is usable as unaltered evidence (see 7.8.6).

#### 7.8.2 Why AI/ML here, and which models

A single frame from this DVR is at best 1080p, H.265, day/night IR, often at some distance — a face or
plate can be a few dozen pixels wide. Classical upscaling (bicubic, Lanczos) doesn't add real detail, it
just interpolates existing pixels smoother — this is what "CSI zoom and enhance" jokes are about, and why a
naive implementation would look impressive on a demo image and useless on real DVR footage. A trained
super-resolution model, by contrast, has learned what real faces/plates/textures look like and can
plausibly reconstruct detail that's genuinely missing at the source resolution — which is powerful, and
exactly why it must never be presented as if it were the original (7.8.6).

**Chosen models** (both open source, both run locally, no cloud calls — the DVR is a LAN-only device and
nothing about this feature should call out to the internet at inference time):

| Model | Role | License | Why this one |
|---|---|---|---|
| **Real-ESRGAN** (`RealESRGAN_x4plus`, x4v3 variant for speed) | General-purpose 4x super-resolution/upscale — the background, the plate, the scene | BSD-3-Clause (Tencent ARC) | The de-facto standard open-weight photo upscaler; trained specifically on realistic degradations (compression, noise, blur) rather than clean synthetic downscaling, which matches DVR footage far better than a generic SR model. Actively maintained, small (~64MB), fast enough on this Mac's GPU (MPS). |
| **GFPGAN** (`v1.4`) | Face restoration — detects faces in the frame, restores/sharpens them specifically, blends back into the (Real-ESRGAN-upscaled) background | Apache 2.0 (S-Lab, NTU) | The standard companion to Real-ESRGAN for exactly this combination — GFPGAN's own reference pipeline *is* "GFPGAN faces + Real-ESRGAN background," so this isn't two models awkwardly bolted together, it's the documented, intended way to run them. Meaningfully better on small/blurry faces than Real-ESRGAN alone, which is generic and doesn't have a face-specific prior. |

No dedicated license-plate model is used — open, reliable, permissively-licensed plate-specific
super-resolution models are not readily available, and a wrong/overconfident plate reconstruction is the
single worst thing this feature could produce (a fabricated character on a plate is actively dangerous in
a way a slightly-too-smooth face is not). Plates get Real-ESRGAN's general upscale plus a classical (non-AI)
levels/contrast/sharpen pass (percentile contrast stretch + CLAHE + unsharp mask, pushed harder than the
face/general path — 7.8.2c/7.8.2d) — real detail made more legible, nothing invented. This is called out
explicitly in the UI (7.8.5), not silently downgraded.

##### 7.8.2a CCSR-v2 was tried and removed — diffusion denoising destroys exactly what this tool exists to read

A later pass added CCSR-v2, a diffusion-based (Stable Diffusion 2.1) SOTA restoration model, as a second,
user-selectable "best quality" engine (SUPIR, the model actually requested at the time, needs 28GB+ RAM and
CUDA-only tooling — a hard wall on this Mac's 18GB unified memory, surfaced to the user before writing
integration code; CCSR was the viable alternative). It was fully vendored, patched for MPS, tuned to avoid
out-of-memory, and worked end-to-end — but real DVR-footage testing showed its denoising step doesn't just
smooth sensor noise, it actively redraws small high-frequency detail (burned-in timestamps, plate
characters, small signage text) into plausible-looking but wrong shapes, because that's what a diffusion
model's learned prior does to anything it treats as "noise" rather than "signal." That's the single worst
failure mode this whole feature is designed against (7.8.6) — a confident-looking but fabricated
character — so the model was removed entirely rather than kept as an option a reviewer could reach for by
mistake. The vendored code and this section are gone from a later revert; this paragraph is kept only as a
record of why, since the natural next idea ("just use the SOTA diffusion model") was tried and has a
specific, confirmed reason not to work for this tool's actual content.

##### 7.8.2b Real forensic-enhancement practice, adapted to what's implementable here

The two improvements below (7.8.2c, 7.8.2d) are a direct translation of how manual forensic frame
enhancement is actually done — de-noise/stack a base layer, isolate the plate or face before upscaling it,
use a restoration model's *fidelity* control deliberately rather than at a fixed default — into what an
in-browser single/burst-frame tool can do without external software (Topaz Video AI, Photoshop) or a full
compositing pipeline. The one piece deliberately not adopted is producing a single "final composite" image
(video + plate callout + face callout stitched together): this tool's output is an interactive, zoomable
single image per subject, not a rendered still for a report, so a separate crop-per-subject workflow (below)
serves the same purpose without inventing a new artifact type.

##### 7.8.2c Region-of-interest crop — isolate before you upscale

The operator can drag a box over the displayed frame (source or result — the box is stored as fractions of
the frame, so it means the same thing on either) to crop to just a plate or face *before* alignment and
upscaling. This is the single highest-leverage change here: a plate that's 3% of a 1080p frame is still only
~3% of the frame after a flat 4x upscale of the whole scene — cropping first means every one of the AI
pipeline's output pixels goes to the subject that was actually asked about, not mostly to background
resolution nobody needed. Plate mode's fusion also changes when multiple frames and an ROI are combined
(7.8.2d): a tight crop is small enough, and moves close enough to rigidly, that ECC's own translation alignment
tracks it directly, so there's no separate "independently-moving subject" risk left to protect against —
see the median-stack note below.

##### 7.8.2d Two more direct translations of manual practice

- **Median stacking for plate mode.** When plate mode runs on more than one frame, fusion uses a plain
  per-pixel median across the ECC-aligned stack instead of the motion-adaptive weighted blend used
  elsewhere. The blend's whole reason to exist (7.8.2, "multi-frame input") is protecting an independently-
  moving subject *elsewhere in a wide shot* from being averaged away — but that risk doesn't apply to a
  rigid plate/text region the way it does to a person walking through a wide scene, and a median is more
  robust than a mean against exactly the compression-block and sensor speckle noise that makes DVR digits
  ambiguous: it rejects outlier frames instead of blending them in, and every output pixel is a real pixel
  value from one input frame rather than an interpolated in-between value.
- **Fidelity slider — a real blend, after finding GFPGAN's own one does nothing.** `GFPGANer.enhance()`
  takes a `weight` parameter (0 = reconstruct freely from its learned face prior, can invent features; 1 =
  barely touch the input, stays blurry) that a first version of this slider passed straight through. A
  later report that the slider "didn't seem to do anything" turned out to be correct: read directly against
  the installed `gfpgan` package's model code (not assumed), both `GFPGANv1Clean.forward` and
  `GFPGANv1.forward` accept `weight` only via `**kwargs` and never reference it anywhere in the method — a
  known real limitation of the public GFPGAN release, not a mistake in this integration. Replaced with an
  actual linear blend instead: `_enhance()` now also runs a second, plain Real-ESRGAN pass with no face
  synthesis at all, and mixes it with GFPGAN's restoration by the slider value (0 = full restoration, 1 =
  the real upscaled pixels, 0.5 = even blend — same direction and default as before, now genuinely doing
  what it always claimed to).

**Multi-frame input:** when a short burst of consecutive frames is provided (not just one), they're aligned
(OpenCV ECC, translational — handles the small motion typical over a handful of frames at ~15 fps) and
fused *before* the AI pipeline runs, using a **per-pixel motion-adaptive weighted blend against the
reference (middle) frame**, not a flat median/mean. This replaced an earlier flat-median version after
directly confirming it had a real negative-impact failure mode, asked about and investigated on request:
whole-frame alignment corrects for camera/background motion, but does nothing for a subject moving
independently of the background — a person, a car — and a median or mean at a pixel the subject only
covers in some of the frames pulls that pixel toward the *other* frames' background value, softening or
partially erasing exactly the subject a reviewer is usually trying to see. The fix compares every aligned
frame to the reference pixel-by-pixel: where they closely agree (static, well-aligned background) the other
frames blend in at close to full weight — genuine sensor/compression noise reduction; where they disagree
sharply (motion, a moving subject, a misalignment residual) that frame's contribution fades toward zero, so
the fused pixel falls back to the reference frame alone rather than being averaged with content that
doesn't belong there. A learned video-super-resolution model (BasicVSR-class) was considered and rejected
for the same reason as before: heavy, slow on CPU/MPS, and this classical approach — now motion-aware —
gets most of the achievable benefit for a handful of frames spanning well under a second.

#### 7.8.3 Pipeline

```
N frames (1–7, from the paused position's decode buffer, already in memory client-side)
  → [roi set] crop every frame to the operator-drawn region (7.8.2c) — before anything else
  → [N > 1] align to the middle frame (ECC, translation), then fuse → 1 frame:
      mode = "plate": per-pixel median across the aligned stack (7.8.2d)
      otherwise: motion-adaptive weighted blend against the reference frame
  → Real-ESRGAN x4 upscale (background/whole-frame)
  → GFPGAN face detection + restoration (fidelity weight from the operator, default 0.5 — 7.8.2d), blended
    back into the upscaled frame (only if ≥1 face found)
  → [mode = "plate" or no faces found and mode = "auto"] levels stretch + CLAHE + unsharp mask
  → clamp output to a sane max dimension (6000px longest side) — high enough that a 1080p source's full 4x
    output (4320px) is never touched; only kicks in for a source that was already larger going in.
    **Previously set to 2048px, which is smaller than a 1080p source's own 4x output — every enhancement
    was silently downscaled most of the way back to its original size before the operator saw it, which
    doesn't just discard the added detail, it actively softens/aliases it on the way down. This was the
    main cause of a directly reported "looks worse than the original" bug**, found and fixed by comparing
    a same-region crop of the source against the (mis-clamped) result pixel-for-pixel.
  → PNG (lossless — this is the one place in the app a re-encode-with-loss would undermine the point)
```

Runs server-side (`app/enhance_ai.py`) — this needs real GPU/CPU compute (PyTorch, MPS-accelerated on this
Mac), not something to run in the browser. Frames themselves come from the *client's* already-decoded
WebCodecs buffer (`wcplayer.js`, which already holds ~30s/450 frames for stepping) — no new DVR playback
session is opened for this, so it doesn't touch the 4-session budget at all (2.2/7.3) and works on
whatever's already on screen, paused, this instant.

#### 7.8.4 API

- `POST /api/enhance` — body `{channel, at_utc, mode: "auto"|"face"|"plate"|"general", images: [base64 PNG, oldest→newest], roi: [x, y, w, h]|null, weight: 0.0-1.0}` (1–7 images, same dimensions). `roi` (optional, 7.8.2c) is fractions of the frame to crop to before enhancing. `weight` (default 0.5, 7.8.2d) is GFPGAN's fidelity knob. Starts a background job (same job/poll pattern as `/api/export`) since a burst + face restoration can take several seconds. Returns `{job_id}`.
- `GET /api/enhance/{job_id}` — `{state: queued|working|done|error, progress, error}`.
- `GET /api/enhance/{job_id}/result` — the enhanced PNG, once done.
- `GET /api/enhance/{job_id}/source` — the fused-but-not-AI-processed reference frame (the "before"), for the popup's before/after comparison — this is what the input actually looked like, not a claim about ground truth.
- `POST /api/enhance/{job_id}/ocr` — body `{which: "result"|"source"}`. Runs synchronously (Tesseract on a
  single already-in-hand image is sub-second, no job/poll needed) and returns `{lines: [{text, confidence}]}`.
  Optional, on-demand — never run automatically as part of the main pipeline (see 7.8.4a).

##### 7.8.4a OCR (optional, on demand)

Added on request as a genuinely useful but clearly-secondary aid: a "Read text" button in the popup that
runs **Tesseract OCR** (`pytesseract` + the local `tesseract` binary — Apache 2.0, the standard open-source
OCR engine, no cloud call) on whichever image is currently showing (enhanced or source) and lists what it
read, each line with Tesseract's own confidence score. This is deliberately kept separate from the main
enhance pipeline and the "modes" in 7.8.3:

- It's a **read**, not a generative step — nothing about the image changes, and nothing here can invent a
  character the way a generative model could. That makes it lower-risk than the SR/face pipeline, but not
  risk-free: OCR itself misreads low-resolution or stylised plate text often enough that its output must
  never be presented as a determined plate number, only as a suggested reading to check by eye.
- Every result carries its confidence score and a repeated "verify by eye" note in the UI — Tesseract will
  confidently emit wrong text on real DVR footage (glare, low res, oblique angle), and a lone number without
  that caveat is exactly the kind of thing that gets mistaken for a fact later.
- Optional and on-demand (a button, not automatic) because it's not useful on most frames (no plate/sign in
  frame) and shouldn't add latency to the main enhance path for the common case that doesn't need it.
- **Angled text** (a sign or plate facing partly away from the lens — not the camera itself tilted, a
  whole-frame rotation is rare here): Tesseract's default page segmentation assumes roughly-horizontal
  lines and its own orientation detection only corrects 90°-multiple rotations, neither of which covers
  this. `app/enhance_ai.py`'s `ocr()` now runs a CLAHE contrast pass first, tries the image upright, and —
  only when that reads poorly (no text, or low confidence) — re-tries a spread of small rotation angles
  (±5° to ±20°) and keeps whichever attempt actually recognised the most text at the highest confidence.
  Straight-on text (the common case) stays fast; only the angled/weak case pays for the extra search.

#### 7.8.5 UI (Playback page)

- A new toolbar button, enabled **only while paused** (mirrors the fact that this operates on the exact
  frame on screen, not a moving target) — icon: a corner-bracket "focus/scan" glyph, distinct from L0's
  wand icon, since this is a heavier, different-purpose operation.
- Click: grabs up to 7 frames centered on the current paused position from the primary pane's already-
  decoded buffer, immediately opens the enhancer popup in a loading state, and starts the job.
- The popup is a large, near-fullscreen overlay (not the small dialog style used elsewhere) with:
  - The result image in a **zoom/pan viewport** (reuses `ZoomPan`, the same component Live/Playback panes
    already use) and a **fullscreen** toggle, exactly as asked — this is meant to be inspected closely.
  - A **before/after toggle** (not a slider — a slider invites treating the transition itself as
    meaningful, when it isn't; a clean toggle between two labelled, static images is more honest).
  - A **permanent "ENHANCED — AI-reconstructed detail, not the original recording" label**, on screen at
    all times the enhanced image is showing, plus the same text baked into the downloaded file's own
    metadata/filename (7.8.6).
  - **Download both** — the enhanced PNG and the source (pre-AI) reference frame together, never the
    enhanced one alone, so whoever receives it always has the real frame it came from right next to it.
  - A **mode switch** (Auto / Face priority / Plate & text / General) to re-run with a different emphasis
    without re-grabbing frames — Auto picks face-restoration if GFPGAN finds a face, else the plate/general
    classical-sharpen path.
  - A **fidelity slider** (7.8.2d), shown for Face priority/Auto, controlling GFPGAN's real-pixels-vs-reconstruct
    trade-off — defaults to 0.5, re-runs on release.
  - A **"Select region" tool** (7.8.2c): drag a box over the image to isolate a plate or face; clears with one
    click. Re-runs automatically on release, cropping to that region before every later step.

#### 7.8.6 Forensic integrity (§14's stated risk, addressed directly here)

This is the one feature in the whole app where "looks impressively clearer" and "is trustworthy" can
diverge, and the entire design above is shaped around keeping that visible rather than papering over it:

- Every enhanced output is **watermarked in the UI and named on disk** as enhanced (`..._ENHANCED.png`),
  never indistinguishable from an original frame or export.
- The **source frame is always available alongside** the enhanced one — one without the other is not
  offered as a download option.
- **No plate-specific generative model** is used, specifically because a hallucinated character is far
  worse than a blurry-but-honest one — plates get real-detail sharpening, not invented detail.
- The before/after toggle exists so a reviewer can always see exactly how much the model changed, not just
  the flattering final frame.
- This tool **produces investigative leads, not evidence** — that framing is stated in the popup itself,
  not left implicit. Export's existing signed evidence package (§10) explicitly does *not* run this
  pipeline; the two are kept separate on purpose.

#### 7.8.7 What this does not attempt

- No video-level super-resolution model (BasicVSR/EDVR-class) — see 7.8.2's multi-frame note; the align-and-
  fuse approach is a deliberate, explained trade-off, not an oversight.
- No license-plate-specific *generative* recognition (no model that outputs "the plate is ABC123") — the
  app enhances pixels, a human reads them. Plain OCR (7.8.4a) is offered as an optional convenience on
  top of that, but it reads what's on screen, it doesn't reconstruct or guess a plate the way the SR/face
  pipeline reconstructs image detail — the two are a different kind of claim and are kept visibly separate.
- No batch/background enhancement of a whole clip or export — one frame/burst at a time, operator-driven,
  matching how the feature was asked for ("when paused on a frame").

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

**Status (M4):** ① and ② are built and verified, now including the multi-cut batch UI — a non-destructive
clip list, built from repeated range picks, exported as one batch (each clip still its own single-range
job, run in order through the existing 4-session queue, never in parallel); ③ is not built (needs the ISAPI
native-download endpoint, not yet reverse-engineered); the optional `player.html` is not built.
`manifest.json` does not yet carry "any enhancement applied" (7.8's L2 tier is built, but export and the AI
enhancer remain deliberately separate pipelines — 7.8.6).

---

## 11. Benefits for the live view (built from the same parts)

1. **Seamless grid ↔ focus:** re-parent the already-running player into the focus stage instead of tearing it down
   and reconnecting — no black frame, no stream restart, and the grid's other tiles keep running behind it.
2. **Instant replay on any live tile:** "◀ 10 s" from the RAM-only ring (4.3), with one-click return to live.
3. **Event awareness on live tiles:** motion/line-crossing/tamper/video-loss badges from `alertStream`, optional
   border flash, per-channel mute.
4. **Detach-and-review:** open a tile in playback while the rest of the grid keeps monitoring live.
5. **Live enhancement (L0)** on any tile — presets as quick-fill starting points, every slider under them
   individually adjustable and stackable (`web/js/enhancePanel.js`); snapshot saves the enhanced or the
   original frame, your choice. Playback panes additionally get a draggable ROI (enhance only inside the
   box) and a cursor-follow digital flashlight, both interactive-inspection tools that don't make sense on a
   moving live tile.
6. **Bookmark from live** in one keypress.

---

## 12. Decisions from round 2

1. **AI indexing per channel (4.2): confirmed configurable in Settings.** Every channel gets its own on/off toggle
   on the Channels page (next to the existing name/fps/aspect controls), default **off**. No default list is
   hard-coded — you turn on whichever channels matter once you can see the CPU cost per channel in Status, and
   change it any time. This lands in M3 (the milestone where the AI index itself is built); the toggle exists in
   Settings from that milestone on.
2. **DVR configuration (section 6): keep option 1 (leave ch 4 as it is) unless told otherwise** — this is the
   revised recommendation after discovering the DVR's line-crossing/intrusion engine is a single resource shared
   by all 8 channels (section 2.3), not independent per channel like I'd first assumed. I made no DVR changes;
   everything was tested and then reverted, verified byte-for-byte against a backup. If you'd rather move it to a
   different single channel (candidates and how in section 6, option 2), tell me which one.

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

**Status:** M0-M2 complete and verified. **M3 is only partially built** — the alarm/log event search UI
(camera/kind/date-range filters, deep-links into playback, a thumbnail per event) is done; live-forward AI
indexing, region/attribute search, and skip-empty are not started (they need a detector/tracker choice and
per-channel CPU budget decisions, section 12.1, before code); the background scan job is not built; **the
`smartSearch` spike ran and is closed, inconclusive** (2.3) — the endpoint is real but its schema couldn't
be recovered by black-box probing, so region/motion search over pre-AI-index history will go through the
background scan job (the fallback the spec always named), not a DVR-side smart query. **M4 is
split into pieces shipped separately, not one commit:** bookmarks (done); clipper + export options ①②
(done, including the multi-cut batch UI — option ③ is not built; exports run at the DVR's 16x
playback speed, verified frame-identical at that speed); **accounts + HTTPS + audit log + live sync
declined by you** — this is a local-network, single-operator deployment, so this piece of M4 is not being
built, by decision, not oversight. `author`/`operator` on bookmarks and exports stays a fixed placeholder
("Operator") permanently as a result, not pending something still to come. **M6's ML-enhancement half is
now also built, out of the original order** (section 7.8 — Real-ESRGAN + GFPGAN, optional multi-frame
align/fuse, optional on-demand OCR, launched from a paused Playback frame): every output is watermarked
"ENHANCED" both in the UI and on disk and always ships with its unenhanced source frame, matching this
row's acceptance bar. M6's *other* half (attribute model, loitering/counter-flow) is not started — those
need the live-forward AI index from M3 as their input, which isn't built. M5's L1 (ffmpeg/OpenCV multi-frame
fusion/denoise, no ML) is also not built; the multi-frame handling that exists now is the enhancer's own
classical align-and-fuse pre-step (7.8.2d), not a general-purpose L1 tier. The live L0 filter chain has since
grown noise reduction and auto white balance beyond its original set, still real-time and zero-cost when off.

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
