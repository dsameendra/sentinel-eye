"""Enhancer model bench: which upscaler and face model to use, measured — the numbers behind the pairings
in app/enhance_models.py COMBOS (docs/SPEC.md 7.8.2e). Synthetic/stock inputs only, no real footage:

  1. Text — side-on licence plates (tools/bench_plates.py's scenes) through each upscaler + the plate
     sharpen; the plate reader and Tesseract read the result. A model that changes characters scores lower:
     the direct check for invented text, the failure that got CCSR removed (7.8.2a).
  2. Scenes — stock photos (scikit-image's bundled samples) degraded like a DVR frame (4x smaller, blur,
     noise, JPEG), then upscaled: PSNR/SSIM against the original = how faithful the upscale is.
  3. Faces — the bundled astronaut portrait with the face ~36 px wide, degraded the same way, through
     Face mode (fidelity 0.5, the default) for every upscaler x face model: PSNR/SSIM of the face area.
  Plus time per run on this machine.

    .venv/bin/python tools/bench_enhance.py [--plates=16] [--skip-faces]
"""
import io
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import cv2
import numpy as np
from PIL import Image, ImageFilter

import bench_plates as BP
import enhance_ai as E
import enhance_models as EM

SAMPLES = os.path.join(os.path.dirname(cv2.__file__), "..", "skimage", "data")
arg = lambda name, default: next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith(f"--{name}=")), default)
N_PLATES = int(arg("plates", "16"))
UPS = [u for u in EM.UPSCALERS if EM._engine_ready("upscaler", u)[0]]
rng = np.random.default_rng(7)


def degrade(rgb, factor=4):
    """Like a DVR frame: smaller, a little soft, sensor noise, JPEG."""
    h, w = rgb.shape[:2]
    im = Image.fromarray(rgb).resize((w // factor, h // factor), Image.BOX).filter(ImageFilter.GaussianBlur(0.5))
    a = np.clip(np.asarray(im).astype(np.float32) + rng.normal(0, 4, (h // factor, w // factor, 3)), 0, 255).astype(np.uint8)
    b = io.BytesIO(); Image.fromarray(a).save(b, "JPEG", quality=55)
    return np.asarray(Image.open(b).convert("RGB"))


def psnr(a, b):
    m = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if m == 0 else 10 * np.log10(255 ** 2 / m)


def ssim(a, b):
    a, b = (cv2.cvtColor(x, cv2.COLOR_RGB2GRAY).astype(np.float64) for x in (a, b))
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    g = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)
    ma, mb = g(a), g(b)
    va, vb, cov = g(a * a) - ma ** 2, g(b * b) - mb ** 2, g(a * b) - ma * mb
    return float(np.mean(((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma ** 2 + mb ** 2 + C1) * (va + vb + C2))))


def sample(name):
    return np.asarray(Image.open(os.path.join(SAMPLES, name)).convert("RGB"))


def bench_text():
    print(f"\n== 1. Text: {N_PLATES} side-on plates, plate mode (plate reader / Tesseract on the result)")
    scenes = BP.plates(N_PLATES)
    srcs = [(T, E._align_and_median(frames), region) for T, _, frames, region in scenes]
    out = {}
    for u in UPS:
        up = E._load_models_upsampler_only(upscaler=u)
        ex = ch = tch = 0.0
        t0 = time.time()
        for T, src, region in srcs:
            res = E._classical_sharpen(up.enhance(src, outscale=4)[0], strong=True)
            g = BP.plate([res], region); tg = BP.tess(res, region)
            ex += g == T; ch += max(0, 1 - BP.lev(g, T) / len(T)); tch += max(0, 1 - BP.lev(tg, T) / len(T))
        out[u] = (ex, ch / len(srcs), tch / len(srcs), (time.time() - t0) / len(srcs))
        print(f"   {EM.UPSCALERS[u]['label']:26s} plate reader exact {int(ex):2d}/{len(srcs)}  chars {out[u][1]*100:4.0f}%  "
              f"| Tesseract chars {out[u][2]*100:4.0f}%  | {out[u][3]:.1f}s/frame", flush=True)
    return out


def bench_scenes():
    print("\n== 2. Scenes: degraded 4x, upscaled — PSNR / SSIM vs the original (higher = more faithful)")
    names = ["coffee.png", "astronaut.png", "motorcycle_right.png", "rocket.jpg", "chelsea.png"]
    gts = [sample(n) for n in names]
    gts = [g[: g.shape[0] // 4 * 4, : g.shape[1] // 4 * 4] for g in gts]
    lows = [degrade(g) for g in gts]
    out = {}
    for u in UPS:
        up = E._load_models_upsampler_only(upscaler=u)
        p = s = 0.0; t0 = time.time()
        for g, lo in zip(gts, lows):
            hi = up.enhance(lo[:, :, ::-1].copy(), outscale=4)[0][:, :, ::-1]
            p += psnr(hi, g); s += ssim(hi, g)
        out[u] = (p / len(gts), s / len(gts), (time.time() - t0) / len(gts))
        print(f"   {EM.UPSCALERS[u]['label']:26s} PSNR {out[u][0]:5.2f} dB  SSIM {out[u][1]:.3f}  | {out[u][2]:.1f}s/image", flush=True)
    bicubic = [cv2.resize(lo, (g.shape[1], g.shape[0]), interpolation=cv2.INTER_CUBIC) for g, lo in zip(gts, lows)]
    print(f"   {'(plain bicubic, reference)':26s} PSNR {np.mean([psnr(b, g) for b, g in zip(bicubic, gts)]):5.2f} dB  "
          f"SSIM {np.mean([ssim(b, g) for b, g in zip(bicubic, gts)]):.3f}")
    return out


def bench_faces():
    print("\n== 3. Faces: astronaut portrait, face ~36 px wide, Face mode at fidelity 0.5 — face-area PSNR / SSIM")
    gt = sample("astronaut.png")                         # 512x512; the face is roughly x 150-290, y 40-200
    small = 2.0                                          # shrink 2x first so the 4x-degraded face is ~36 px wide
    gt = cv2.resize(gt, (int(512 / small) // 4 * 4 * 2, int(512 / small) // 4 * 4 * 2), interpolation=cv2.INTER_AREA)
    lo = degrade(gt)
    fx = lambda v: int(v * gt.shape[1] / 512)
    box = (fx(150), fx(40), fx(290), fx(200))
    gface = gt[box[1]:box[3], box[0]:box[2]]
    out = {}
    for u in UPS:
        for f in EM.FACES:
            if not EM.path_for("face", f).is_file():
                continue
            t0 = time.time()
            res, faces, used = E._enhance(lo[:, :, ::-1].copy(), "face", 0.5, upscaler=u, face=f)
            res = cv2.resize(res[:, :, ::-1], (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)
            rface = res[box[1]:box[3], box[0]:box[2]]
            out[(u, f)] = (psnr(rface, gface), ssim(rface, gface), faces, time.time() - t0)
            print(f"   {EM.UPSCALERS[u]['label']:26s} + {EM.FACES[f]['label']:14s} face PSNR {out[(u, f)][0]:5.2f}  SSIM {out[(u, f)][1]:.3f}  "
                  f"faces found {faces}  | {out[(u, f)][3]:.1f}s", flush=True)
    return out


if __name__ == "__main__":
    print("upscalers:", ", ".join(UPS))
    bench_text()
    bench_scenes()
    if "--skip-faces" not in sys.argv:
        bench_faces()
    sys.stdout.flush()
    os._exit(0)   # onnxruntime + torch can abort at interpreter teardown
