"""Plate bench: Read text on licence plates the way a side-on DVR camera sees them — condensed lettering,
leaning (shear) and tilted, small, blurred, noisy, JPEG-compressed, over 5 frames with sub-pixel shifts —
through the real enhancer pipeline (frame fusion, Real-ESRGAN, the plate sharpen). Compares Tesseract with
the plate reader, on the original fused frame, the enhanced result, and both (the app's way). Synthetic
plates only. Needs the native enhancer deps plus the plate reader (tools/install_enhance_deps.sh).

    .venv/bin/python tools/bench_plates.py [count] [--upscaler=swinir-l-psnr]   # default 16, Real-ESRGAN
"""
import io, os, random, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import enhance_ai as E

N = next((int(a) for a in sys.argv[1:] if a.isdigit()), 16)
FONT = next((f for f in ("/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf") if os.path.exists(f)), None)
norm = lambda t: re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def lev(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (ca != cb))
    return d[-1]


def scene(text, th, shear, rot):
    W, H = 640, 360
    f = ImageFont.truetype(FONT, th * 4) if FONT else ImageFont.load_default(size=th * 4)
    tw, _ = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), text, font=f)[2:]
    pw, ph = tw + th * 2, int(th * 4 * 1.45)
    pl = Image.new("L", (pw, ph), 232); d = ImageDraw.Draw(pl)
    d.rectangle([3, 3, pw - 4, ph - 4], outline=30, width=max(2, th // 3))
    d.text((pw / 2, ph / 2), text, font=f, fill=22, anchor="mm")
    a = cv2.warpAffine(np.array(pl), np.float32([[1, shear, max(0, -shear * ph)], [0, 1, 0]]), (pw + int(abs(shear) * ph), ph), borderValue=0)
    pl = Image.fromarray(a).rotate(rot, expand=True, resample=Image.BICUBIC, fillcolor=0)
    big = Image.new("L", (W * 4, H * 4), 90)
    cx, cy = W * 2 + random.randint(-200, 200), H * 2 + random.randint(-100, 100)
    big.paste(pl, (cx - pl.width // 2, cy - pl.height // 2), pl.point(lambda v: 255 if v > 8 else 0))
    frames = []
    for _ in range(5):
        dx, dy = np.random.uniform(-2, 2, 2)
        lo = big.transform(big.size, Image.AFFINE, (1, 0, dx, 0, 1, dy), resample=Image.BICUBIC).resize((W, H), Image.BOX).filter(ImageFilter.GaussianBlur(0.6))
        lo = Image.fromarray(np.clip(np.array(lo).astype(np.float32) + np.random.normal(0, 5, (H, W)), 0, 255).astype(np.uint8))
        b = io.BytesIO(); lo.save(b, "JPEG", quality=55)
        frames.append(cv2.cvtColor(np.array(Image.open(b).convert("RGB")), cv2.COLOR_RGB2BGR))
    region = {"cx": cx / 4 / W, "cy": cy / 4 / H, "w": pl.width / 4 * 1.15 / W, "h": pl.height / 4 * 1.2 / H, "angle": -rot + random.uniform(-2, 2)}
    return frames, region


rgb = lambda bgr: cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
tess = lambda img, region: max((norm(l["text"]) for l in E._ocr_region(Image.fromarray(rgb(img)), region, True)[0]), key=len, default="")
plate = lambda imgs, region: norm(E._read_plate([rgb(i) for i in imgs], region)[0])


def plates(n, seed=5):
    """n plate scenes: (text, letter height, frames, region), reproducible."""
    random.seed(seed); np.random.seed(seed)
    out = []
    for _ in range(n):
        L = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        T = "".join(random.choice(L) for _ in range(3)) + "".join(random.choice("0123456789") for _ in range(4))
        th = random.choice([10, 12, 15, 18, 22]); shear = random.choice([-0.3, -0.2, 0.2, 0.3]); rot = random.uniform(-12, 12)
        frames, region = scene(T[:3] + " " + T[3:], th, shear, rot)
        out.append((T, th, frames, region))
    return out


def main():
    upscaler = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--upscaler=")), "realesrgan")
    up = E._load_models_upsampler_only(upscaler=upscaler)
    if E._plate_reader() is None:
        sys.exit("The plate reader isn't installed — see tools/install_enhance_deps.sh")
    print(f"upscaler: {upscaler}")
    score = {k: [0, 0.0] for k in ("Tesseract, original", "Tesseract, enhanced", "plate reader, original", "plate reader, enhanced", "plate reader, both")}
    for T, th, frames, region in plates(N):
        src = E._align_and_median(frames)
        res = E._classical_sharpen(up.enhance(src, outscale=4)[0], strong=True)
        got = {"Tesseract, original": tess(src, region), "Tesseract, enhanced": tess(res, region),
               "plate reader, original": plate([src], region), "plate reader, enhanced": plate([res], region),
               "plate reader, both": plate([res, src], region)}
        for k, g in got.items():
            score[k][0] += g == T; score[k][1] += max(0, 1 - lev(g, T) / len(T))
        print(f"{T}  letters ~{th}px  " + "  ".join(f"{k.split(',')[0][0]}{'o' if 'orig' in k else 'e' if 'enh' in k else 'b'}={g}" for k, g in got.items()), flush=True)
    for k, (ex, ch) in score.items():
        print(f"{k:24s} exact {ex}/{N}  characters {ch / N * 100:.0f}%")
    sys.stdout.flush()
    os._exit(0)   # onnxruntime and torch together can abort while the interpreter tears down; the results are in


if __name__ == "__main__":
    main()
