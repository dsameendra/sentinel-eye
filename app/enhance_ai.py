"""AI frame enhancer (spec: docs/enhance-ai-spec.md — M6 L2). Real-ESRGAN (general upscale) + GFPGAN
(face restoration), the standard documented pairing, run locally (no cloud calls). Optional multi-frame
input is aligned and fused (classical, not learned) before the AI pipeline for noise reduction.

Job/poll pattern mirrors app/export.py exactly (queued/running/done/error, swept after a TTL) — this is a
second, independent kind of background job, not layered onto export's.

Forensic-integrity requirements (spec section 6) are enforced here, not just in the UI: the source
(pre-AI) frame is always produced alongside the enhanced one, and the output filename/metadata always
says ENHANCED — there is no code path that returns an AI output without it.
"""
import io
import shutil
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from settings import DATA

ENHANCE_DIR = DATA / "enhance"
JOB_TTL = 2 * 3600  # same lifetime rationale as export.py: a download, not an archive
# Clamp the AI-upscaled output so it can't grow unreasonably — but this was originally set to 2048, which
# for a 1080p source (already the common case, this DVR's main streams — spec 2.1) meant Real-ESRGAN's
# real 4x output (4320px tall) got immediately downscaled back down to barely more than the *original*
# height (1152px, ~1.07x) before the operator ever saw it. That downscale doesn't just discard the AI's
# added detail, it actively softens/aliases it on the way back down — the result looked *worse* than the
# untouched source at the same displayed size, which is exactly the bug reported. 6000 lets a 1080p source
# keep its full 4x output (4320 < 6000, no clamp at all) and only kicks in for a source that was already
# larger going in.
MAX_DIM = 6000
# Real-ESRGAN's own memory footprint (a single conv-based forward pass, internally tiled at 400px already)
# never hit this on this Mac even at a full 4x 1920x1080 — this cap is CCSR-specific, see its comment in
# _ccsr_enhance for the actual OOM this was set against.
CCSR_MAX_SIDE = 1536

_jobs = {}
_jobs_lock = threading.Lock()

_models_lock = threading.Lock()
# Each job runs in its own daemon thread (start_enhance), but GFPGANer/RealESRGANer are process-wide
# singletons with mutable per-call state (FaceRestoreHelper's detected-face list, RealESRGANer's tiling
# buffers) — PyTorch does not make running .enhance() from two threads on the same instances safe, and
# this is a single-operator forensic tool where correctness matters far more than concurrent throughput.
# Found empirically, not just in theory: overlapping jobs (repeated requests before an earlier one
# finished) measurably slowed every job down together rather than each running at its own normal speed,
# consistent with GPU/MPS contention between concurrent forward passes on shared model state. Every actual
# inference call — not just model loading — goes through this lock, so jobs queue and run one at a time.
_inference_lock = threading.Lock()
_gfpgan = None
_realesrgan = None
_device = None
_ccsr_pipe = None
CCSR_DIR = DATA / "models" / "ccsr"


def _sweep_old_jobs():
    if not ENHANCE_DIR.exists():
        return
    cutoff = time.time() - JOB_TTL
    for d in ENHANCE_DIR.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ------------------------------------------------------------------ job tracking (mirrors export.py)
def get_job(job_id):
    with _jobs_lock:
        return dict(_jobs.get(job_id, {})) if job_id in _jobs else None


def start_enhance(job_id, images_b64, mode, channel, at_utc, engine="realesrgan"):
    """images_b64: list of base64-encoded PNG strings, oldest -> newest, 1-7 frames, same dimensions.
    engine: "realesrgan" (Real-ESRGAN+GFPGAN, fast, ~40s/frame on this Mac) or "ccsr" (CCSR-v2, a
    diffusion-based SOTA restoration model — see docs/enhance-ai-spec.md's engine comparison. Meaningfully
    slower: expect low-single-digit minutes per frame on this Mac's GPU, there being no way around a
    diffusion model doing real iterative denoising work instead of one upscale pass)."""
    _sweep_old_jobs()
    with _jobs_lock:
        _jobs[job_id] = {"state": "queued", "progress": "Queued…", "error": None, "done": False}
    t = threading.Thread(target=_run, args=(job_id, images_b64, mode, channel, at_utc, engine), daemon=True)
    t.start()


def _set(job_id, **kw):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kw)


def _run(job_id, images_b64, mode, channel, at_utc, engine="realesrgan"):
    import base64
    job_dir = ENHANCE_DIR / job_id
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        _set(job_id, state="running", progress="Decoding frames…")
        # wcplayer.js's grabFrames() sends canvas.toDataURL() output straight through — a full
        # "data:image/png;base64,...." URL, not bare base64 — strip the prefix if present so this works
        # regardless of whether a future caller sends the data URL or already-bare base64.
        raw = [b.split(",", 1)[1] if b.startswith("data:") else b for b in images_b64]
        frames = [np.array(Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB"))[:, :, ::-1].copy() for b in raw]
        if not frames:
            raise ValueError("No frames provided")
        dims = {(f.shape[0], f.shape[1]) for f in frames}
        if len(dims) > 1:
            raise ValueError("All frames must be the same size")

        if len(frames) > 1:
            _set(job_id, progress=f"Aligning and fusing {len(frames)} frames…")
            fused = _align_and_fuse(frames)
        else:
            fused = frames[0]

        # The "source" reference the UI's before/after and download-pair always carry — this is what
        # went into the AI pipeline, never regenerated or approximated after the fact. Recorded as its own
        # flag (not inferred from job state) so that if the AI step below fails, the client still knows
        # this fused frame is on disk and can fall back to showing/OCR-ing it rather than a bare error —
        # the alignment+fusion step succeeding is independent of whether Real-ESRGAN/GFPGAN are available.
        source_file = job_dir / "source.png"
        Image.fromarray(fused[:, :, ::-1]).save(source_file)
        _set(job_id, source_ready=True)

        if _inference_lock.locked():
            _set(job_id, progress="Waiting for another enhancement to finish…")
        with _inference_lock:
            if engine == "ccsr":
                _set(job_id, progress="Loading CCSR (first use can take a minute)…" if _ccsr_pipe is None else "Running CCSR (this takes longer — diffusion, not a single upscale pass)…")
                result = _ccsr_enhance(fused)
                faces_found = None  # CCSR doesn't do face-specific detection/restoration — see spec
            else:
                _set(job_id, progress="Loading models…" if _gfpgan is None else "Running AI enhancement…")
                result, faces_found = _enhance(fused, mode)
            # MPS (this Mac's GPU backend) doesn't always release memory back promptly between calls the
            # way CUDA's allocator does — left unmanaged, back-to-back jobs in one server session measurably
            # slow down over time (observed directly: a clean single job ran in ~40s, later ones crept well
            # past 100s with no other change). Freeing explicitly after each job keeps every job's speed
            # consistent regardless of how many ran before it in this process's lifetime.
            try:
                import torch
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            except Exception:
                pass  # best-effort hygiene — never fail a completed enhancement over cache cleanup

        h, w = result.shape[:2]
        if max(h, w) > MAX_DIM:
            scale = MAX_DIM / max(h, w)
            result = _resize(result, (int(w * scale), int(h * scale)))

        result_path = job_dir / "result.png"
        Image.fromarray(result[:, :, ::-1]).save(result_path)

        _set(job_id, state="done", progress="done", done=True, faces_found=faces_found,
             result_dims=[result.shape[1], result.shape[0]], source_dims=[fused.shape[1], fused.shape[0]])
    except Exception as e:
        _set(job_id, state="error", error=f"{type(e).__name__}: {e}")


def result_path(job_id):
    p = ENHANCE_DIR / job_id / "result.png"
    return p if p.exists() else None


def source_path(job_id):
    p = ENHANCE_DIR / job_id / "source.png"
    return p if p.exists() else None


# ------------------------------------------------------------------ OCR (optional, on demand — spec section 4a)
def ocr(job_id, which):
    """Reads whichever image ('result' or 'source') is already on disk for this job with Tesseract.
    Synchronous — a single already-decoded image is sub-second, no job/poll needed like the main pipeline.
    A *read*, not a generative step: nothing here can invent a character, but Tesseract can still misread
    real DVR footage (glare, low res, angle), so every line carries its own confidence and the caller is
    expected to show it as "read this, verify by eye" — never as a determined value on its own."""
    import pytesseract
    path = result_path(job_id) if which == "result" else source_path(job_id)
    if not path:
        raise FileNotFoundError("That frame isn't ready yet")
    from PIL import Image as PILImage
    img = PILImage.open(path)
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    lines = {}
    for i, text in enumerate(data["text"]):
        text = text.strip()
        conf = data["conf"][i]
        if not text or conf is None:
            continue
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            continue
        if conf < 0:  # Tesseract uses -1 for non-text regions
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, {"words": [], "confs": []})
        lines[key]["words"].append(text)
        lines[key]["confs"].append(conf)
    out = []
    for v in lines.values():
        out.append({"text": " ".join(v["words"]), "confidence": round(sum(v["confs"]) / len(v["confs"]), 1)})
    return out


# ------------------------------------------------------------------ multi-frame align + fuse (classical)
def _align_and_fuse(frames):
    """Aligns every frame to the middle one (translation only — real motion over a handful of frames at
    this DVR's ~15fps is small) via OpenCV ECC, then does a per-pixel *motion-adaptive* weighted blend —
    not a flat median/mean — against the reference frame.

    Why not a plain median (the original approach): whole-frame alignment corrects for camera/background
    motion, but does nothing for a subject that's independently moving — a person walking, a car driving
    by, exactly the kind of thing a forensic reviewer is usually trying to see clearly. At a pixel the
    subject only covers in 1-2 of 5 aligned frames, a median or mean pulls that pixel toward the *other*
    frames' background value — softening, ghosting, or partially erasing the one subject the whole feature
    exists to clarify. That's a real, confirmed failure mode of temporal fusion applied blindly, not a
    hypothetical.

    Fix: for each pixel, compare every aligned frame to the reference frame. Where they agree closely
    (static, well-aligned background), blend in the other frames at close to full weight — genuine
    sensor/compression noise reduction, the whole point of multi-frame input. Where they disagree sharply
    (motion, a moving subject, a misalignment residual), fade that frame's contribution toward zero, so the
    fused pixel falls back to the reference frame's own value instead of being averaged with something
    that doesn't belong there. The reference frame's own pixels are never down-weighted against themselves,
    so a single subject-in-motion frame degrades gracefully to "no denoising for that region", never to
    "moving subject blurred away"."""
    import cv2
    mid = len(frames) // 2
    ref = frames[mid]
    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    warp_mode = cv2.MOTION_TRANSLATION
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-4)
    # Below this per-pixel mean-abs-difference (0-255 scale), two frames are considered "the same content,
    # just noise" and blended at ~full weight; above it, weight fades to 0 over the next MOTION_FALLOFF —
    # i.e. a hard still frame gets denoised, a frame straddling a moving edge doesn't get blurred into it.
    MOTION_THRESH, MOTION_FALLOFF = 10.0, 15.0
    acc = ref.astype(np.float32)
    wsum = np.ones(ref.shape[:2], dtype=np.float32)
    for i, f in enumerate(frames):
        if i == mid:
            continue
        gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        warp_matrix = np.eye(2, 3, dtype=np.float32)
        try:
            _, warp_matrix = cv2.findTransformECC(ref_gray, gray, warp_matrix, warp_mode, criteria)
            warped = cv2.warpAffine(f, warp_matrix, (f.shape[1], f.shape[0]), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP)
        except cv2.error:
            continue  # alignment failed for this frame (e.g. too little texture) — skip it, don't fuse in a misaligned frame
        diff = np.abs(warped.astype(np.float32) - ref.astype(np.float32)).mean(axis=2)
        w = np.clip(1.0 - (diff - MOTION_THRESH) / MOTION_FALLOFF, 0.0, 1.0)
        acc += warped.astype(np.float32) * w[:, :, None]
        wsum += w
    fused = acc / wsum[:, :, None]
    return np.clip(fused, 0, 255).astype(np.uint8)


def _resize(img, wh):
    import cv2
    return cv2.resize(img, wh, interpolation=cv2.INTER_LANCZOS4)


# ------------------------------------------------------------------ model loading (lazy — first call pays the cost)
def _load_models():
    global _gfpgan, _realesrgan, _device
    with _models_lock:
        if _gfpgan is not None:
            return
        import torch
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
        from gfpgan import GFPGANer

        _device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        model_dir = DATA / "models"
        model_dir.mkdir(parents=True, exist_ok=True)

        rrdb = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        _realesrgan = RealESRGANer(
            scale=4, model_path="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
            model=rrdb, tile=400, tile_pad=10, pre_pad=0, half=False, device=_device,
        )
        _gfpgan = GFPGANer(
            model_path="https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth",
            upscale=4, arch="clean", channel_multiplier=2, bg_upsampler=_realesrgan, device=_device,
        )


def _enhance(bgr, mode):
    """Returns (enhanced_bgr, faces_found). mode: auto/face/plate/general."""
    if mode == "general":
        _load_models_upsampler_only()
        out, _ = _realesrgan.enhance(bgr, outscale=4)
        return out, 0
    if mode == "plate":
        _load_models_upsampler_only()
        out, _ = _realesrgan.enhance(bgr, outscale=4)
        return _classical_sharpen(out), 0

    _load_models()
    _, _, out = _gfpgan.enhance(bgr, has_aligned=False, only_center_face=False, paste_back=True)
    faces_found = len(_gfpgan.face_helper.all_landmarks_5) if hasattr(_gfpgan, "face_helper") else 0
    if mode == "auto" and faces_found == 0:
        return _classical_sharpen(out), 0
    return out, faces_found


def _load_models_upsampler_only():
    # "general"/"plate" modes never need GFPGAN's face model loaded — this trims first-use latency and
    # memory for the common non-face case, at the cost of a second lazy-load path.
    global _realesrgan, _device
    with _models_lock:
        if _realesrgan is not None:
            return
        import torch
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
        _device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        rrdb = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        _realesrgan = RealESRGANer(
            scale=4, model_path="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
            model=rrdb, tile=400, tile_pad=10, pre_pad=0, half=False, device=_device,
        )


# ------------------------------------------------------------------ CCSR (diffusion-based SOTA restoration)
# Vendored from github.com/csslc/CCSR (CCSR-v2 branch, Apache 2.0) into app/ccsr/ — see that directory's
# files for the exact patches applied (modern-diffusers import paths, MPS instead of the upstream's
# AUTOMATIC1111-webui-only device helper). Not installed as a pip package: CCSR ships as a set of scripts,
# not a library, so vendoring + patching was the only way to use it at all. docs/enhance-ai-spec.md section
# 2b covers why this engine exists (SUPIR, the first choice, needs 28GB+ RAM even in its most reduced
# documented config and CUDA-only quantization tooling this Mac's MPS backend can't run at all — a hard
# wall, not an engineering gap) and why CCSR-v2 is the practical SOTA-class substitute: Stable Diffusion
# 2.1-based (not SDXL), diffusers-native so MPS actually works, no captioning-model dependency, and
# documented support for as few as 1-2 diffusion steps.
def _load_ccsr():
    global _ccsr_pipe
    with _models_lock:
        if _ccsr_pipe is not None:
            return
        import torch
        from diffusers import UniPCMultistepScheduler
        from transformers import CLIPTextModel, CLIPTokenizer, CLIPImageProcessor
        from diffusers import AutoencoderKL, UNet2DConditionModel
        from ccsr.controlnet import ControlNetModel
        from ccsr.pipeline_ccsr import StableDiffusionControlNetPipeline

        base = CCSR_DIR / "sd21base"
        ccsr_weights = CCSR_DIR / "ccsrv2"
        if not base.exists() or not ccsr_weights.exists():
            raise RuntimeError("CCSR weights aren't downloaded yet — run tools/install_enhance_deps.sh (see its CCSR section)")

        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        # fp16 is the norm for diffusion inference (half the memory/time, fine on CUDA) but produced NaN
        # from the UNet/ControlNet forward pass itself on this Mac's MPS backend — confirmed directly: the
        # NaN was already present in the latents before they ever reached the VAE, i.e. not a VAE-precision
        # issue (that fix stays too, since it's correct regardless), but a real fp16-on-MPS instability in
        # the diffusion loop. This is a known class of MPS/fp16 issue, not unique to this checkpoint or
        # this custom pipeline. Correctness matters far more than speed for the engine that exists
        # specifically to be the "best it can be" option, so MPS runs in float32 throughout — slower, but
        # produces an actual image instead of a silently-all-black one.
        dtype = torch.float32 if device != "cuda" else torch.float16

        # variant="fp16": only the *.fp16.safetensors files were downloaded for the base SD2.1 components
        # (half the bandwidth/disk of the fp32 ones, and we run in fp16 anyway) — from_pretrained needs
        # telling, or it looks for the plain (fp32-named) files that don't exist here.
        scheduler = UniPCMultistepScheduler.from_pretrained(str(base), subfolder="scheduler")
        text_encoder = CLIPTextModel.from_pretrained(str(base), subfolder="text_encoder", variant="fp16")
        tokenizer = CLIPTokenizer.from_pretrained(str(base), subfolder="tokenizer")
        feature_extractor = CLIPImageProcessor.from_pretrained(str(base / "feature_extractor"))
        unet = UNet2DConditionModel.from_pretrained(str(base), subfolder="unet", variant="fp16")
        # CCSR's own controlnet checkpoint (trained stage 1) — not the "pre-trained" (imagenet-init) one,
        # which is a training starting point, not a usable inference checkpoint.
        controlnet = ControlNetModel.from_pretrained(str(ccsr_weights), subfolder="controlnet")
        vae = AutoencoderKL.from_pretrained(str(ccsr_weights), subfolder="vae")

        for m in (text_encoder, unet, controlnet):
            m.requires_grad_(False)
            m.to(device, dtype=dtype)
        # VAE stays float32 even though everything else is fp16: found empirically (a real inference run,
        # not a doc warning) that VAE decode in fp16 on this Mac's MPS backend produced NaNs that survived
        # silently as an all-black output (the float->uint8 cast clips NaN to 0, no error raised) — a known
        # instability class for SD-family VAEs generally, not unique to CCSR's checkpoint. The surrounding
        # pipeline_ccsr.py was patched (app/ccsr/) to cast into/out of the VAE's own dtype at each call site
        # rather than assuming fp16 throughout, so this one line is what actually controls it.
        vae.requires_grad_(False)
        vae.to(device, dtype=torch.float32)

        pipe = StableDiffusionControlNetPipeline(
            vae=vae, text_encoder=text_encoder, tokenizer=tokenizer, feature_extractor=feature_extractor,
            unet=unet, controlnet=controlnet, scheduler=scheduler, safety_checker=None, requires_safety_checker=False,
        )
        # Tiled VAE: essential, not optional, on this Mac's 18GB unified memory for a full-res encode/decode
        # of a multi-thousand-pixel image — this is exactly the memory-saving feature CCSR's own tile_vae
        # script uses for constrained hardware.
        pipe._init_tiled_vae(encoder_tile_size=512, decoder_tile_size=128)
        _ccsr_pipe = pipe


def _ccsr_enhance(bgr, upscale=4):
    """Returns the enhanced BGR array. Uses CCSR-v2's documented "multi-step" quality preset (6 steps,
    t_max/t_min/guidance_scale as given in their own README example) rather than the 1-step fast preset —
    this is the "best it can be" engine, chosen deliberately over Real-ESRGAN's speed; num_inference_steps
    still means low-single-digit *minutes*, not the tens of minutes a full 50-step SUPIR-class run would
    take, which is the whole reason this engine is viable here at all."""
    import cv2
    import torch
    from PIL import Image as PILImage

    _load_ccsr()
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    img = PILImage.fromarray(rgb)
    ori_w, ori_h = img.size
    target_w, target_h = ori_w * upscale, ori_h * upscale
    # This Mac's 18GB unified memory is the real ceiling (docs/enhance-ai-spec.md 2b), and it's shared with
    # the rest of this app running at the same time — confirmed directly: a full 1920x1080 frame at a
    # genuine 4x (7680x4320) hit a hard MPS OOM (~33M pixels) mid-run. A first attempt at capping this to
    # 2560px still OOM'd right at the tail end of a real 1920x1080 run (allocated+other landed at ~23.5GiB
    # against a ~22.6GiB ceiling, failing on a 256-byte allocation) — tiling bounds any *one* step's
    # activation memory, but the total accumulated allocation across 6 diffusion steps plus VAE encode/decode
    # still scales with canvas size and tile count, and that's what actually exhausted the ceiling. Backed
    # off further (1536px working side, plus smaller VAE tiles below) for real margin against the case that
    # actually failed, not just the one that happened to pass.
    if max(target_w, target_h) > CCSR_MAX_SIDE:
        scale = CCSR_MAX_SIDE / max(target_w, target_h)
        target_w, target_h = int(target_w * scale), int(target_h * scale)
    img = img.resize((target_w, target_h), PILImage.LANCZOS)
    # UNet/VAE both need 8-divisible dimensions — CCSR's own test script does exactly this rounding.
    w, h = (img.size[0] // 8) * 8, (img.size[1] // 8) * 8
    img = img.resize((w, h), PILImage.LANCZOS)

    device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    generator = torch.Generator(device=device if device != "mps" else "cpu")  # torch.Generator has no MPS backend; CPU-seeded generation still runs on the MPS pipeline fine
    generator.manual_seed(1234)

    _, out = _ccsr_pipe(
        0.6667, 0.5, True, 512, 256,  # t_max, t_min, tile_diffusion, tile_diffusion_size, tile_diffusion_stride
        "Cinematic, high contrast, highly detailed, hyper detailed photo-realistic maximum detail, "
        "sharp focus, clean, high-resolution, professional CCTV footage",
        img,
        num_inference_steps=6,
        generator=generator,
        height=h, width=w,
        guidance_scale=4.5,
        negative_prompt="blurry, dotted, noise, raster lines, unclear, lowres, over-smoothed, oil painting, cartoon, deformed",
        conditioning_scale=1.0,
        start_steps=999,
        start_point="lr",
        use_vae_encode_condition=True,
    )
    result = np.array(out.images[0].convert("RGB"))
    return cv2.cvtColor(result, cv2.COLOR_RGB2BGR)


def _classical_sharpen(bgr):
    """Non-AI legibility pass for plates/text and the no-face-found fallback (spec section 2/6): CLAHE
    contrast + a mild unsharp mask. Makes real detail more legible; invents nothing."""
    import cv2
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge((l, a, b))
    contrasted = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(contrasted, (0, 0), sigmaX=2)
    sharpened = cv2.addWeighted(contrasted, 1.5, blurred, -0.5, 0)
    return sharpened
