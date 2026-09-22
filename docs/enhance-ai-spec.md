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
a way a slightly-too-smooth face is not). Plates get Real-ESRGAN's general upscale plus a deliberately
mild, classical (non-AI) contrast/sharpen pass (CLAHE + unsharp mask) — real detail made more legible,
nothing invented. This is called out explicitly in the UI (section 5), not silently downgraded.

**Multi-frame input:** when a short burst of consecutive frames is provided (not just one), they're aligned
(OpenCV ECC, translational — handles the small motion typical over a handful of frames at ~15 fps) and
fused with a robust temporal mean *before* the AI pipeline runs. This is classical multi-frame denoising,
not a learned video-super-resolution model (BasicVSR-class models are heavy, slow on CPU/MPS, and the
marginal quality gain over align-and-fuse-then-single-frame-SR is small for a handful of frames spanning
well under a second) — but it's a real, well-understood technique: averaging several aligned, independently
noisy observations of the same static scene reduces sensor/compression noise that a single frame carries,
so the SR models above start from a cleaner input. It does nothing for a moving subject (alignment can't
un-blur genuine motion blur across frames) — the UI doesn't oversell this.

## 3. Pipeline

```
N frames (1–7, from the paused position's decode buffer, already in memory client-side)
  → [N > 1] align to the middle frame (ECC, translation) + robust mean fuse → 1 frame
  → Real-ESRGAN x4 upscale (background/whole-frame)
  → GFPGAN face detection + restoration, blended back into the upscaled frame (only if ≥1 face found)
  → [mode = "plate" or no faces found and mode = "auto"] CLAHE + unsharp mask, mild
  → clamp output to a sane max dimension (2048px longest side) — a 4x upscale of a 1080p frame is
    already past what's useful to look at, and larger just costs time/bandwidth for no benefit
  → PNG (lossless — this is the one place in the app a re-encode-with-loss would undermine the point)
```

Runs server-side (`app/enhance_ai.py`) — this needs real GPU/CPU compute (PyTorch, MPS-accelerated on this
Mac), not something to run in the browser. Frames themselves come from the *client's* already-decoded
WebCodecs buffer (`wcplayer.js`, which already holds ~30s/450 frames for stepping) — no new DVR playback
session is opened for this, so it doesn't touch the 4-session budget at all (spec 2.2/7.3) and works on
whatever's already on screen, paused, this instant.

## 4. API

- `POST /api/enhance` — body `{channel, at_utc, mode: "auto"|"face"|"plate"|"general", images: [base64 PNG, oldest→newest]}` (1–7 images, same dimensions). Starts a background job (same job/poll pattern as `/api/export`) since a burst + face restoration can take several seconds. Returns `{job_id}`.
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
