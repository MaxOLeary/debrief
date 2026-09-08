#!/usr/bin/env bash
# One-shot setup on a fresh Mac: npm modules, then the two AI engines and
# their models. No Homebrew, no accounts. sherpa-onnx (Parakeet) and llama.cpp
# download themselves; the audio tools come with macOS.
#
#   ./scripts/setup.sh
#
# Everything large lands in ~/.config/debrief/, never in this folder.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null 2>&1 || { echo "Node.js is required: https://nodejs.org"; exit 1; }

echo "==> Node modules"
npm install --no-audit --no-fund

echo "==> Speech engine + model (transcription)"
node scripts/fetch-model.js

echo "==> Local AI engine + model (summaries)"
node scripts/fetch-llm.js

echo
echo "Done. Build and install the app with:"
echo "    ./scripts/build-app.sh --install"
