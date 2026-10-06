"""The enhancer's model layer, without real weights or a GPU: the catalog, settings fallbacks, verified
downloads, adopting an older install's weights, status for Settings, and SwinIR's tiled upscaling.

    .venv/bin/python3 tools/test_enhance_models.py
"""
import hashlib
import os
import sys
import tempfile
from pathlib import Path

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-models-")
sys.path.insert(0, "app")
import enhance_models as EM
import settings as st

PASS = []


def check(name, ok, extra=""):
    PASS.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


# ---- catalog
for kind, table in (("upscaler", EM.UPSCALERS), ("face", EM.FACES)):
    bad = [k for k, e in table.items() if not all(e.get(f) for f in ("label", "file", "size", "sha256", "url", "about"))
           or len(e["sha256"]) != 64 or not e["url"].startswith("https://")]
    check(f"{kind} catalog entries complete", not bad, bad)
check("pairings name real models",
      all(c["upscaler"] in EM.UPSCALERS and c["face"] in EM.FACES for c in EM.COMBOS.values()))
check("defaults are in the catalog", EM.DEFAULT_UPSCALER in EM.UPSCALERS and EM.DEFAULT_FACE in EM.FACES and EM.DEFAULT_PLATE in EM.PLATES)

# ---- settings: defaults, and a model id that no longer exists falls back instead of breaking loading
d = st.Display()
check("settings default to Real-ESRGAN + GFPGAN v1.4", (d.enhance_upscaler, d.enhance_face_model) == ("realesrgan", "gfpgan-1.4"))
d = st.Display(enhance_upscaler="swinir-l-psnr", enhance_face_model="gfpgan-1.3")
check("a chosen pairing is kept", (d.enhance_upscaler, d.enhance_face_model) == ("swinir-l-psnr", "gfpgan-1.3"))
d = st.Display(enhance_upscaler="removed-model", enhance_face_model="nope", enhance_plate_model="x")
check("unknown model ids fall back to the defaults",
      (d.enhance_upscaler, d.enhance_face_model, d.enhance_plate_model) == (EM.DEFAULT_UPSCALER, EM.DEFAULT_FACE, EM.DEFAULT_PLATE))
check("older settings without the fields still load", st.Display.model_validate({"layout": "2x2"}).enhance_upscaler == "realesrgan")

# ---- verified download (file:// stands in for the release URL) and legacy adoption, on a scratch entry
blob = os.urandom(4096)
src = Path(tempfile.mkdtemp()) / "w.pth"
src.write_bytes(blob)
EM.UPSCALERS["_test"] = {"label": "Test", "engine": "spandrel", "file": "w.pth", "size": len(blob),
                         "sha256": hashlib.sha256(blob).hexdigest(), "url": src.as_uri(), "about": "t"}
try:
    p = EM.ensure("upscaler", "_test")
    check("download lands in data/models/upscalers, verified", p.read_bytes() == blob and p.parent.name == "upscalers")
    p.unlink()
    # An existing damaged file with the expected length must not pass the cache readiness check.
    damaged = bytes([blob[0] ^ 0xFF]) + blob[1:]
    p.write_bytes(damaged)
    p = EM.ensure("upscaler", "_test")
    check("same-size corrupted cache is replaced with verified weights", p.read_bytes() == blob)
    p.unlink()
    EM.UPSCALERS["_test"]["sha256"] = "0" * 64
    try:
        EM.ensure("upscaler", "_test")
        check("a checksum mismatch is refused", False)
    except RuntimeError as e:
        check("a checksum mismatch is refused, nothing left behind", "checksum" in str(e) and not p.exists() and not p.with_suffix(".part").exists(), e)
    st_ = EM.status()
    t = next(x for x in st_["upscalers"] if x["id"] == "_test")
    check("a failed download is reported, and can be retried", t["state"] in ("download", "unavailable") and (t["reason"] or t["state"] == "unavailable"), t)
    # an older install kept weights inside site-packages: adopted, not downloaded again
    EM.UPSCALERS["_test"].update(sha256=hashlib.sha256(blob).hexdigest(), url="https://invalid.example/never", legacy=["weights/w.pth"])
    legacy_root = Path(tempfile.mkdtemp())
    (legacy_root / "weights").mkdir()
    (legacy_root / "weights" / "w.pth").write_bytes(blob)
    sys.path.append(str(legacy_root))
    EM._downloading.clear()
    p = EM.ensure("upscaler", "_test")
    check("an older install's weights are adopted, not downloaded", p.read_bytes() == blob)
finally:
    EM.UPSCALERS.pop("_test", None)

# ---- status: every kind reported, without torch being imported by the status check itself
s = EM.status()
check("status lists upscalers, faces, plate readers, Tesseract and pairings",
      len(s["upscalers"]) == len(EM.UPSCALERS) and len(s["faces"]) == len(EM.FACES) and s["plates"] and s["text"] and s["combos"])
check("every model has a known state", all(x["state"] in ("ready", "download", "downloading", "unavailable") for x in s["upscalers"] + s["faces"] + s["plates"]))

# ---- SwinIR's tiled upscale: stitched tiles must equal one whole-image pass (a stand-in x4 model)
try:
    import numpy as np
    import torch
    import enhance_ai as E

    class CachedFace:
        bg_upsampler = object()
    E._up = ("old", object())
    E._face = ("face", CachedFace())
    E._release_upsampler()
    check("upscaler replacement releases the face restorer's old GPU reference",
          E._up is None and E._face[1].bg_upsampler is None)
    E._face = None

    class FakeX4:   # nearest-neighbour x4, so any seam or offset in the stitching shows as a mismatch
        scale = 4
        def __call__(self, x):
            return torch.nn.functional.interpolate(x, scale_factor=4, mode="nearest")

    up = E._SpandrelUpsampler.__new__(E._SpandrelUpsampler)
    up.torch, up.model, up.scale, up.device = torch, FakeX4(), 4, "cpu"
    rng = np.random.default_rng(1)
    for h, w in ((37, 53), (256, 256), (300, 517), (9, 12)):
        img = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
        out, _ = up.enhance(img, outscale=4)
        want = np.repeat(np.repeat(img, 4, axis=0), 4, axis=1)
        check(f"tiled x4 matches a whole-image pass at {w}x{h}", out.shape == want.shape and np.array_equal(out, want), out.shape)
    out, _ = up.enhance(rng.integers(0, 256, (40, 60, 3), dtype=np.uint8), outscale=2)
    check("a different output scale is resized to it", out.shape == (80, 120, 3), out.shape)
except ModuleNotFoundError as e:
    print(f"SKIP tiling checks (the AI enhancer isn't installed: {e.name})")

# ---- a chosen model that can't be used falls back to Real-ESRGAN, with a note, instead of failing the job
try:
    import enhance_ai as E
    real = EM._engine_ready
    EM._engine_ready = lambda kind, mid: (False, "spandrel missing (test)") if mid.startswith("swinir") else real(kind, mid)
    try:
        ok_base = real("upscaler", "realesrgan")[0] and EM.path_for("upscaler", "realesrgan").exists()
        if ok_base:
            up, used = E._get_upsampler("swinir-l-psnr")
            check("an unusable SwinIR falls back to Real-ESRGAN, with a note", used == "realesrgan" and "used Real-ESRGAN" in E._fallback_note, E._fallback_note)
        else:
            print("SKIP fallback check (Real-ESRGAN weights not in this scratch data dir)")
    finally:
        EM._engine_ready = real
except ModuleNotFoundError as e:
    print(f"SKIP fallback check ({e.name} not installed)")

print(f"\n{sum(PASS)}/{len(PASS)} passed")
sys.exit(0 if all(PASS) else 1)
