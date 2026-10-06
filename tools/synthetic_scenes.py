"""Synthetic camera scenes for Sentinel Eye UI captures.

Guaranteed 100% synthetic: pure SVG vector illustrations of residential cameras.
Zero real surveillance footage, zero camera connections, zero facial imagery, zero real plates.
"""

SCENE_DRIVEWAY_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="100%" height="100%">
  <defs>
    <linearGradient id="sky1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="60%" stop-color="#334155"/>
      <stop offset="100%" stop-color="#475569"/>
    </linearGradient>
    <linearGradient id="road" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f242d"/>
      <stop offset="100%" stop-color="#111418"/>
    </linearGradient>
    <linearGradient id="carRed" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#991b1b"/>
      <stop offset="50%" stop-color="#dc2626"/>
      <stop offset="100%" stop-color="#b91c1c"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#sky1)"/>
  <path d="M0 340 L120 300 L240 330 L380 290 L500 320 L640 280 L780 320 L920 290 L1080 330 L1280 300 L1280 400 L0 400 Z" fill="#0f172a"/>
  <polygon points="0,380 1280,380 1280,720 0,720" fill="#14532d"/>
  <polygon points="260,380 980,380 1180,720 120,720" fill="url(#road)"/>
  <polygon points="230,380 260,380 120,720 80,720" fill="#334155"/>
  <polygon points="980,380 1010,380 1220,720 1180,720" fill="#334155"/>
  <polygon points="0,240 280,260 280,560 0,620" fill="#1e293b"/>
  <polygon points="0,220 300,240 280,260 0,240" fill="#0f172a"/>
  <g transform="translate(520, 390)">
    <ellipse cx="140" cy="225" rx="160" ry="25" fill="#05070a" opacity="0.7"/>
    <rect x="15" y="180" width="40" height="50" rx="6" fill="#0f172a"/>
    <rect x="225" y="180" width="40" height="50" rx="6" fill="#0f172a"/>
    <path d="M20 150 Q15 210 35 215 L245 215 Q265 210 260 150 Q260 110 240 100 L40 100 Q20 110 20 150 Z" fill="url(#carRed)"/>
    <rect x="40" y="185" width="200" height="24" rx="4" fill="#18181b"/>
    <rect x="60" y="193" width="20" height="8" rx="2" fill="#71717a"/>
    <rect x="200" y="193" width="20" height="8" rx="2" fill="#71717a"/>
    <path d="M45 100 L75 30 L205 30 L235 100 Z" fill="#7f1d1d"/>
    <path d="M55 95 L80 38 L200 38 L225 95 Z" fill="#0f172a" stroke="#374151" stroke-width="2"/>
    <rect x="25" y="125" width="45" height="18" rx="4" fill="#ef4444"/>
    <rect x="210" y="125" width="45" height="18" rx="4" fill="#ef4444"/>
    <rect x="95" y="130" width="90" height="34" rx="3" fill="#18181b"/>
    <rect x="100" y="133" width="80" height="28" rx="2" fill="#ffffff"/>
    <rect x="100" y="133" width="12" height="28" rx="1" fill="#1d4ed8"/>
    <text x="145" y="153" fill="#0f172a" font-family="monospace, sans-serif" font-weight="bold" font-size="14" text-anchor="middle" letter-spacing="1">CAB 4821</text>
  </g>
  <rect x="24" y="24" width="380" height="32" rx="4" fill="#000000" opacity="0.6"/>
  <text x="36" y="46" fill="#f8fafc" font-family="monospace, sans-serif" font-size="16" font-weight="600">2026-10-07 07:43:31  CAM 01 DRIVEWAY</text>
</svg>"""

SCENE_FRONTDOOR_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="100%" height="100%">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3f3f46"/>
      <stop offset="100%" stop-color="#27272a"/>
    </linearGradient>
    <linearGradient id="door" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3b2d1d"/>
      <stop offset="100%" stop-color="#1c140c"/>
    </linearGradient>
    <linearGradient id="steps" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52525b"/>
      <stop offset="100%" stop-color="#3f3f46"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#wall)"/>
  <polygon points="0,0 1280,0 1140,140 140,140" fill="#18181b"/>
  <rect x="140" y="135" width="1000" height="12" fill="#09090b"/>
  <rect x="160" y="140" width="60" height="420" fill="#27272a"/>
  <rect x="1060" y="140" width="60" height="420" fill="#27272a"/>
  <rect x="490" y="170" width="300" height="430" fill="#09090b" rx="4"/>
  <rect x="506" y="186" width="268" height="414" fill="url(#door)"/>
  <rect x="526" y="210" width="105" height="150" rx="3" fill="#291e13" stroke="#1c140c" stroke-width="3"/>
  <rect x="649" y="210" width="105" height="150" rx="3" fill="#291e13" stroke="#1c140c" stroke-width="3"/>
  <rect x="526" y="390" width="105" height="180" rx="3" fill="#291e13" stroke="#1c140c" stroke-width="3"/>
  <rect x="649" y="390" width="105" height="180" rx="3" fill="#291e13" stroke="#1c140c" stroke-width="3"/>
  <circle cx="535" cy="420" r="8" fill="#d97706"/>
  <rect x="530" y="420" width="10" height="35" rx="3" fill="#b45309"/>
  <rect x="830" y="260" width="30" height="60" rx="4" fill="#18181b"/>
  <polygon points="825,275 865,275 860,310 830,310" fill="#fef08a" opacity="0.85"/>
  <polygon points="360,510 420,510 410,590 370,590" fill="#9a3412"/>
  <circle cx="390" cy="460" r="45" fill="#15803d"/>
  <circle cx="390" cy="390" r="35" fill="#166534"/>
  <polygon points="860,510 920,510 910,590 870,590" fill="#9a3412"/>
  <circle cx="890" cy="460" r="45" fill="#15803d"/>
  <circle cx="890" cy="390" r="35" fill="#166534"/>
  <polygon points="120,560 1160,560 1200,610 80,610" fill="url(#steps)"/>
  <polygon points="80,610 1200,610 1250,670 30,670" fill="#3f3f46"/>
  <polygon points="30,670 1250,670 1280,720 0,720" fill="#27272a"/>
  <polygon points="460,575 820,575 840,625 440,625" fill="#78350f" stroke="#92400e" stroke-width="2"/>
  <text x="640" y="605" fill="#fde68a" font-family="sans-serif" font-size="14" font-weight="bold" text-anchor="middle">WELCOME</text>
  <rect x="24" y="24" width="400" height="32" rx="4" fill="#000000" opacity="0.6"/>
  <text x="36" y="46" fill="#f8fafc" font-family="monospace, sans-serif" font-size="16" font-weight="600">2026-10-07 07:43:31  CAM 02 FRONT DOOR</text>
</svg>"""

SCENE_BACKYARD_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="100%" height="100%">
  <defs>
    <linearGradient id="sky3" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="60%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#bae6fd"/>
    </linearGradient>
    <linearGradient id="lawn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#15803d"/>
      <stop offset="100%" stop-color="#166534"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#sky3)"/>
  <circle cx="1120" cy="120" r="80" fill="#fef08a" opacity="0.6"/>
  <rect x="0" y="280" width="1280" height="140" fill="#78350f"/>
  <path d="M0 280 M40 280 V420 M80 280 V420 M120 280 V420 M160 280 V420 M200 280 V420 M240 280 V420 M280 280 V420 M320 280 V420 M360 280 V420 M400 280 V420 M440 280 V420 M480 280 V420 M520 280 V420 M560 280 V420 M600 280 V420 M640 280 V420 M680 280 V420 M720 280 V420 M760 280 V420 M800 280 V420 M840 280 V420 M880 280 V420 M920 280 V420 M960 280 V420 M1000 280 V420 M1040 280 V420 M1080 280 V420 M1120 280 V420 M1160 280 V420 M1200 280 V420 M1240 280 V420" stroke="#451a03" stroke-width="4"/>
  <path d="M0 380 Q80 320 160 380 Q240 310 340 370 Q460 300 580 370 Q700 320 820 380 Q940 300 1060 370 Q1180 310 1280 370 L1280 430 L0 430 Z" fill="#14532d"/>
  <rect x="0" y="400" width="1280" height="320" fill="url(#lawn)"/>
  <polygon points="640,480 1280,480 1280,720 540,720" fill="#64748b"/>
  <polygon points="630,485 1280,485 1280,490 628,490" fill="#475569"/>
  <g transform="translate(860, 430)">
    <ellipse cx="100" cy="210" rx="90" ry="30" fill="#0f172a" opacity="0.4"/>
    <rect x="96" y="50" width="8" height="150" fill="#334155"/>
    <ellipse cx="100" cy="180" rx="75" ry="25" fill="#e2e8f0" stroke="#94a3b8" stroke-width="3"/>
    <ellipse cx="25" cy="190" rx="20" ry="15" fill="#334155"/>
    <ellipse cx="175" cy="190" rx="20" ry="15" fill="#334155"/>
    <path d="M10 90 Q100 10 190 90 Z" fill="#0284c7"/>
    <path d="M40 90 Q100 10 160 90 Z" fill="#38bdf8"/>
    <polygon points="10,90 40,90 100,10" fill="#0369a1"/>
    <polygon points="160,90 190,90 100,10" fill="#0369a1"/>
    <circle cx="100" cy="10" r="5" fill="#0f172a"/>
  </g>
  <rect x="24" y="24" width="380" height="32" rx="4" fill="#000000" opacity="0.6"/>
  <text x="36" y="46" fill="#f8fafc" font-family="monospace, sans-serif" font-size="16" font-weight="600">2026-10-07 07:43:31  CAM 03 BACKYARD</text>
</svg>"""

SCENE_SIDEGATE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="100%" height="100%">
  <defs>
    <linearGradient id="sky4" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#334155"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <linearGradient id="brick" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#475569"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <linearGradient id="walk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#94a3b8"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#sky4)"/>
  <polygon points="0,120 420,240 420,720 0,720" fill="url(#brick)"/>
  <polygon points="0,100 440,225 420,245 0,125" fill="#1e293b"/>
  <path d="M80 180 Q140 240 100 320 Q180 360 120 480 Q220 500 160 620 L0 620 L0 180 Z" fill="#15803d" opacity="0.85"/>
  <polygon points="860,240 1280,120 1280,720 860,720" fill="#334155"/>
  <polygon points="840,225 1280,100 1280,125 860,245" fill="#1e293b"/>
  <polygon points="420,240 860,240 1100,720 180,720" fill="url(#walk)"/>
  <circle cx="640" cy="180" r="60" fill="#14532d"/>
  <g transform="translate(420, 230)">
    <rect x="0" y="0" width="16" height="340" fill="#0f172a"/>
    <rect x="424" y="0" width="16" height="340" fill="#0f172a"/>
    <polygon points="8,-20 16,0 0,0" fill="#0f172a"/>
    <polygon points="432,-20 440,0 424,0" fill="#0f172a"/>
    <rect x="20" y="20" width="400" height="300" fill="none" stroke="#0f172a" stroke-width="8"/>
    <rect x="20" y="160" width="400" height="8" fill="#0f172a"/>
    <path d="M45 10 V320 M75 10 V320 M105 10 V320 M135 10 V320 M165 10 V320 M195 10 V320 M225 10 V320 M255 10 V320 M285 10 V320 M315 10 V320 M345 10 V320 M375 10 V320 M405 10 V320" stroke="#0f172a" stroke-width="5"/>
    <circle cx="210" cy="160" r="12" fill="#d97706"/>
  </g>
  <rect x="24" y="24" width="380" height="32" rx="4" fill="#000000" opacity="0.6"/>
  <text x="36" y="46" fill="#f8fafc" font-family="monospace, sans-serif" font-size="16" font-weight="600">2026-10-07 07:43:31  CAM 04 SIDE GATE</text>
</svg>"""

def _make_chan0_svg():
    import re
    def inner(svg_str):
        m = re.search(r'<svg[^>]*>(.*)</svg>', svg_str, re.DOTALL)
        return m.group(1) if m else svg_str

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="100%" height="100%">
  <rect width="1280" height="720" fill="#09090b"/>
  <svg x="0" y="0" width="639" height="359" viewBox="0 0 1280 720">
    {inner(SCENE_DRIVEWAY_SVG)}
  </svg>
  <svg x="641" y="0" width="639" height="359" viewBox="0 0 1280 720">
    {inner(SCENE_FRONTDOOR_SVG)}
  </svg>
  <svg x="0" y="361" width="639" height="359" viewBox="0 0 1280 720">
    {inner(SCENE_BACKYARD_SVG)}
  </svg>
  <svg x="641" y="361" width="639" height="359" viewBox="0 0 1280 720">
    {inner(SCENE_SIDEGATE_SVG)}
  </svg>
  <line x1="640" y1="0" x2="640" y2="720" stroke="#000000" stroke-width="2"/>
  <line x1="0" y1="360" x2="1280" y2="360" stroke="#000000" stroke-width="2"/>
</svg>"""

SCENE_CHAN0_SVG = _make_chan0_svg()

SCENES = {
    "test1": SCENE_DRIVEWAY_SVG,
    "test2": SCENE_FRONTDOOR_SVG,
    "test3": SCENE_BACKYARD_SVG,
    "test4": SCENE_SIDEGATE_SVG,
    "chan0": SCENE_CHAN0_SVG,
}


def make_synthetic_plate_crop_png():
    from PIL import Image, ImageDraw, ImageFont
    import io
    im = Image.new('RGB', (420, 110), '#9ca3af')
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([4, 4, 416, 106], radius=8, fill='#18181b')
    d.rounded_rectangle([8, 8, 412, 102], radius=6, fill='#ffffff')
    d.rounded_rectangle([8, 8, 48, 102], radius=4, fill='#1d4ed8')
    d.ellipse([24, 20, 32, 28], fill='#facc15')
    font = None
    for p in ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']:
        try:
            font = ImageFont.truetype(p, 54, index=1 if 'Helvetica' in p else 0)
            break
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()
    d.text((62, 22), 'CAB 4821', fill='#0f172a', font=font)
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()


def make_synthetic_plate_png(crisp=True):
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    import io
    im = Image.new('RGB', (1280, 720), '#27272a')
    d = ImageDraw.Draw(im)
    # Background wall / garage
    d.rectangle([0, 0, 1280, 720], fill='#27272a')
    # Car body
    d.polygon([(240, 480), (320, 180), (960, 180), (1040, 480)], fill='#7f1d1d')
    d.polygon([(340, 460), (400, 210), (880, 210), (940, 460)], fill='#0f172a')
    d.rectangle([140, 420, 1140, 680], fill='#b91c1c')
    # Taillights
    d.rounded_rectangle([180, 460, 340, 530], radius=8, fill='#ef4444')
    d.rounded_rectangle([940, 460, 1100, 530], radius=8, fill='#ef4444')
    # Lower bumper details
    d.rounded_rectangle([260, 620, 360, 650], radius=6, fill='#71717a')
    d.rounded_rectangle([920, 620, 1020, 650], radius=6, fill='#71717a')
    # Plate recess
    d.rounded_rectangle([420, 470, 860, 580], radius=8, fill='#18181b')
    # Plate
    d.rounded_rectangle([435, 480, 845, 570], radius=6, fill='#ffffff')
    d.rounded_rectangle([435, 480, 485, 570], radius=4, fill='#1d4ed8')
    d.ellipse([455, 500, 465, 510], fill='#facc15')
    font = None
    for p in ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']:
        try:
            font = ImageFont.truetype(p, 60, index=1 if 'Helvetica' in p else 0)
            break
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()
    d.text((505, 492), 'CAB 4821', fill='#0f172a', font=font)
    if not crisp:
        im = im.filter(ImageFilter.GaussianBlur(radius=5.5))
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()
