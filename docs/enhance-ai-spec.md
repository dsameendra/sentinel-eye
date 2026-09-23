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

### 2a. Two engines, user's choice

Added on request ("make it the best it can be") as a second, selectable engine — Real-ESRGAN+GFPGAN stays
the default (fast, ~40s/frame, already proven), and CCSR-v2 is offered as "best quality, slow" for when
that matters more than turnaround time. The mode row (auto/face/plate/general) is Real-ESRGAN-specific and
hides when CCSR is selected — CCSR has no equivalent concept, it restores everything through one unified
pass.

### 2b. SUPIR was asked for first; CCSR-v2 is what's actually viable on this Mac

SUPIR ("Scaling-Up Image Restoration") was the requested first choice and, on capability alone, is the
stronger of the two. It wasn't used: its own documented *minimum* configuration needs ~12GB for the
diffusion model plus ~16GB for LLaVA (its captioning step) — 28GB+, and even that reduced mode depends on
`bitsandbytes` 8-bit quantization, which is CUDA-only and has no Apple Silicon/MPS build at all. This Mac
has 18GB of *unified* memory, shared with macOS and the rest of this app running at the same time. Its
own environment is pinned to Python 3.8 with a CUDA-oriented stack (xformers, bitsandbytes,
flash-attention) that would need porting on top of the memory problem. This isn't "needs more engineering
time" — it's a hardware ceiling checked directly against SUPIR's own numbers, confirmed with the user
before spending any further effort on it.

**CCSR-v2** (github.com/csslc/CCSR, CCSR-v2 branch, Apache 2.0) is the practical substitute: built on
Stable Diffusion **2.1** (not SDXL, roughly a third the size), implemented against the standard
`diffusers` library (real MPS support, unlike SUPIR's CUDA-only stack), no captioning-model dependency,
and — its actual headline feature — documented support for as few as 1-2 diffusion steps instead of
SUPIR's default 50. Total weights: ~2.4GB (SD2.1-base) + ~1.7GB (CCSR's own ControlNet + VAE checkpoints)
≈ 4GB, versus SUPIR's 28GB+ floor. The CCSR-v2 paper directly benchmarks itself against SUPIR (among
others) on stability and fidelity, so this isn't "the model that happened to fit" — it's a real SOTA-class
restoration model in its own right, just a lighter architecture.

**Pipeline (6 steps, the values CCSR's own README gives as its "multi-step diffusion" example):** align the
input to a 4x-upscaled, 8-divisible canvas → CCSR's ControlNet-guided diffusion denoising, tiled (both the
UNet/ControlNet pass and the VAE encode/decode) so a multi-thousand-pixel image never has to fit in memory
all at once → decode. No text prompt describing the *scene* is needed or used beyond a fixed
"photo-realistic, sharp, clean CCTV footage" steer plus the DVR frame itself as the conditioning image —
CCSR restores from the image, it doesn't generate from a description of it.

**Not a pip install:** CCSR ships as scripts (not a package) pinned to `diffusers==0.21.0`/
`transformers==4.25.0` — versions with no wheels for a Python this new, and CCSR's custom pipeline/
ControlNet code assumes CUDA in several places. Rather than fight ancient pinned versions, the four files
that actually need CCSR's custom code (`pipeline_ccsr.py`, `controlnet.py` — a genuine architectural fork
of diffusers' ControlNet, not a drop-in replacement, confirmed by diffing it against upstream — `vaehook.py`
for tiling, `wavelet_color_fix.py`) are vendored into `app/ccsr/` against the *current* `diffusers`, with
the real incompatibilities found and fixed by actually running the pipeline rather than by inspection:

- Import paths for symbols diffusers has since reorganized into subpackages (`diffusers.models.unets.*`),
  and a mixin (`FromOriginalControlnetMixin`) that no longer exists and was safe to drop (only used as an
  unused base class).
- The upstream device helper imports an AUTOMATIC1111-webui-only module (`modules.mac_specific`); replaced
  with a direct `torch.backends.mps` check — it's all that helper actually did — and a hardcoded
  `torch.device("cuda")` default, wrong on this machine regardless.
- Two unconditional `torch.cuda.synchronize()` calls (perf timestamps around the sampling loop) — guarded
  to fall through to `torch.mps.synchronize()` instead of hard-crashing the process with `AssertionError:
  Torch not compiled with CUDA enabled`.
- A `torch.tensor(weights, device=self.device)` building the tile-blend Gaussian mask from a numpy
  `float64` array — MPS doesn't support float64 at all (`TypeError`); cast to float32 first.
- A scheduler attribute (`self.scheduler.custom_timesteps`) that existed in diffusers 0.21.0 but not in the
  version installed here; read via `getattr(..., False)` instead of a bare attribute access.
- A single-step `add_noise()` call passed a 0-d (scalar) timestep tensor where the current diffusers
  expects something iterable — `.reshape(-1)` fixes it without changing what it computes.
- **The one real, independent bug, not a version-drift symptom:** `_sliding_windows()`'s tile-splitting math
  produces *zero* tiles when the image is smaller than one tile (`h < tile_size`) — a genuine off-by-logic
  error in the upstream code (Python's modulo on a negative dividend can still be 0, silently skipping the
  "did we miss a partial tile" fallback too). With zero tiles, the accumulation loop downstream never runs,
  and dividing the still-all-zero prediction by the still-all-zero weight count produces an all-NaN result
  three function calls later — no exception anywhere in between, just a black frame. Found by actually
  running a real (small) image through the pipeline, not by code review; fixed by clamping the tile size to
  the image's own dimensions, guaranteeing at least one window always exists.
- **fp16-on-MPS instability, found the same way:** even after every fix above, real inference produced a
  provably-valid-shaped output that was NaN throughout. Traced (by inserting temporary instrumentation and
  checking `torch.isnan()` at each stage, not by guessing) to the UNet/ControlNet forward pass itself — the
  latents going in were clean, the ones coming out were already NaN. This is a known class of MPS+fp16
  instability, not unique to this checkpoint. Fixed by running the whole pipeline in float32 on MPS instead
  of the usual fp16 (fp16 is kept for an actual CUDA device, where it's proven stable) — slower, but
  produces a real image instead of a silently-black one. Several other call sites in the vendored pipeline
  hardcoded `.to(torch.float16)` regardless of what dtype the rest of the pipeline was actually running in
  (including inside the now-fixed tile-blend function) — each changed to defer to the model's/VAE's actual
  dtype instead of assuming fp16.
- A stock-diffusers `CrossAttnDownBlock2D`/`UNetMidBlock2DCrossAttn` call in the vendored ControlNet passed
  an `image_encoder_hidden_states` kwarg those stock blocks have never accepted — vestigial from a CCSR
  variant that isn't this checkpoint (confirmed via this checkpoint's own config: `use_image_cross_attention:
  false`) — dropped rather than plumbed through.

**Model provenance:** the official `stabilityai/stable-diffusion-2-1-base` HuggingFace repo now requires a
logged-in, license-accepted account to download at all (previously public) — this install has no user HF
token, so an ungated community mirror of the identical public weights (`Manojb/stable-diffusion-2-1-base`,
same filenames) is used instead. CCSR's own ControlNet/VAE checkpoints are only published by the authors
via Google Drive/Baidu (no official HF mirror); a diffusers-format community re-upload
(`YaronElh/CCSR-v2`) is used for the same reason SD2.1 needed one — scripted downloads need a stable HTTP
URL, not an interactive-login file host.

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
  → [N > 1] align to the middle frame (ECC, translation) + motion-adaptive weighted fuse → 1 frame
  → Real-ESRGAN x4 upscale (background/whole-frame)
  → GFPGAN face detection + restoration, blended back into the upscaled frame (only if ≥1 face found)
  → [mode = "plate" or no faces found and mode = "auto"] CLAHE + unsharp mask, mild
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

- `POST /api/enhance` — body `{channel, at_utc, mode: "auto"|"face"|"plate"|"general", engine: "realesrgan"|"ccsr", images: [base64 PNG, oldest→newest]}` (1–7 images, same dimensions; `mode` only matters for the `realesrgan` engine). Starts a background job (same job/poll pattern as `/api/export`) — a Real-ESRGAN+GFPGAN pass takes tens of seconds, a CCSR pass (real iterative diffusion, section 2b) low-single-digit minutes. Returns `{job_id}`.
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
