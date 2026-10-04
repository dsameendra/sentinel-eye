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
import os
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


def start_enhance(job_id, images_b64, mode, channel, at_utc, roi=None, weight=0.5, upscaler=None, face=None):
    """images_b64: list of base64-encoded PNG strings, oldest -> newest, 1-11 frames, same dimensions.
    roi: optional (x, y, w, h) fractions (0-1) of the frame to crop to *before* alignment/upscaling — lets
    the operator isolate a plate or face so the AI's fixed output resolution is spent on that subject
    instead of the whole scene (see docs/SPEC.md section 7.8.2c). weight: GFPGAN's own fidelity/
    identity-preservation knob (0=pure hallucinated reconstruction, 1=barely touched) — see section 2d."""
    _sweep_old_jobs()
    with _jobs_lock:
        _jobs[job_id] = {"state": "queued", "progress": "Queued…", "error": None, "done": False}
    t = threading.Thread(target=_run, args=(job_id, images_b64, mode, channel, at_utc, roi, weight, upscaler, face), daemon=True)
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


def _run(job_id, images_b64, mode, channel, at_utc, roi=None, weight=0.5, upscaler=None, face=None):
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
            result, faces_found, used = _enhance(fused, mode, weight, progress=lambda msg: _set(job_id, progress=msg),
                                                 upscaler=upscaler, face=face)
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

        import enhance_models as EM
        models = {"upscaler": EM.UPSCALERS[used["upscaler"]]["label"],
                  "face": EM.FACES[used["face"]]["label"] if used["face"] else None, "note": used["note"] or None}
        _set(job_id, state="done", progress="done", done=True, faces_found=faces_found, models=models,
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


def _slant(bw):
    """How far the letters lean, as a horizontal shear (x shift per row, relative to the middle row).
    Levelling the box fixes the line's tilt, but a plate seen from the side also has every letter leaning,
    like italics, and Tesseract reads upright text. Found the classic way: shear the ink by each candidate
    amount and keep the one whose column profile is sharpest — upright strokes stack into tall, narrow
    columns."""
    import cv2
    import numpy as np
    ink = (bw < 128).astype(np.float32)
    h, w = ink.shape
    best, best_s = -1.0, 0.0
    for sh in np.arange(-0.6, 0.601, 0.04):
        M = np.float32([[1, sh, -sh * h / 2], [0, 1, 0]])
        col = cv2.warpAffine(ink, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0).sum(0)
        score = float((col * col).sum())
        if score > best:
            best, best_s = score, float(sh)
    return best_s


def _unslant(img, sh):
    """Shear `img` by `sh` (see _slant), on a canvas wide enough to keep every letter, white around it."""
    import cv2
    import numpy as np
    h, w = img.shape[:2]
    extra = int(abs(sh) * h / 2) + 2
    M = np.float32([[1, sh, -sh * h / 2 + extra], [0, 1, 0]])
    return cv2.warpAffine(img, M, (w + 2 * extra, h), flags=cv2.INTER_CUBIC, borderValue=255)


def _ocr_line_variants(patch, target_h=110, plate=False):
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
    # Tesseract treat the whole patch as a picture and read nothing. A cleaned copy whites out dark areas
    # that touch the box's edge AND span most of its width or height — a surround, not a letter (a box
    # drawn tight can touch a letter: found when a tight box lost the "C" of "CAB 4821").
    # Found on a thinned copy of the dark mask: a letter that nearly touches the plate's edge (blurred into
    # it at low resolution) hangs on by a thin bridge, which thinning breaks — so the letter isn't taken
    # for part of the surround (found: "CAB 4821" lost its "C" that way).
    dark = (bw < 128).astype(np.uint8)
    k = max(1, round(hh / 70))
    thin = cv2.erode(dark, np.ones((3, 3), np.uint8), iterations=k)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(thin, connectivity=8)
    edge = np.zeros(bw.shape, np.uint8)
    for i in range(1, n):
        x, y, w2, h2 = stats[i][:4]
        touches = x <= k or y <= k or x + w2 >= ww - k or y + h2 >= hh - k
        if touches and (w2 >= 0.5 * ww or h2 >= 0.85 * hh):
            edge[labels == i] = 1
    edge = (cv2.dilate(edge, np.ones((3, 3), np.uint8), iterations=k + 1) > 0) & (dark > 0)
    clean, gclean = bw.copy(), gray.copy()
    clean[edge] = 255
    gclean[cv2.dilate(edge.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = 255   # gray keeps blurred strokes thin
    pad = lambda im: cv2.copyMakeBorder(im, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)
    out = [("bw-clean", pad(clean)), ("gray-clean", pad(gclean)), ("gray", pad(gray)), ("bw", pad(bw)), ("bw-inv", pad(255 - bw))]
    # The plate (or sign) itself: the largest light area in the box, read on its own with white around it —
    # its border and whatever surrounds it gone, even where a letter runs into the border (found: a tight
    # plate whose "C" touched its frame read as "AB 4821").
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats((bw >= 128).astype(np.uint8), connectivity=4)
    if plate and n2 > 1:
        i = 1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))
        x, y, w2, h2, area = st2[i]
        if area > 0.15 * hh * ww and (w2 < ww - 4 or h2 < hh - 4) and h2 > 0.25 * hh:
            # The box is levelled already, so the plate is upright: its light area's bounds are inside its
            # printed border, which the crop leaves out.
            out += [("plate-bw", pad(bw[y:y + h2, x:x + w2])), ("plate-gray", pad(gray[y:y + h2, x:x + w2]))]
    # Leaning letters: the same variants straightened, when they lean noticeably.
    sh = _slant(bw)
    if abs(sh) >= 0.08:
        out += [(f"{name}-upright", _unslant(img, sh)) for name, img in out]
    return out, gray


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
    variants, shown = _ocr_line_variants(patch, 110, plate)
    variants += _ocr_line_variants(patch, 190, plate)[0]
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
            g = groups.setdefault(key, {"votes": 0.0, "n": 0, "best": None, "best_mean": -1.0})
            g["votes"] += mean
            g["n"] += 1
            if mean > g["best_mean"]:
                g["best"], g["best_mean"] = lines, mean
    best = None
    if groups:
        key, g = max(groups.items(), key=lambda kv: (kv[1]["votes"] + min(len(kv[0]), 10) * 1.5))
        # A confident reading that contains the winner and adds to it — agreed on by at least two witnesses,
        # so one stray mark can't add a letter — wins: dropping a letter (one touching the plate's border,
        # say) is far more common than inventing one.
        longer = [(k, v) for k, v in groups.items() if len(k) > len(key) and key in k and v["best_mean"] >= 75 and v["n"] >= 2]
        if plate and longer:
            key, g = max(longer, key=lambda kv: (len(kv[0]), kv[1]["best_mean"]))
        best = g["best"]
    out = []
    for v in (best or {}).values():
        out.append({"text": " ".join(v["words"]), "confidence": round(sum(v["confs"]) / len(v["confs"]), 1)})
    return out, shown


# ------------------------------------------------------------------ plate reader (optional)
# A licence-plate recognizer (fast-plate-ocr's global CCT model, ONNX, ~5 MB, fetched once on first use into
# the user's cache): Tesseract reads printed documents, and fails on plates — condensed plate lettering, seen
# side-on so every letter leans. Measured on 16 side-on synthetic plates through the real enhancer: Tesseract
# 0 exact (29-32% of characters); this reader 12-13 exact (91-96%). Optional like the rest of the enhancer
# (tools/install_enhance_deps.sh); without it, Plate mode reads with Tesseract as before.
_plate_recs = {}           # model id -> recognizer, or False when the reader isn't installed
_plate_lock = threading.Lock()


def _trust_certifi():
    """Model weights download over HTTPS with Python's urllib, and a python.org build ships with no CA
    bundle configured: point it at certifi's (run.sh does the same for the server it starts — this covers
    one started any other way). Leaves an explicit SSL_CERT_FILE alone."""
    try:
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ModuleNotFoundError:
        pass


def _plate_reader(model_id=None):
    """The licence-plate reader (enhance_models.PLATES), its model fetched once into data/models/ocr. None when
    it isn't installed or can't be fetched (offline on first use): Read text uses Tesseract then, and tries
    again next time."""
    import enhance_models as EM
    mid = model_id if model_id in EM.PLATES else EM.DEFAULT_PLATE
    with _plate_lock:
        if mid not in _plate_recs:
            try:
                from fast_plate_ocr import LicensePlateRecognizer
            except ModuleNotFoundError:
                _plate_recs[mid] = False
                return None
            try:
                folder = EM.ensure("plate", mid)
                onnx, cfg = (folder / n for n, _, _ in EM.PLATES[mid]["files"])
                _plate_recs[mid] = LicensePlateRecognizer(onnx_model_path=onnx, plate_config_path=cfg, device="cpu")
            except Exception as e:
                print(f"[enhance] plate reader unavailable ({type(e).__name__}: {e}) — reading with Tesseract", flush=True)
                return None
        return _plate_recs[mid] or None


def _read_plate(images_rgb, region, model_id=None):
    """The plate reader on the operator's box, levelled, from each image given (the enhanced result and the
    original frame), as drawn and with its letters upright; the most confident reading wins — they miss on
    different plates. Returns (text, confidence 0-100) or None if the reader isn't installed."""
    import cv2
    import re
    rec = _plate_reader(model_id)
    if rec is None:
        return None
    best = None
    for rgb in images_rgb:
        patch = _region_patch(rgb, region)
        if patch.size == 0:
            continue
        g = cv2.cvtColor(patch, cv2.COLOR_RGB2GRAY)
        sh = _slant(cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1])
        tries = [patch] + ([_unslant(patch, sh)] if abs(sh) >= 0.08 else [])
        for img in tries:
            p = rec.run(np.ascontiguousarray(img), return_confidence=True)[0]
            text = re.sub(r"[^A-Z0-9]", "", (p.plate or "").upper())
            if not text:
                continue
            conf = float(np.mean(p.char_probs[: len(p.plate)])) if p.char_probs is not None else 0.0
            if best is None or conf > best[1]:
                best = (text, conf)
    if best is None:
        return ("", 0.0)
    # Letters and digits as groups, the way a plate reads: CBG4264 -> CBG 4264.
    spaced = re.sub(r"(?<=[A-Z])(?=[0-9])|(?<=[0-9])(?=[A-Z])", " ", best[0])
    return spaced, round(best[1] * 100, 1)


def ocr(job_id, which, region=None, plate=False, plate_model=None):
    """Reads text off whichever image ('result' or 'source') is already on disk for this job, with Tesseract
    — the whole picture, or just the operator's box (`region`, see _region_patch), which is far more
    reliable: the box says where the text is and which way it runs. In Plate mode, with the plate reader
    installed, that reads the box instead (_read_plate). Returns (lines, crop, engine): `crop` is a PNG data
    URL of the levelled patch that was read (region reads only), so the operator can see exactly what the
    reading came from; `engine` is "plate" or "tesseract".
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
        return _ocr_whole(base), None, "tesseract"
    engine = "tesseract"
    read = None
    if plate:
        images = [np.array(base)]
        other = source_path(job_id) if which == "result" else None
        if other:
            src = PILImage.open(other).convert("RGB")
            # Same box on the original frame: the result is that frame upscaled, so the same fractions.
            if abs(src.width / src.height - base.width / base.height) < 0.01:
                images.append(np.array(src))
        read = _read_plate(images, region, plate_model)
    if read is not None:
        import cv2
        engine = "plate"
        lines = [{"text": read[0], "confidence": read[1]}] if read[0] else []
        shown = cv2.cvtColor(_region_patch(np.array(base), region), cv2.COLOR_RGB2GRAY)
    else:
        lines, shown = _ocr_region(base, region, plate)
    crop = None
    if shown is not None:
        im = PILImage.fromarray(shown)
        if im.width > 640:
            im = im.resize((640, max(1, round(im.height * 640 / im.width))))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        crop = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    return lines, crop, engine


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
class _SpandrelUpsampler:
    """A spandrel-loaded super-resolution model (SwinIR) behind RealESRGANer's interface —
    .enhance(bgr, outscale) -> (bgr, None) — so it can stand in anywhere Real-ESRGAN did, GFPGAN's background
    upsampler included. Runs in overlapping tiles: bounded GPU memory on any frame size, and SwinIR's window
    attention is quadratic in tile size, so tiles are faster too (256 px tiles measured fastest on MPS)."""
    TILE, PAD = 256, 16

    def __init__(self, path, device):
        import torch
        from spandrel import ModelLoader
        self.torch = torch
        self.model = ModelLoader().load_from_file(str(path)).to(device).eval()
        self.scale = self.model.scale
        self.device = device

    def _run(self, x):
        with self.torch.no_grad():
            return self.model(x)

    def enhance(self, bgr, outscale=4):
        import cv2
        torch, s = self.torch, self.scale
        h, w = bgr.shape[:2]
        x = torch.from_numpy(np.ascontiguousarray(bgr[:, :, ::-1])).permute(2, 0, 1).float().div(255).unsqueeze(0).to(self.device)
        out = torch.zeros((1, 3, h * s, w * s), device=self.device)
        T, P = self.TILE, self.PAD
        for y0 in range(0, h, T):
            for x0 in range(0, w, T):
                y1, x1 = min(y0 + T, h), min(x0 + T, w)
                py0, px0, py1, px1 = max(0, y0 - P), max(0, x0 - P), min(h, y1 + P), min(w, x1 + P)
                tile = x[:, :, py0:py1, px0:px1]
                # Below spandrel's minimum (16 px), pad by reflection and crop back.
                th, tw = tile.shape[2:]
                if th < 16 or tw < 16:
                    tile = torch.nn.functional.pad(tile, (0, max(0, 16 - tw), 0, max(0, 16 - th)), mode="replicate")
                y = self._run(tile)[:, :, : th * s, : tw * s]
                out[:, :, y0 * s:y1 * s, x0 * s:x1 * s] = y[:, :, (y0 - py0) * s:(y0 - py0 + y1 - y0) * s, (x0 - px0) * s:(x0 - px0 + x1 - x0) * s]
        res = (out.clamp(0, 1).mul(255).round().byte().squeeze(0).permute(1, 2, 0).cpu().numpy())[:, :, ::-1]
        res = np.ascontiguousarray(res)
        if outscale != s:
            res = cv2.resize(res, (int(w * outscale), int(h * outscale)), interpolation=cv2.INTER_LANCZOS4)
        return res, None


# The upscaler and face model currently loaded — one of each at a time (switching frees the old one; this
# Mac's GPU shares 18 GB with everything else).
_up = None        # (id, upsampler)
_face = None      # (id, GFPGANer)
_fallback_note = ""


def _pick_device():
    import torch
    return "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


def _free_gpu():
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _load_upsampler(uid, progress=None):
    """Loads upscaler `uid` (downloading its weights once if needed), replacing whichever was loaded."""
    global _up, _device
    import enhance_models as EM
    with _models_lock:
        if _up and _up[0] == uid:
            return _up[1]
        _trust_certifi()
        _device = _device or _pick_device()
        e = EM.UPSCALERS[uid]
        ok, why = EM._engine_ready("upscaler", uid)
        if not ok:
            raise RuntimeError(why)
        if progress:
            progress(f"Loading {e['label']}…")
        path = EM.ensure("upscaler", uid, progress)
        _up = None
        _free_gpu()
        if e["engine"] == "spandrel":
            up = _SpandrelUpsampler(path, _device)
        else:
            from basicsr.archs.rrdbnet_arch import RRDBNet
            from realesrgan import RealESRGANer
            rrdb = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
            up = RealESRGANer(scale=4, model_path=str(path), model=rrdb, tile=400, tile_pad=10, pre_pad=0,
                              half=False, device=_device)
        _up = (uid, up)
        if _face:
            _face[1].bg_upsampler = up   # the face model pastes faces onto this one's upscale
        return up


def _get_upsampler(uid, progress=None):
    """The chosen upscaler. If it can't be used — spandrel missing, download failed — falls back to
    Real-ESRGAN and records why (shown with the result), never failing the job over a model choice."""
    global _fallback_note
    import enhance_models as EM
    if uid not in EM.UPSCALERS:
        uid = EM.DEFAULT_UPSCALER
    try:
        return _load_upsampler(uid, progress), uid
    except Exception as ex:
        if uid == EM.DEFAULT_UPSCALER:
            raise
        _fallback_note = f"{EM.UPSCALERS[uid]['label']} unavailable ({str(ex)[:120]}) — used Real-ESRGAN"
        print(f"[enhance] {_fallback_note}", flush=True)
        return _load_upsampler(EM.DEFAULT_UPSCALER, progress), EM.DEFAULT_UPSCALER


def _get_face(fid, upsampler, progress=None):
    global _face, _device
    import enhance_models as EM
    with _models_lock:
        if fid not in EM.FACES:
            fid = EM.DEFAULT_FACE
        if _face and _face[0] == fid:
            _face[1].bg_upsampler = upsampler
            return _face[1], fid
        _device = _device or _pick_device()
        e = EM.FACES[fid]
        if progress:
            progress(f"Loading {e['label']}…")
        path = EM.ensure("face", fid, progress)
        from gfpgan import GFPGANer
        _face = None
        _free_gpu()
        g = GFPGANer(model_path=str(path), upscale=4, arch=e["arch"], channel_multiplier=2,
                     bg_upsampler=upsampler, device=_device)
        _face = (fid, g)
        return g, fid


def _enhance(bgr, mode, weight=0.5, progress=None, upscaler=None, face=None):
    """Returns (enhanced_bgr, faces_found, used) — `used` names the models that actually ran
    ({"upscaler": id, "face": id or None, "note": fallback note}). mode: auto/face/plate/general. weight:
    fidelity knob for a restored face — 0 is the face model's full reconstruction (can fabricate features),
    1 is the real upscaled pixels with no face synthesis at all, 0.5 blends the two evenly (see docs/SPEC.md
    section 7.8.2d for why that middle ground is the forensically-sound default). This is a real, verified
    linear blend against a second plain upscale — NOT GFPGANer.enhance()'s own `weight` argument, which was
    found (by reading the installed package's model code directly, not assumed) to be silently unused: both
    GFPGANv1Clean.forward and GFPGANv1.forward accept it only via **kwargs and never reference it, so it
    had zero effect on the output regardless of value. progress(msg): optional callback fired at each real
    pipeline stage — named after the actual step running, not a generic "processing" label."""
    global _fallback_note
    import enhance_models as EM
    step = progress or (lambda _msg: None)
    _fallback_note = ""
    up, uid = _get_upsampler(upscaler or EM.DEFAULT_UPSCALER, progress)
    ulabel = EM.UPSCALERS[uid]["label"]
    used = lambda f=None: {"upscaler": uid, "face": f, "note": _fallback_note}
    if mode in ("general", "plate"):
        step(f"Upscaling 4x ({ulabel})…")
        out, _ = up.enhance(bgr, outscale=4)
        if mode == "plate":
            step("Sharpening plate/text detail…")
            out = _classical_sharpen(out, strong=True)
        return out, 0, used()

    g, fid = _get_face(face or EM.DEFAULT_FACE, up, progress)
    step(f"Upscaling ({ulabel}) and restoring faces ({EM.FACES[fid]['label']})…")
    _, _, out = g.enhance(bgr, has_aligned=False, only_center_face=False, paste_back=True)
    faces_found = len(g.face_helper.all_landmarks_5) if hasattr(g, "face_helper") else 0
    if mode == "auto" and faces_found == 0:
        step("No face found — sharpening detail…")
        return _classical_sharpen(out), 0, used()
    if faces_found > 0 and weight > 0.0:
        step("Blending restoration against real pixels (fidelity)…")
        real_only, _ = up.enhance(bgr, outscale=4)
        if real_only.shape == out.shape:
            out = np.clip((1 - weight) * out.astype(np.float32) + weight * real_only.astype(np.float32), 0, 255).astype(np.uint8)
    return out, faces_found, used(fid)


def _load_models_upsampler_only(progress=None, upscaler=None):
    """The upscaler alone, for the benches and tools: the chosen one (default Real-ESRGAN), loaded."""
    up, _ = _get_upsampler(upscaler or "realesrgan", progress)
    return up


def _classical_sharpen(bgr, strong=False):
    """Non-AI legibility pass for plates/text and the no-face-found fallback (spec section 2/6): a levels-
    style contrast stretch, CLAHE local contrast, and a halo-free sharpen. Makes real detail more legible;
    invents nothing — every step is a deterministic per-pixel remap, not a learned model.

    Runs on the 4x-upscaled picture, which shaped two choices (found on a real plate, whose letters came out
    hollow — dark outlines round a light middle — with a light halo outside, and which OCR then misread):
    CLAHE's tiles are sized to the picture, not a fixed 8x8 grid (a tile small next to a thick stroke
    brightens the stroke's middle — that was the hollowing); and the sharpen is clamped to the range of each
    pixel's own neighbourhood before sharpening, so edges get crisper without overshooting into a halo.
    `strong` (plate mode) sharpens a little more — legibility is the only goal there."""
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
    h, w = l.shape
    tiles = (max(1, min(8, w // 256)), max(1, min(8, h // 256)))   # tiles of at least ~256 px
    l = cv2.createCLAHE(clipLimit=2.0 if strong else 1.6, tileGridSize=tiles).apply(l)
    contrasted = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(contrasted, (0, 0), sigmaX=2)
    alpha = 1.8 if strong else 1.5
    sharpened = cv2.addWeighted(contrasted, alpha, blurred, 1 - alpha, 0)
    # No overshoot: never darker or lighter than the darkest/lightest pixel nearby was before sharpening.
    k = np.ones((5, 5), np.uint8)
    return np.clip(sharpened, cv2.erode(contrasted, k), cv2.dilate(contrasted, k))
