#!/bin/zsh
# One-time setup for the AI frame enhancer (docs/enhance-ai-spec.md). Not run automatically — the feature
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

echo "== CCSR engine (optional 'best quality, slow' alternative to Real-ESRGAN — spec section 2b) =="
$PIP install diffusers transformers accelerate safetensors lpips einops
# CCSR (github.com/csslc/CCSR, CCSR-v2 branch, Apache 2.0) ships as scripts, not a pip package, and its
# custom pipeline/controlnet code is pinned to diffusers==0.21.0/transformers==4.25.0 — versions with no
# wheels for a Python this new. Vendored into app/ccsr/ with the modern-diffusers/MPS/tiling fixes already
# applied (see that directory's own comments for exactly what and why); this script only fetches weights.
mkdir -p data/models/ccsr/sd21base/{unet,vae,text_encoder,tokenizer,scheduler,feature_extractor} data/models/ccsr/ccsrv2/{controlnet,vae}
# huggingface_hub's own downloader (snapshot_download) was observed to silently stall indefinitely on this
# network — plain curl against the same URLs did not. Fetched directly instead, in parallel per component.
# Base model: an ungated mirror of stabilityai/stable-diffusion-2-1-base (the official repo now requires a
# logged-in, license-accepted HF token to download at all — this mirror is the identical public weights,
# filenames included, without that gate).
SD21="https://huggingface.co/Manojb/stable-diffusion-2-1-base/resolve/main"
curl -sL "$SD21/model_index.json" -o data/models/ccsr/sd21base/model_index.json
( for f in unet/config.json "unet/diffusion_pytorch_model.fp16.safetensors"; do curl -sL "$SD21/$f" -o "data/models/ccsr/sd21base/$f"; done ) &
( for f in vae/config.json "vae/diffusion_pytorch_model.fp16.safetensors"; do curl -sL "$SD21/$f" -o "data/models/ccsr/sd21base/$f"; done ) &
( for f in text_encoder/config.json "text_encoder/model.fp16.safetensors"; do curl -sL "$SD21/$f" -o "data/models/ccsr/sd21base/$f"; done ) &
( for f in tokenizer/merges.txt tokenizer/vocab.json tokenizer/tokenizer_config.json tokenizer/special_tokens_map.json; do curl -sL "$SD21/$f" -o "data/models/ccsr/sd21base/$f"; done ) &
( for f in scheduler/scheduler_config.json feature_extractor/preprocessor_config.json; do curl -sL "$SD21/$f" -o "data/models/ccsr/sd21base/$f"; done ) &
wait
# CCSR-v2's own controlnet (stage 1) + VAE (stage 2) checkpoints — the authors only publish these via
# Google Drive/Baidu; this is a community re-upload in diffusers-loadable safetensors format.
CCSR="https://huggingface.co/YaronElh/CCSR-v2/resolve/main"
( for f in controlnet/config.json controlnet/diffusion_pytorch_model.safetensors; do curl -sL "$CCSR/$f" -o "data/models/ccsr/ccsrv2/$f"; done ) &
( for f in vae/config.json vae/diffusion_pytorch_model.safetensors; do curl -sL "$CCSR/$f" -o "data/models/ccsr/ccsrv2/$f"; done ) &
wait

echo "== done — first real Real-ESRGAN/GFPGAN enhance request will still download those weights (~700MB) =="
