#!/bin/zsh
# One-time setup for the AI frame enhancer (docs/playback-spec.md section 7.8). Not run automatically — the feature
# is optional, and this downloads real weight files (~1.5 GB total across PyTorch, Real-ESRGAN, GFPGAN and
# facexlib's own detection/parsing models, the last two fetched lazily on first real use).
#
# basicsr==1.4.2 (a GFPGAN/Real-ESRGAN dependency, effectively unmaintained since ~2022) does not install
# as-is on this project's Python version: its setup.py's get_version() relies on a function-local exec()
# populating locals(), which CPython 3.13+ no longer guarantees (PEP 709-era optimizations), producing
# `KeyError: '__version__'` at build time; separately, basicsr/data/degradations.py imports
# torchvision.transforms.functional_tensor, removed in torchvision >= 0.17. Both are one-line fixes,
# applied here to a local copy of the sdist rather than to the installed package, so they survive a clean
# reinstall. Tracked upstream by the basicsr project as a known incompatibility, not something wrong with
# this install.
set -e
cd "$(dirname "$0")/.."
PIP=.venv/bin/pip
PY=.venv/bin/python3

echo "== torch / torchvision / opencv =="
$PIP install torch torchvision opencv-python-headless pillow numpy --upgrade

echo "== patching and building basicsr locally =="
work=$(mktemp -d)
curl -sL "$($PY -c "import json,urllib.request; print(json.load(urllib.request.urlopen('https://pypi.org/pypi/basicsr/1.4.2/json'))['urls'][0]['url'])")" -o "$work/basicsr.tar.gz"
tar xzf "$work/basicsr.tar.gz" -C "$work"
src="$work/basicsr-1.4.2"
python3 - "$src/setup.py" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """def get_version():
    with open(version_file, 'r') as f:
        exec(compile(f.read(), version_file, 'exec'))
    return locals()['__version__']"""
new = """def get_version():
    ns = {}
    with open(version_file, 'r') as f:
        exec(compile(f.read(), version_file, 'exec'), ns)
    return ns['__version__']"""
assert old in s, "basicsr setup.py's get_version() has changed shape — re-check the patch"
open(p, 'w').write(s.replace(old, new))
PY
sed -i '' 's/from torchvision.transforms.functional_tensor import rgb_to_grayscale/from torchvision.transforms.functional import rgb_to_grayscale/' "$src/basicsr/data/degradations.py"
$PIP install "$src" --no-deps --no-build-isolation
rm -rf "$work"

echo "== the rest (no-deps: torch/torchvision/opencv above already satisfy their pins) =="
$PIP install addict future lmdb pyyaml requests scikit-image scipy tqdm yapf tb-nightly facexlib gfpgan realesrgan filterpy numba --no-deps
$PIP install urllib3 idna charset_normalizer certifi   # requests' own deps (installed --no-deps above)

echo "== OCR (optional, separate from the AI pipeline — spec section 4a) =="
$PIP install pytesseract
if ! command -v tesseract >/dev/null; then
  echo "Installing tesseract via Homebrew (needed by pytesseract)…"
  brew install tesseract
fi

echo "== done — first real enhance request will still download Real-ESRGAN/GFPGAN/facexlib weights (~700MB) =="
