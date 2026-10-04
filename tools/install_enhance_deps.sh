#!/usr/bin/env bash
# One-time setup for the AI frame enhancer (docs/SPEC.md section 7.8). Not run automatically — the feature
# is optional, and this downloads real weight files (~1.5 GB total across PyTorch, Real-ESRGAN, GFPGAN and
# facexlib's own detection/parsing models, the last two fetched lazily on first real use). Safe to re-run:
# after an update, just run it again.
#
# basicsr==1.4.2 (a GFPGAN/Real-ESRGAN dependency, effectively unmaintained since ~2022) does not install
# or import as-is on this project's Python version:
#  - its setup.py's get_version() relies on a function-local exec() populating locals(), which CPython
#    3.13+ no longer guarantees (PEP 709-era optimizations), producing `KeyError: '__version__'` at build
#    time;
#  - basicsr/data/degradations.py imports torchvision.transforms.functional_tensor, removed in
#    torchvision >= 0.17;
#  - basicsr/archs/arch_util.py does `from distutils.version import LooseVersion` — distutils was removed
#    from the stdlib entirely in Python 3.12 (PEP 632). setuptools ships a compatibility shim
#    (distutils-precedence.pth), but it only activates if that .pth file isn't skipped, which macOS does
#    for any file carrying the Finder "hidden" flag — so this can still break per-machine even when the
#    shim is present. Patching the import out is more robust than depending on the shim.
# All three are one-line fixes, applied here to a local copy of the sdist rather than to the installed
# package, so they survive a clean reinstall. Tracked upstream by the basicsr project as a known
# incompatibility, not something wrong with this install.
#
# Bash, not zsh, and no BSD-only `sed -i ''`: run.sh supports native Linux too.
set -euo pipefail
cd "$(dirname "$0")/.."
PIP=.venv/bin/pip
PY=.venv/bin/python3
[[ -x "$PY" ]] || { echo "error: no .venv yet — run ./run.sh --native setup first" >&2; exit 1; }

echo "== torch / torchvision / opencv =="
$PIP install torch torchvision opencv-python-headless pillow numpy --upgrade

echo "== patching and building basicsr locally =="
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# curl both looks the sdist up and fetches it, with the system's certificates — a python.org build's urllib
# has none configured (this lookup used to go through urllib, fail with CERTIFICATE_VERIFY_FAILED, and hand
# curl an empty URL). Each step is its own command, so a failure stops here. (Not `pip download`: it builds
# the sdist's metadata, which is the very setup.py bug patched below.)
curl -fsSL https://pypi.org/pypi/basicsr/1.4.2/json -o "$work/basicsr.json"
url=$("$PY" -c "import json, sys; print(next(u['url'] for u in json.load(open(sys.argv[1]))['urls'] if u['packagetype'] == 'sdist'))" "$work/basicsr.json")
curl -fsSL "$url" -o "$work/basicsr.tar.gz"
tar xzf "$work/basicsr.tar.gz" -C "$work"
src="$work/basicsr-1.4.2"
"$PY" - "$src" <<'PY'
import sys
src = sys.argv[1]
def patch(path, old, new, why):
    p = f"{src}/{path}"
    s = open(p).read()
    if new in s:
        return
    assert old in s, f"basicsr {path} has changed shape — re-check the patch ({why})"
    open(p, "w").write(s.replace(old, new))
patch("setup.py", """def get_version():
    with open(version_file, 'r') as f:
        exec(compile(f.read(), version_file, 'exec'))
    return locals()['__version__']""", """def get_version():
    ns = {}
    with open(version_file, 'r') as f:
        exec(compile(f.read(), version_file, 'exec'), ns)
    return ns['__version__']""", "get_version")
patch("basicsr/data/degradations.py", "from torchvision.transforms.functional_tensor import rgb_to_grayscale",
      "from torchvision.transforms.functional import rgb_to_grayscale", "torchvision >= 0.17")
patch("basicsr/archs/arch_util.py", "from distutils.version import LooseVersion",
      "from packaging.version import parse as LooseVersion", "no distutils")
PY
$PIP install "$src" --no-deps --no-build-isolation

echo "== the rest (no-deps: torch/torchvision/opencv above already satisfy their pins) =="
$PIP install addict future lmdb packaging pyyaml requests scikit-image scipy tqdm yapf tb-nightly facexlib gfpgan realesrgan filterpy numba --no-deps
$PIP install urllib3 idna charset_normalizer certifi   # requests' own deps (installed --no-deps above)

echo "== OCR (optional, separate from the AI pipeline — spec section 4a) =="
$PIP install pytesseract
if ! command -v tesseract >/dev/null; then
  if command -v brew >/dev/null; then
    echo "Installing tesseract via Homebrew (needed by pytesseract)…"
    brew install tesseract
  else
    echo "warning: the tesseract program isn't installed (e.g. sudo apt install tesseract-ocr) — Read text needs it" >&2
  fi
fi

echo "== plate reader (optional — Read text on licence plates; its ~5MB model is fetched on first use) =="
$PIP install "onnxruntime==1.30.0" "fast-plate-ocr==1.1.0"

echo "== checking the install =="
"$PY" -c "import basicsr, realesrgan, gfpgan, pytesseract, fast_plate_ocr; print('enhancer imports OK')"

echo "== done — first real enhance request will still download Real-ESRGAN/GFPGAN/facexlib weights (~700MB), and the first plate read the plate reader's model (~5MB) =="
