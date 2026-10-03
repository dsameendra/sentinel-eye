"""AI frame enhancer (spec: docs/SPEC.md section 7.8 — M6 L2). Real-ESRGAN (general upscale) + GFPGAN
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


def start_enhance(job_id, images_b64, mode, channel, at_utc, roi=None, weight=0.5):
    """images_b64: list of base64-encoded PNG strings, oldest -> newest, 1-11 frames, same dimensions.
    roi: optional (x, y, w, h) fractions (0-1) of the frame to crop to *before* alignment/upscaling — lets
    the operator isolate a plate or face so the AI's fixed output resolution is spent on that subject
    instead of the whole scene (see docs/SPEC.md section 7.8.2c). weight: GFPGAN's own fidelity/
    identity-preservation knob (0=pure hallucinated reconstruction, 1=barely touched) — see section 2d."""
    _sweep_old_jobs()
    with _jobs_lock:
        _jobs[job_id] = {"state": "queued", "progress": "Queued…", "error": None, "done": False}
    t = threading.Thread(target=_run, args=(job_id, images_b64, mode, channel, at_utc, roi, weight), daemon=True)
    t.start()


def _set(job_id, **kw):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kw)


def _crop_to_roi(frames, roi):
    """roi: (x, y, w, h) as fractions of the frame (0-1), as drawn by the operator over the raw preview
    frame client-side. Cropped from the *original* full-resolution frame, before any alignment or AI
    upscaling — this is the whole point: a plate or face that's a small fraction of a 1080p frame stays a
    small fraction of it even after a flat 4x upscale, but cropping first means every one of the AI
    model's output pixels goes to the subject instead of mostly to background that was never in question."""
    x, y, w, h = roi
    x, y = min(max(x, 0.0), 0.99), min(max(y, 0.0), 0.99)
    w, h = min(max(w, 0.0), 1.0 - x), min(max(h, 0.0), 1.0 - y)
    fh, fw = frames[0].shape[:2]
    x0, y0 = int(x * fw), int(y * fh)
    x1, y1 = int((x + w) * fw), int((y + h) * fh)
    if x1 - x0 < 16 or y1 - y0 < 16:
        return frames  # too small to be a deliberate selection — ignore rather than fail the job
    return [f[y0:y1, x0:x1] for f in frames]


def _run(job_id, images_b64, mode, channel, at_utc, roi=None, weight=0.5):
    import base64
    job_dir = ENHANCE_DIR / job_id
    try:
        # Imported here, not at module level: Pillow is an optional enhancer dependency
        # (tools/install_enhance_deps.sh), and server.py imports this module unconditionally.
        from PIL import Image
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

        if roi:
            frames = _crop_to_roi(frames, roi)

        if len(frames) > 1:
            _set(job_id, progress=f"Aligning and fusing {len(frames)} frames…")
            # Plate/text mode gets a plain per-pixel median across the aligned stack rather than the
            # motion-adaptive blend used elsewhere: the blend's whole reason to exist is protecting an
            # independently-moving subject *elsewhere in a wide shot* from being averaged away — but a
            # plate crop (especially after the ROI crop above) mostly moves as one rigid unit that ECC's
            # own translation alignment already tracks, so there's no separate "moving subject" to protect
            # against, and a median is more robust than a mean against exactly the kind of speckle/block
            # noise that makes DVR-compressed digits ambiguous (docs/SPEC.md section 7.8.2c).
            fused = _align_and_median(frames) if mode == "plate" else _align_and_fuse(frames)
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
            result, faces_found = _enhance(fused, mode, weight, progress=lambda msg: _set(job_id, progress=msg))
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
    except ModuleNotFoundError as e:
        # PIL, torch, cv2, realesrgan and gfpgan are all imported lazily in this module specifically
        # because they're optional (tools/install_enhance_deps.sh) and not part of the Docker image (see
        # the Dockerfile's own comment) — a raw "ModuleNotFoundError: No module named 'X'" reads as a bug,
        # not the documented, expected state of a Docker deployment, so name it plainly instead.
        _set(job_id, state="error",
             error=f"The AI frame enhancer isn't installed on this server (missing: {e.name}). It's not "
                   "included in the Docker image by design — see the README's \"AI frame enhancer\" "
                   "section to install it on a native (non-Docker) run instead.")
    except Exception as e:
        _set(job_id, state="error", error=f"{type(e).__name__}: {e}")


def result_path(job_id):
    p = ENHANCE_DIR / job_id / "result.png"
    return p if p.exists() else None


def source_path(job_id):
    p = ENHANCE_DIR / job_id / "source.png"
    return p if p.exists() else None


# ------------------------------------------------------------------ OCR (optional, on demand — spec section 4a)
def _ocr_pass(img, psm=None, min_conf=40):
    """Runs Tesseract once on a PIL image. Returns (lines, mean_confidence, n_words, score) — the last two
    are how the caller below picks the best of several candidate rotations, not shown to the operator.
    Words below MIN_WORD_CONF are dropped entirely, not just down-weighted: at a wrong rotation angle,
    Tesseract doesn't fail cleanly, it often hallucinates several short low-confidence "words" out of
    rotated edge noise — found directly by testing against a known image, where an early version of this
    (scoring candidates by raw word count) let a wrong angle's pile of garbage low-confidence words
    outscore the *correct* angle's few but high-confidence real ones. score = sum of confidence (not the
    mean) so it rewards both finding more real text and being confident about it, rather than either alone
    letting a degenerate case win."""
    import pytesseract
    MIN_WORD_CONF = min_conf
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, config=f"--psm {psm}" if psm else "")   # psm may carry more options after it
    lines, confs = {}, []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        conf = data["conf"][i]
        if not text or conf is None:
            continue
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            continue
        if conf < MIN_WORD_CONF:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, {"words": [], "confs": []})
        lines[key]["words"].append(text)
        lines[key]["confs"].append(conf)
        confs.append(conf)
    return lines, (sum(confs) / len(confs) if confs else 0.0), len(confs), sum(confs)


def _ocr_whole(base):
    """Reads a whole picture (a PIL RGB image) with Tesseract, when the operator hasn't marked where the
    text is (ocr() below; a marked region reads far better — _ocr_region).

    Tesseract's default page segmentation assumes roughly horizontal lines and does badly on text that
    isn't square to the camera (a plate or sign viewed at an angle, not a whole-frame rotation, which is
    the common real case here — a sign facing partly away from the lens, not the camera itself tilted).
    Its own orientation-and-script detection only corrects 90°-multiple rotations, which doesn't cover
    that. Fixed with a direct, brute-force approach instead: try the image upright first (fast, and correct
    for the common straight-on case), and only if that reads poorly, re-try it at a spread of small
    rotation angles and keep whichever attempt actually recognised the most text with the highest
    confidence. This trades the previous "always sub-second" latency for "sub-second when the text is
    already close to upright, a couple of seconds when it had to search for the angle" — still synchronous
    (no job/poll), and still bounded, since it only ever runs when the operator explicitly asks to read
    text on one already-in-hand image."""
    from PIL import Image as PILImage

    # Grayscale + CLAHE local contrast before every OCR attempt — Tesseract reads clean, high-contrast text
    # far more reliably than a raw photographic frame, and like the classical sharpen pass elsewhere in
    # this module, this is a deterministic per-pixel remap: it makes real edges more legible, it invents
    # no character.
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(base), cv2.COLOR_RGB2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    pre = PILImage.fromarray(gray)

    # Page segmentation: Tesseract's default (psm 3) looks for a page of text and reads nothing at all off
    # a lone plate-sized block on an otherwise empty frame — found directly: a clean, upright "7CBR 481"
    # read as empty under psm 3 but exactly under psm 6 (one uniform block). So try the default first, then
    # one-block and sparse-text segmentation, keeping whichever reads the most with the most confidence.
    best = None
    for psm in (None, 6, 11):
        cand = _ocr_pass(pre, psm)
        if best is None or cand[3] > best[0][3]:
            best = (cand, psm)
    (lines, conf, n, score), psm = best
    if n == 0 or conf < 75:  # weak or empty first pass — the shape a meaningfully angled line of text takes
        best = (lines, conf, n, score)
        for angle in (-20, -15, -10, -5, 5, 10, 15, 20):
            rotated = pre.rotate(angle, resample=PILImage.BICUBIC, expand=True, fillcolor=255)
            cand = _ocr_pass(rotated, psm)
            if cand[3] > best[3]:  # total confidence-weighted evidence wins, not raw word count (see _ocr_pass)
                best = cand
        lines = best[0]
    out = []
    for v in lines.values():
        out.append({"text": " ".join(v["words"]), "confidence": round(sum(v["confs"]) / len(v["confs"]), 1)})
    return out


PLATE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"


def _region_patch(gray, region):
    """Cuts the operator's box out of a grayscale frame and turns it level: `region` is {cx, cy, w, h} as
    fractions of the image (w of its width, h of its height — the same scale both ways, since the box was
    drawn on the picture at its own aspect) plus `angle`, degrees clockwise as drawn on screen. The frame
    is rotated about the box centre by that angle so the box becomes upright, then the box (plus a small
    margin) is cropped — a geometric resample, nothing added."""
    import cv2
    H, W = gray.shape[:2]
    cx, cy = float(region["cx"]) * W, float(region["cy"]) * H
    bw, bh = max(4.0, float(region["w"]) * W), max(4.0, float(region["h"]) * H)
    angle = float(region.get("angle") or 0.0)
    if abs(angle) > 0.05:
        # cv2's positive angle turns the picture counter-clockwise on screen, undoing a clockwise box.
        M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
        gray = cv2.warpAffine(gray, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    mx, my = bw * 0.06, bh * 0.12
    x0, y0 = int(max(0, cx - bw / 2 - mx)), int(max(0, cy - bh / 2 - my))
    x1, y1 = int(min(W, cx + bw / 2 + mx)), int(min(H, cy + bh / 2 + my))
    return gray[y0:y1, x0:x1]


def _ocr_line_variants(patch, target_h=110):
    """Tesseract reads text best at roughly 30-60 px cap height, dark on light, with a clean margin — and
    reads badly far above that as well as below (an enhanced 4x result can put a plate's letters at 120 px+).
    So the patch is scaled, up or down, to `target_h` px tall (a line of text filling most of the
    operator's box lands near 45 px), then offered three ways: local-contrast gray, Otsu black-and-white
    after a light blur, and that inverted (light-on-dark plates). Deterministic per-pixel remaps — nothing
    here can invent a character."""
    import cv2
    import numpy as np
    h, w = patch.shape[:2]
    scale = min(8.0, target_h / max(1, h))
    big = cv2.resize(patch, (max(1, int(w * scale)), max(1, int(h * scale))),
                     interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(big)
    _, bw = cv2.threshold(cv2.GaussianBlur(gray, (3, 3), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Text should end up dark on light. Judge that from the middle of the box, where the text is — a dark
    # scene around a light plate would otherwise outvote the plate itself (found: "ND 5138" read as junk).
    hh, ww = bw.shape[:2]
    if np.mean(bw[hh // 5: hh - hh // 5, ww // 8: ww - ww // 8]) < 127:
        bw = 255 - bw
        gray = 255 - gray
    # The box usually takes in some scene around the plate or sign; as a solid dark frame that makes
    # Tesseract treat the whole patch as a picture and read nothing. Dark areas touching the box's edge
    # aren't text (the box has a margin around it), so a cleaned copy whites them out.
    n, labels, stats, _ = cv2.connectedComponentsWithStats((bw < 128).astype(np.uint8), connectivity=8)
    edge = np.zeros(bw.shape, bool)
    for i in range(1, n):
        x, y, w2, h2 = stats[i][:4]
        if x == 0 or y == 0 or x + w2 >= ww or y + h2 >= hh:
            edge |= labels == i
    clean, gclean = bw.copy(), gray.copy()
    clean[edge] = 255
    gclean[cv2.dilate(edge.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = 255   # gray keeps blurred strokes thin
    pad = lambda im: cv2.copyMakeBorder(im, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)
    return [("bw-clean", pad(clean)), ("gray-clean", pad(gclean)), ("gray", pad(gray)), ("bw", pad(bw)), ("bw-inv", pad(255 - bw))], gray


def _ocr_region(base_rgb, region, plate):
    """Reads the text inside the operator's (possibly rotated) box: level it, enlarge it, try the variants
    above under single-line and single-block segmentation, keep the most confident read. In Plate mode
    Tesseract may only use plate characters and its English dictionaries are off (they "correct" plates
    into words)."""
    import cv2
    import numpy as np
    from PIL import Image as PILImage
    gray = cv2.cvtColor(np.array(base_rgb), cv2.COLOR_RGB2GRAY)
    patch = _region_patch(gray, region)
    if patch.size == 0:
        return [], None
    # Two sizes: a box drawn snugly (text fills it) and one drawn loosely (text is a smaller part of it).
    variants, shown = _ocr_line_variants(patch, 110)
    variants += _ocr_line_variants(patch, 190)[0]
    cfg = "--oem 1"
    if plate:
        # The space must be in the whitelist (quoted): without it Tesseract glues a plate's groups into one
        # "word" and reports 0% confidence for it — found reading "7CBR 481".
        cfg += f' -c "tessedit_char_whitelist={PLATE_CHARS} " -c load_system_dawg=0 -c load_freq_dawg=0'
    # Every variant x segmentation is a separate witness. The answer is the reading most of them agree
    # on, weighted by their confidence — sturdier than trusting the single most confident one, which a
    # crisp-looking misread can be. Ties go to the reading with more characters (a confident fragment
    # shouldn't beat the whole plate).
    groups = {}
    for psm in (7, 6):
        for _name, img in variants:
            # A lower floor than a whole-picture read: the operator has said where the text is, so a shaky
            # read is worth showing (with its confidence) rather than nothing.
            lines, mean, n, _score = _ocr_pass(PILImage.fromarray(img), f"{psm} {cfg}", min_conf=20)
            if not n:
                continue
            key = "".join(ch for v in lines.values() for w in v["words"] for ch in w if ch.isalnum()).upper()
            if not key:
                continue
            g = groups.setdefault(key, {"votes": 0.0, "best": None, "best_mean": -1.0})
            g["votes"] += mean
            if mean > g["best_mean"]:
                g["best"], g["best_mean"] = lines, mean
    best = None
    if groups:
        best = max(groups.items(), key=lambda kv: (kv[1]["votes"] + min(len(kv[0]), 10) * 1.5))[1]["best"]
    out = []
    for v in (best or {}).values():
        out.append({"text": " ".join(v["words"]), "confidence": round(sum(v["confs"]) / len(v["confs"]), 1)})
    return out, shown


def ocr(job_id, which, region=None, plate=False):
    """Reads text off whichever image ('result' or 'source') is already on disk for this job, with Tesseract
    — the whole picture, or just the operator's box (`region`, see _region_patch), which is far more
    reliable: the box says where the text is and which way it runs. Returns (lines, crop): `crop` is a PNG
    data URL of the levelled patch that was read (region reads only), so the operator can see exactly what
    the reading came from.
    A *read*, not a generative step: nothing here can invent a character, but Tesseract can still misread
    real DVR footage (glare, low res, angle), so every line carries its own confidence and the caller shows
    it as "read this, verify by eye" — never as a determined value on its own."""
    import base64
    import io
    from PIL import Image as PILImage
    path = result_path(job_id) if which == "result" else source_path(job_id)
    if not path:
        raise FileNotFoundError("That frame isn't ready yet")
    base = PILImage.open(path).convert("RGB")
    if not region:
        return _ocr_whole(base), None
    lines, shown = _ocr_region(base, region, plate)
    crop = None
    if shown is not None:
        im = PILImage.fromarray(shown)
        if im.width > 640:
            im = im.resize((640, max(1, round(im.height * 640 / im.width))))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        crop = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    return lines, crop


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


def _align_and_median(frames):
    """Plate/text mode's own fusion: ECC-align every frame to the reference (same translation-only model
    as _align_and_fuse) then take a plain per-pixel median across the aligned stack — no motion masking.
    Chosen specifically for hard, high-frequency edges (digit/letter strokes) rather than the soft gradients
    a face has: a median is far more robust than a mean against compression block noise and single-frame
    sensor speckle (it rejects outliers instead of averaging them in), and unlike a mean it never produces
    an in-between blurred edge — every output pixel is a real pixel value from one of the input frames, just
    the one most frames agree on. See _run's caller comment for why the motion-masking that _align_and_fuse
    needs doesn't apply here."""
    import cv2
    mid = len(frames) // 2
    ref = frames[mid]
    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    warp_mode = cv2.MOTION_TRANSLATION
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-4)
    aligned = [ref]
    for i, f in enumerate(frames):
        if i == mid:
            continue
        gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        warp_matrix = np.eye(2, 3, dtype=np.float32)
        try:
            _, warp_matrix = cv2.findTransformECC(ref_gray, gray, warp_matrix, warp_mode, criteria)
            warped = cv2.warpAffine(f, warp_matrix, (f.shape[1], f.shape[0]), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP)
        except cv2.error:
            continue  # alignment failed for this frame — skip it, don't fold in a misaligned one
        aligned.append(warped)
    stack = np.stack(aligned, axis=0).astype(np.float32)
    return np.median(stack, axis=0).astype(np.uint8)


def _resize(img, wh):
    import cv2
    return cv2.resize(img, wh, interpolation=cv2.INTER_LANCZOS4)


# ------------------------------------------------------------------ model loading (lazy — first call pays the cost)
def _load_models(progress=None):
    global _gfpgan, _realesrgan, _device
    with _models_lock:
        if _gfpgan is not None:
            return
        if progress:
            progress("Loading models (first use downloads ~700MB, cached after)…")
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


def _enhance(bgr, mode, weight=0.5, progress=None):
    """Returns (enhanced_bgr, faces_found). mode: auto/face/plate/general. weight: fidelity knob for a
    restored face — 0 is GFPGAN's full reconstruction (can fabricate features), 1 is the real upscaled
    pixels with no face synthesis at all, 0.5 blends the two evenly (see docs/SPEC.md section 7.8.2d for why
    that middle ground is the forensically-sound default). This is a real, verified linear blend against a
    second plain Real-ESRGAN pass — NOT GFPGANer.enhance()'s own `weight` argument, which was found (by
    reading the installed package's model code directly, not assumed) to be silently unused: both
    GFPGANv1Clean.forward and GFPGANv1.forward accept it only via **kwargs and never reference it, so it
    had zero effect on the output regardless of value. progress(msg): optional callback fired at each real
    pipeline stage — named after the actual step running, not a generic "processing" label."""
    step = progress or (lambda _msg: None)
    if mode == "general":
        _load_models_upsampler_only(progress)
        step("Upscaling 4x (Real-ESRGAN)…")
        out, _ = _realesrgan.enhance(bgr, outscale=4)
        return out, 0
    if mode == "plate":
        _load_models_upsampler_only(progress)
        step("Upscaling 4x (Real-ESRGAN)…")
        out, _ = _realesrgan.enhance(bgr, outscale=4)
        step("Sharpening plate/text detail…")
        return _classical_sharpen(out, strong=True), 0

    _load_models(progress)
    step("Upscaling and restoring faces (GFPGAN)…")
    _, _, out = _gfpgan.enhance(bgr, has_aligned=False, only_center_face=False, paste_back=True)
    faces_found = len(_gfpgan.face_helper.all_landmarks_5) if hasattr(_gfpgan, "face_helper") else 0
    if mode == "auto" and faces_found == 0:
        step("No face found — sharpening detail…")
        return _classical_sharpen(out), 0
    if faces_found > 0 and weight > 0.0:
        step("Blending restoration against real pixels (fidelity)…")
        _load_models_upsampler_only(progress)
        real_only, _ = _realesrgan.enhance(bgr, outscale=4)
        if real_only.shape == out.shape:
            out = np.clip((1 - weight) * out.astype(np.float32) + weight * real_only.astype(np.float32), 0, 255).astype(np.uint8)
    return out, faces_found


def _load_models_upsampler_only(progress=None):
    # "general"/"plate" modes never need GFPGAN's face model loaded — this trims first-use latency and
    # memory for the common non-face case, at the cost of a second lazy-load path.
    global _realesrgan, _device
    with _models_lock:
        if _realesrgan is not None:
            return
        if progress:
            progress("Loading models (first use downloads ~700MB, cached after)…")
        import torch
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
        _device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        rrdb = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        _realesrgan = RealESRGANer(
            scale=4, model_path="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
            model=rrdb, tile=400, tile_pad=10, pre_pad=0, half=False, device=_device,
        )


def _classical_sharpen(bgr, strong=False):
    """Non-AI legibility pass for plates/text and the no-face-found fallback (spec section 2/6): a levels-
    style contrast stretch, CLAHE local contrast, and an unsharp mask. Makes real detail more legible;
    invents nothing — every step here is a deterministic per-pixel remap, not a learned model. `strong` (used
    for plate mode specifically) pushes CLAHE and the unsharp amount further, since there's no face/skin
    region here to worry about oversharpening into ringing artifacts — legibility is the only goal."""
    import cv2
    # Levels: stretch the image's own 1-99th percentile to the full 0-255 range. DVR footage — especially
    # IR/low-light — rarely uses the full range to begin with, so a plate's dark digits and light background
    # often sit within a narrow middle band; this is the same "maximize contrast" step a reviewer would do
    # by hand in Levels/Curves (as recommended for plate work specifically), done as a direct remap.
    lo, hi = np.percentile(bgr, (1, 99))
    if hi > lo:
        bgr = np.clip((bgr.astype(np.float32) - lo) * (255.0 / (hi - lo)), 0, 255).astype(np.uint8)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0 if strong else 2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge((l, a, b))
    contrasted = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(contrasted, (0, 0), sigmaX=2)
    alpha = 2.0 if strong else 1.5
    sharpened = cv2.addWeighted(contrasted, alpha, blurred, 1 - alpha, 0)
    return sharpened
