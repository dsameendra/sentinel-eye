# Frame Enhancer (M6 L2) — Specification

Status: build-as-written, implemented same session · Author: Claude · Date: 2026-09-22

Extends `docs/playback-spec.md` sections 7.13/8/14 — this is the "L2, ML-based" enhancement tier that
spec's M5/M6 named but didn't design in detail. L0 (WebGL live-adjust: gamma/sharpen/contrast/haze) is
already built and unaffected by this; this document covers only the new AI/ML tier.

## 1. Goal

From a single paused frame, or a short burst of consecutive frames, produce the clearest, sharpest,
highest-resolution version of that moment a forensic reviewer could plausibly use — especially faces and
licence plates — while being explicit, every time, that the output is AI-reconstructed detail and not
proof of what the original pixels actually contained.

Non-goals: real-time enhancement of a live/playing stream (L0 already covers "on the fly"); enhancing a
whole clip/export batch in one action (out of scope for this pass — one frame/burst at a time, from
Playback, paused); any claim that L2 output is usable as unaltered evidence (see 6).

## 2. Why AI/ML here, and which models

A single frame from this DVR is at best 1080p, H.265, day/night IR, often at some distance — a face or
plate can be a few dozen pixels wide. Classical upscaling (bicubic, Lanczos) doesn't add real detail, it
just interpolates existing pixels smoother — this is what "CSI zoom and enhance" jokes are about, and why a
naive implementation would look impressive on a demo image and useless on real DVR footage. A trained
super-resolution model, by contrast, has learned what real faces/plates/textures look like and can
plausibly reconstruct detail that's genuinely missing at the source resolution — which is powerful, and
exactly why it must never be presented as if it were the original (section 6).

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
face/general path — 2c/2d) — real detail made more legible, nothing invented. This is called out explicitly
in the UI (section 5), not silently downgraded.

### 2a. CCSR-v2 was tried and removed — diffusion denoising destroys exactly what this tool exists to read

A later pass added CCSR-v2, a diffusion-based (Stable Diffusion 2.1) SOTA restoration model, as a second,
user-selectable "best quality" engine (SUPIR, the model actually requested at the time, needs 28GB+ RAM and
CUDA-only tooling — a hard wall on this Mac's 18GB unified memory, surfaced to the user before writing
integration code; CCSR was the viable alternative). It was fully vendored, patched for MPS, tuned to avoid
out-of-memory, and worked end-to-end — but real DVR-footage testing showed its denoising step doesn't just
smooth sensor noise, it actively redraws small high-frequency detail (burned-in timestamps, plate
characters, small signage text) into plausible-looking but wrong shapes, because that's what a diffusion
model's learned prior does to anything it treats as "noise" rather than "signal." That's the single worst
failure mode this whole feature is designed against (section 6) — a confident-looking but fabricated
character — so the model was removed entirely rather than kept as an option a reviewer could reach for by
mistake. The vendored code and this section are gone from a later revert; this paragraph is kept only as a
record of why, since the natural next idea ("just use the SOTA diffusion model") was tried and has a
specific, confirmed reason not to work for this tool's actual content.

### 2b. Real forensic-enhancement practice, adapted to what's implementable here

The two improvements below (2c, 2d) are a direct translation of how manual forensic frame enhancement is
actually done — de-noise/stack a base layer, isolate the plate or face before upscaling it, use a
restoration model's *fidelity* control deliberately rather than at a fixed default — into what an in-browser
single/burst-frame tool can do without external software (Topaz Video AI, Photoshop) or a full compositing
pipeline. The one piece deliberately not adopted is producing a single "final composite" image (video +
plate callout + face callout stitched together): this tool's output is an interactive, zoomable single
image per subject, not a rendered still for a report, so a separate crop-per-subject workflow (below) serves
the same purpose without inventing a new artifact type.

### 2c. Region-of-interest crop — isolate before you upscale

The operator can drag a box over the displayed frame (source or result — the box is stored as fractions of
the frame, so it means the same thing on either) to crop to just a plate or face *before* alignment and
upscaling. This is the single highest-leverage change here: a plate that's 3% of a 1080p frame is still only
~3% of the frame after a flat 4x upscale of the whole scene — cropping first means every one of the AI
pipeline's output pixels goes to the subject that was actually asked about, not mostly to background
resolution nobody needed. Plate mode's fusion also changes when multiple frames and an ROI are combined
(2d): a tight crop is small enough, and moves close enough to rigidly, that ECC's own translation alignment
tracks it directly, so there's no separate "independently-moving subject" risk left to protect against —
see the median-stack note below.

### 2d. Two more direct translations of manual practice

- **Median stacking for plate mode.** When plate mode runs on more than one frame, fusion uses a plain
  per-pixel median across the ECC-aligned stack instead of the motion-adaptive weighted blend used
  elsewhere. The blend's whole reason to exist (§2, "multi-frame input") is protecting an independently-
  moving subject *elsewhere in a wide shot* from being averaged away — but that risk doesn't apply to a
  rigid plate/text region the way it does to a person walking through a wide scene, and a median is more
  robust than a mean against exactly the compression-block and sensor speckle noise that makes DVR digits
  ambiguous: it rejects outlier frames instead of blending them in, and every output pixel is a real pixel
  value from one input frame rather than an interpolated in-between value.
- **GFPGAN's fidelity weight, exposed instead of fixed.** GFPGAN's own `enhance()` call takes a `weight`
  parameter (0 = reconstruct freely from its learned face prior, can invent features; 1 = barely touch the
  input, stays blurry) that was previously left at its library default with no way to change it. It's now a
  slider in the popup (still defaulting to 0.5, GFPGAN's own documented default and the same middle ground
  forensic face-restoration guides recommend) so an operator can deliberately push toward "closer to the
  real pixels" or "let it reconstruct more" per frame, rather than getting one fixed trade-off always.

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

## 3. Pipeline

```
N frames (1–7, from the paused position's decode buffer, already in memory client-side)
  → [roi set] crop every frame to the operator-drawn region (2c) — before anything else
  → [N > 1] align to the middle frame (ECC, translation), then fuse → 1 frame:
      mode = "plate": per-pixel median across the aligned stack (2d)
      otherwise: motion-adaptive weighted blend against the reference frame
  → Real-ESRGAN x4 upscale (background/whole-frame)
  → GFPGAN face detection + restoration (fidelity weight from the operator, default 0.5 — 2d), blended back
    into the upscaled frame (only if ≥1 face found)
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
session is opened for this, so it doesn't touch the 4-session budget at all (spec 2.2/7.3) and works on
whatever's already on screen, paused, this instant.

## 4. API

- `POST /api/enhance` — body `{channel, at_utc, mode: "auto"|"face"|"plate"|"general", images: [base64 PNG, oldest→newest], roi: [x, y, w, h]|null, weight: 0.0-1.0}` (1–7 images, same dimensions). `roi` (optional, 2c) is fractions of the frame to crop to before enhancing. `weight` (default 0.5, 2d) is GFPGAN's fidelity knob. Starts a background job (same job/poll pattern as `/api/export`) since a burst + face restoration can take several seconds. Returns `{job_id}`.
- `GET /api/enhance/{job_id}` — `{state: queued|working|done|error, progress, error}`.
- `GET /api/enhance/{job_id}/result` — the enhanced PNG, once done.
- `GET /api/enhance/{job_id}/source` — the fused-but-not-AI-processed reference frame (the "before"), for the popup's before/after comparison — this is what the input actually looked like, not a claim about ground truth.
- `POST /api/enhance/{job_id}/ocr` — body `{which: "result"|"source"}`. Runs synchronously (Tesseract on a
  single already-in-hand image is sub-second, no job/poll needed) and returns `{lines: [{text, confidence}]}`.
  Optional, on-demand — never run automatically as part of the main pipeline (see 4a).

### 4a. OCR (optional, on demand)

Added on request as a genuinely useful but clearly-secondary aid: a "Read text" button in the popup that
runs **Tesseract OCR** (`pytesseract` + the local `tesseract` binary — Apache 2.0, the standard open-source
OCR engine, no cloud call) on whichever image is currently showing (enhanced or source) and lists what it
read, each line with Tesseract's own confidence score. This is deliberately kept separate from the main
enhance pipeline and the "modes" in section 3:

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

## 5. UI (Playback page)

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
    metadata/filename (section 6).
  - **Download both** — the enhanced PNG and the source (pre-AI) reference frame together, never the
    enhanced one alone, so whoever receives it always has the real frame it came from right next to it.
  - A **mode switch** (Auto / Face priority / Plate & text / General) to re-run with a different emphasis
    without re-grabbing frames — Auto picks face-restoration if GFPGAN finds a face, else the plate/general
    classical-sharpen path.
  - A **fidelity slider** (2d), shown for Face priority/Auto, controlling GFPGAN's real-pixels-vs-reconstruct
    trade-off — defaults to 0.5, re-runs on release.
  - A **"Select region" tool** (2c): drag a box over the image to isolate a plate or face; clears with one
    click. Re-runs automatically on release, cropping to that region before every later step.

## 6. Forensic integrity (spec §14's stated risk, addressed directly here)

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
  not left implicit. Export's existing signed evidence package (spec §10) explicitly does *not* run this
  pipeline; the two are kept separate on purpose.

## 7. What this does not attempt

- No video-level super-resolution model (BasicVSR/EDVR-class) — see §2's multi-frame note; the align-and-
  fuse approach is a deliberate, explained trade-off, not an oversight.
- No license-plate-specific *generative* recognition (no model that outputs "the plate is ABC123") — the
  app enhances pixels, a human reads them. Plain OCR (section 4a) is offered as an optional convenience on
  top of that, but it reads what's on screen, it doesn't reconstruct or guess a plate the way the SR/face
  pipeline reconstructs image detail — the two are a different kind of claim and are kept visibly separate.
- No batch/background enhancement of a whole clip or export — one frame/burst at a time, operator-driven,
  matching how the feature was asked for ("when paused on a frame").
