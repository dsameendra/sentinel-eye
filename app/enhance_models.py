"""The AI frame enhancer's models: what's on offer, where the weights live, and getting them there.

Three kinds, each chosen in Settings → Enhancement:
  - upscalers  — the 4x super-resolution pass every mode runs (Real-ESRGAN, or one of four SwinIR variants);
  - faces      — face restoration in Auto/Face mode (GFPGAN v1.4, v1.3, RestoreFormer);
  - plate      — the licence-plate reader used by Read text (fast-plate-ocr's global models).
Text that isn't a plate is read with Tesseract, a system program rather than a model file.

Weights live in data/models/ (outside the Python environment, so rebuilding .venv or updating never
re-downloads them), are fetched on first use — or ahead of time from Settings — and are checked against a
pinned SHA-256 before use. Older installs kept Real-ESRGAN and GFPGAN v1.4 inside site-packages; those are
copied over instead of downloaded again.

Everything here is optional, like the enhancer itself: nothing imports torch at module level, and every
check reports what's missing rather than failing.
"""
import hashlib
import importlib.util
import os
import shutil
import ssl
import sys
import threading
import urllib.request
from pathlib import Path

from settings import DATA

MODEL_DIR = DATA / "models"
_SWINIR = "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/"
_GFPGAN = "https://github.com/TencentARC/GFPGAN/releases/download/"

# Upscalers. "engine": realesrgan = the realesrgan package (as before); spandrel = loaded with spandrel.
# "style": gan = sharp, synthesises texture; psnr = trained for fidelity, softer, invents less.
UPSCALERS = {
    "realesrgan": {
        "label": "Real-ESRGAN", "engine": "realesrgan", "style": "gan", "speed": 1.0,
        "file": "RealESRGAN_x4plus.pth", "size": 67040989,
        "sha256": "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        "legacy": ["weights/RealESRGAN_x4plus.pth"],   # where the realesrgan package used to put it
        "about": "Fast, sharp all-rounder. Can sharpen noise into texture.",
    },
    "swinir-m-psnr": {
        "label": "SwinIR · faithful", "engine": "spandrel", "style": "psnr", "speed": 3.4,
        "file": "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_PSNR.pth", "size": 67129849,
        "sha256": "1fd8fed99684bd271db55563e4906d36459cf535446820053f7a1081d4781dc5",
        "url": _SWINIR + "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_PSNR.pth",
        "about": "The most faithful to the real pixels — softer, invents the least.",
    },
    "swinir-m-gan": {
        "label": "SwinIR · sharp", "engine": "spandrel", "style": "gan", "speed": 3.1,
        "file": "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_GAN.pth", "size": 67129861,
        "sha256": "b9afb61e65e04eb7f8aba5095d070bbe9af28df76acd0c9405aeb33b814bcfc6",
        "url": _SWINIR + "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_GAN.pth",
        "about": "Crisper detail than faithful, with some synthesised texture.",
    },
    "swinir-l-psnr": {
        "label": "SwinIR Large · faithful", "engine": "spandrel", "style": "psnr", "speed": 6.1,
        "file": "003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_PSNR.pth", "size": 142473947,
        "sha256": "450be6eac63a59959b55a83df6743444de9f018547f81d16f699b3680d366ad7",
        "url": _SWINIR + "003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_PSNR.pth",
        "about": "As faithful as the standard one, a little better on faces. About twice as slow.",
    },
    "swinir-l-gan": {
        "label": "SwinIR Large · sharp", "engine": "spandrel", "style": "gan", "speed": 5.9,
        "file": "003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_GAN.pth", "size": 142473939,
        "sha256": "99adfa91350a84c99e946c1eb3d8fce34bc28f57d807b09dc8fe40a316328c0a",
        "url": _SWINIR + "003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_GAN.pth",
        "about": "The most detail, and the best plate reads in testing — also the most synthesised texture. Slowest.",
    },
}

# Face restoration, all through the gfpgan package already installed with the enhancer.
FACES = {
    "gfpgan-1.4": {
        "label": "GFPGAN v1.4", "arch": "clean", "file": "GFPGANv1.4.pth", "size": 348632874,
        "sha256": "e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad",
        "url": _GFPGAN + "v1.3.0/GFPGANv1.4.pth", "legacy": ["gfpgan/weights/GFPGANv1.4.pth"],
        "about": "Strongest detail on small, blurry faces.",
    },
    "gfpgan-1.3": {
        "label": "GFPGAN v1.3", "arch": "clean", "file": "GFPGANv1.3.pth", "size": 348632874,
        "sha256": "c953a88f2727c85c3d9ae72e2bd4846bbaf59fe6972ad94130e23e7017524a70",
        "url": _GFPGAN + "v1.3.0/GFPGANv1.3.pth",
        "about": "Close to v1.4 in testing, slightly more natural; the faithful pairing uses it.",
    },
    "restoreformer": {
        "label": "RestoreFormer", "arch": "RestoreFormer", "file": "RestoreFormer.pth", "size": 290785322,
        "sha256": "07404d446d62ca3d5ed38b1de09a947a1e77d46dbccec961a74d713a8f24ace0",
        "url": _GFPGAN + "v1.3.0/RestoreFormer.pth",
        "about": "A transformer restorer: freer with facial structure than GFPGAN.",
    },
}

# Licence-plate readers (fast-plate-ocr's ONNX models): a model and its config, fetched here like the others
# (not by the package's own downloader, which can't find certificates on a python.org build).
_PLATE_REL = "https://github.com/ankandrew/cnn-ocr-lp/releases/download/arg-plates/"
_PLATE_CFG = ("plate_config.yaml", 1725, "0335c74a305173bb6f393efed0fde03cadeaa0b649ed8e19f431016d8232d0a6")
PLATES = {
    "cct-s-v2-global-model": {
        "label": "Plate reader · standard", "about": "fast-plate-ocr's global CCT-S model — recommended.",
        "files": [("cct_s_v2_global.onnx", 5262230, "384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b"),
                  ("cct_s_v2_global_" + _PLATE_CFG[0], _PLATE_CFG[1], _PLATE_CFG[2])],
    },
    "cct-xs-v2-global-model": {
        "label": "Plate reader · small",
        "about": "fast-plate-ocr's global CCT-XS model: faster, but it misread a real plate the standard model got right. Use standard unless you need the speed.",
        "files": [("cct_xs_v2_global.onnx", 3344292, "8031afb5fdc6b4d80462c9d542f1284ebd2cfddf5dbacd62609848d7e2855f44"),
                  ("cct_xs_v2_global_" + _PLATE_CFG[0], _PLATE_CFG[1], _PLATE_CFG[2])],
    },
}
for _e in PLATES.values():
    _e["size"] = sum(f[1] for f in _e["files"])

# Matched upscaler + face model pairings, from tools/bench_enhance.py (docs/SPEC.md 7.8.2e): on degraded stock
# scenes the faithful (PSNR) SwinIR models scored ~1.7 dB above Real-ESRGAN and the sharp ones about level;
# on faces the upscaler mattered more than the face model; on side-on plates none read worse than Real-ESRGAN,
# SwinIR Large · sharp the best.
COMBOS = {
    "balanced": {"label": "Balanced", "upscaler": "realesrgan", "face": "gfpgan-1.4",
                 "about": "Fast and sharp — the long-standing default."},
    "faithful": {"label": "Faithful", "upscaler": "swinir-l-psnr", "face": "gfpgan-1.3",
                 "about": "Closest to the real pixels on scenes and faces in testing. For anything you'll rely on."},
    "detail": {"label": "Most detail", "upscaler": "swinir-l-gan", "face": "gfpgan-1.4",
               "about": "The sharpest look and the best plate reads in testing, with the most synthesised texture."},
}

DEFAULT_UPSCALER, DEFAULT_FACE, DEFAULT_PLATE = "realesrgan", "gfpgan-1.4", "cct-s-v2-global-model"


def has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _kind_dir(kind: str) -> Path:
    return MODEL_DIR / {"upscaler": "upscalers", "face": "faces", "plate": "ocr"}[kind]


def _entry(kind: str, mid: str) -> dict:
    return {"upscaler": UPSCALERS, "face": FACES, "plate": PLATES}[kind][mid]


def _files(kind: str, mid: str):
    """[(destination, url, size, sha256)] for a model — one file, or a plate model's two."""
    e = _entry(kind, mid)
    if kind == "plate":
        return [(_kind_dir(kind) / mid / n, _PLATE_REL + n, size, sha) for n, size, sha in e["files"]]
    return [(_kind_dir(kind) / e["file"], e["url"], e["size"], e["sha256"])]


def is_ready(kind: str, mid: str) -> bool:
    return all(d.is_file() and d.stat().st_size == size for d, _, size, _ in _files(kind, mid))


def path_for(kind: str, mid: str) -> Path:
    return _files(kind, mid)[0][0]


def _legacy_copy(kind: str, mid: str) -> bool:
    """Weights an older install downloaded elsewhere — inside site-packages (Real-ESRGAN, GFPGAN), or the
    plate reader's own cache — are copied over instead of downloaded again."""
    e = _entry(kind, mid)
    if kind == "plate":
        old = Path.home() / ".cache" / "fast-plate-ocr" / mid
        files = _files(kind, mid)
        if not all((old / d.name).is_file() and _sha256(old / d.name) == sha for d, _, _, sha in files):
            return False
        for d, _, _, _ in files:
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(old / d.name, d)
        return True
    for rel in e.get("legacy", []):
        for root in sys.path:
            src = Path(root) / rel
            if root and src.is_file() and src.stat().st_size == e["size"]:
                dst = path_for(kind, mid)
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmp = dst.with_suffix(".part")
                shutil.copyfile(src, tmp)
                if _sha256(tmp) == e["sha256"]:
                    os.replace(tmp, dst)
                    return True
                tmp.unlink(missing_ok=True)
    return False


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _ssl_context():
    try:
        import certifi   # a python.org build has no CA bundle configured
        return ssl.create_default_context(cafile=certifi.where())
    except ModuleNotFoundError:
        return ssl.create_default_context()


_dl_lock = threading.Lock()
_downloading: dict[tuple, dict] = {}   # (kind, id) -> {"done": bytes, "total": bytes, "error": str|None}


def ensure(kind: str, mid: str, progress=None) -> Path:
    """The verified model file (a plate model: its folder), downloading — or adopting an older install's
    copy — if needed. Raises on failure; the caller decides how to fall back."""
    e = _entry(kind, mid)
    files = _files(kind, mid)
    result = files[0][0].parent if kind == "plate" else files[0][0]
    if is_ready(kind, mid) or _legacy_copy(kind, mid):
        return result
    key = (kind, mid)
    with _dl_lock:
        if key in _downloading and _downloading[key].get("error") is None:
            raise RuntimeError(f"{e['label']} is already downloading — try again when it's done")
        _downloading[key] = {"done": 0, "total": e["size"], "error": None}
    try:
        mb = max(1, e["size"] // 1_000_000)
        for dst, url, size, sha in files:
            if dst.is_file() and dst.stat().st_size == size:
                _downloading[key]["done"] += size
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_name(dst.name + ".part")
            h = hashlib.sha256()
            with urllib.request.urlopen(url, context=_ssl_context(), timeout=60) as r, open(tmp, "wb") as out:
                while chunk := r.read(1 << 20):
                    out.write(chunk)
                    h.update(chunk)
                    _downloading[key]["done"] += len(chunk)
                    if progress:
                        progress(f"Downloading {e['label']} ({_downloading[key]['done'] // 1_000_000}/{mb} MB, once)…")
            if h.hexdigest() != sha:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"{e['label']} didn't match its checksum — not used")
            os.replace(tmp, dst)
        with _dl_lock:
            _downloading.pop(key, None)
        return result
    except Exception as ex:
        with _dl_lock:
            _downloading[key] = {"done": 0, "total": e["size"], "error": str(ex)[:200]}
        raise


def download_in_background(kind: str, mid: str) -> None:
    """Settings' "Download" button: fetch ahead of first use."""
    def run():
        try:
            ensure(kind, mid)
        except Exception:
            pass   # recorded in _downloading; status() reports it
    threading.Thread(target=run, daemon=True).start()


def _engine_ready(kind: str, mid: str) -> tuple[bool, str]:
    """Whether the code a model needs is installed (not its weights)."""
    if kind == "plate":
        ok = has_module("fast_plate_ocr") and has_module("onnxruntime")
        return ok, "" if ok else "Needs the plate reader — re-run tools/install_enhance_deps.sh"
    base = has_module("torch") and has_module("realesrgan") and has_module("gfpgan")
    if not base:
        return False, "Needs the AI enhancer — run tools/install_enhance_deps.sh"
    if kind == "upscaler" and _entry(kind, mid)["engine"] == "spandrel" and not has_module("spandrel"):
        return False, "Needs spandrel — re-run tools/install_enhance_deps.sh"
    return True, ""


def status() -> dict:
    """Everything Settings shows: each model's state, the pairings, and the text readers."""
    def one(kind, mid, e):
        ok, why = _engine_ready(kind, mid)
        dl = _downloading.get((kind, mid))
        if not ok:
            state = "unavailable"
        elif is_ready(kind, mid):
            state = "ready"
        elif dl and dl.get("error") is None:
            state = "downloading"
        else:
            state = "download"   # fetched on first use, or now from Settings
        return {"id": mid, "label": e["label"], "about": e["about"], "size": e["size"], "state": state,
                "reason": why or (dl or {}).get("error") or "", "style": e.get("style"), "speed": e.get("speed"),
                "progress": round(dl["done"] / dl["total"], 3) if dl and dl.get("error") is None and dl["total"] else None}
    tess = {"id": "tesseract", "label": "Tesseract", "about": "Reads signs and other text; plates use the plate reader when it's installed.",
            "state": "unavailable", "reason": "Needs the tesseract program and pytesseract — see tools/install_enhance_deps.sh", "version": None}
    if has_module("pytesseract"):
        try:
            import pytesseract
            tess.update(state="ready", reason="", version=str(pytesseract.get_tesseract_version()))
        except Exception:
            tess["reason"] = "The tesseract program isn't installed — e.g. brew install tesseract"
    return {
        "upscalers": [one("upscaler", k, v) for k, v in UPSCALERS.items()],
        "faces": [one("face", k, v) for k, v in FACES.items()],
        "plates": [one("plate", k, v) for k, v in PLATES.items()],
        "text": [tess],
        "combos": [{"id": k, **v} for k, v in COMBOS.items()],
        "defaults": {"upscaler": DEFAULT_UPSCALER, "face": DEFAULT_FACE, "plate": DEFAULT_PLATE},
    }
