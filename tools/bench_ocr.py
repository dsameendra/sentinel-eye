"""OCR bench: how well "Read text" reads synthetic plates and signs — 72 scenes at 0/15/30°, 16/24/40 px
text, sharp or blurred, dark-on-light and light-on-dark, JPEG-compressed, with clutter around. Compares the
operator's box (a slightly loose, slightly off-angle box, as a person draws it) against reading the whole
picture. Needs the native enhancer deps (Pillow, OpenCV, pytesseract + tesseract).

    .venv/bin/python tools/bench_ocr.py            # box only (about a minute)
    .venv/bin/python tools/bench_ocr.py --whole    # also the whole-picture read, for comparison
"""
import sys, random, io, math, time, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import enhance_ai as E
from PIL import Image, ImageDraw, ImageFont, ImageFilter
random.seed(7)
FONT = next((f for f in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf") if os.path.exists(f)), None)
def lev(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (ca != cb))
    return d[-1]
def plate():
    L = "ABCDEFGHJKLMNPRSTUVWXYZ"
    a, n = "".join(random.choice(L) for _ in range(3)), "".join(random.choice("0123456789") for _ in range(4))
    return random.choice([a + "-" + n, "WP " + a + " " + n, a[:2] + " " + n])
def scene(text, th, angle, blur, inv):
    W, H = 1280, 720
    im = Image.new("RGB", (W, H), (58, 66, 74))
    d = ImageDraw.Draw(im)
    for _ in range(25):   # clutter
        x, y = random.randrange(W), random.randrange(H); d.rectangle([x, y, x + random.randrange(20, 160), y + random.randrange(10, 90)], fill=tuple(random.randrange(40, 140) for _ in range(3)))
    f = ImageFont.truetype(FONT, th) if FONT else ImageFont.load_default(size=th)
    tw, tht = d.textbbox((0, 0), text, font=f)[2:]
    pw, ph = int(tw + th * 0.8), int(th * 1.6)
    bg, fg = ((235, 235, 230), (20, 20, 20)) if not inv else ((25, 25, 30), (235, 235, 220))
    pl = Image.new("RGBA", (pw, ph), bg + (255,))
    ImageDraw.Draw(pl).text(((pw - tw) / 2, (ph - th) / 2 - th * 0.1), text, font=f, fill=fg)
    rot = pl.rotate(angle, expand=True, resample=Image.BICUBIC)   # PIL: positive = counter-clockwise
    cx, cy = random.randrange(300, W - 300), random.randrange(200, H - 200)
    im.paste(rot, (cx - rot.width // 2, cy - rot.height // 2), rot)
    if blur: im = im.filter(ImageFilter.GaussianBlur(blur))
    b = io.BytesIO(); im.save(b, "JPEG", quality=70); im = Image.open(b).convert("RGB")
    # the operator's box: a bit loose, angle a little off; on screen a CCW plate is a negative (clockwise) angle
    region = {"cx": cx / W, "cy": cy / H, "w": pw * 1.15 / W, "h": ph * 1.25 / H, "angle": -angle + random.uniform(-2, 2)}
    return im, region
rows = []
FAST = "--whole" not in sys.argv
cases = [(t, th, a, bl, inv) for t in ("plate", "sign") for th in (16, 24, 40) for a in (0, 15, 30) for bl in (0, 1.2) for inv in (False, True)]
t0 = time.time()
for kind, th, a, bl, inv in cases:
    truth = plate() if kind == "plate" else random.choice(["NO PARKING", "EXIT 24", "STOP", "GATE 3", "DELIVERY"])
    im, region = scene(truth, th, a, bl, inv)
    norm = lambda s: "".join(ch for ch in s.upper() if ch.isalnum())
    T = norm(truth)
    whole = [] if FAST else E._ocr_whole(im)
    reg, shown = E._ocr_region(im, region, plate=(kind == "plate"))
    def score(lines):
        best = min((lev(norm(l["text"]), T) for l in lines), default=len(T))
        return best == 0, max(0.0, 1 - best / len(T))
    rows.append((kind, th, a, bl, inv, score(whole), score(reg)))
    if not score(reg)[0]: print("MISS", len(rows), kind, th, a, bl, inv, repr(truth), "->", [l["text"] for l in reg])
n = len(rows)
for label, idx in ((("whole picture", 5),) if not FAST else ()) + (("operator's box", 6),):
    ex = sum(r[idx][0] for r in rows) / n; ca = sum(r[idx][1] for r in rows) / n
    print(f"{label:24s} exact {ex*100:5.1f}%   chars {ca*100:5.1f}%")
if FAST:
    print(f"{n} cases, {time.time()-t0:.0f}s"); sys.exit(0)
for a in (0, 15, 30):
    sub = [r for r in rows if r[2] == a]
    print(f"  angle {a:2d}°: whole exact {sum(r[5][0] for r in sub)/len(sub)*100:5.1f}%  box exact {sum(r[6][0] for r in sub)/len(sub)*100:5.1f}%")
for th in (16, 24, 40):
    sub = [r for r in rows if r[1] == th]
    print(f"  text {th}px: whole exact {sum(r[5][0] for r in sub)/len(sub)*100:5.1f}%  box exact {sum(r[6][0] for r in sub)/len(sub)*100:5.1f}%")
for inv in (False, True):
    sub = [r for r in rows if r[4] == inv]
    print(f"  {'light-on-dark' if inv else 'dark-on-light'}: whole {sum(r[5][0] for r in sub)/len(sub)*100:5.1f}%  box {sum(r[6][0] for r in sub)/len(sub)*100:5.1f}%")
print(f"{n} cases, {time.time()-t0:.0f}s")
