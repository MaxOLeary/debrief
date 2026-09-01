#!/usr/bin/env bash
# One-shot setup on a fresh Mac: npm modules, then the two AI models. No
# Homebrew, no accounts. whisper-cli ships in vendor/, llama.cpp and the audio
# tools download or come with macOS.
#
#   ./scripts/setup.sh
#
# Everything large lands in ~/.config/debrief/, never in this folder.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null 2>&1 || { echo "Node.js is required: https://nodejs.org"; exit 1; }

echo "==> Node modules"
npm install --no-audit --no-fund

echo "==> Whisper model (transcription)"
bash scripts/fetch-model.sh "${WHISPER_MODEL_SIZE:-medium}"

echo "==> Local AI engine + model (summaries)"
node scripts/fetch-llm.js

echo
echo "Done. Build and install the app with:"
echo "    ./scripts/build-app.sh --install"
