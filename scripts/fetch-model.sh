#!/usr/bin/env bash
# Downloads a whisper.cpp model into ~/.config/debrief/models so
# transcription can run offline. Deliberately NOT inside this repo: the repo
# lives on the Desktop, which is iCloud-synced.
# Usage: npm run fetch-model            (medium, ~1.5 GB — the default)
#        npm run fetch-model -- small   (~0.5 GB, faster, a bit less accurate)
set -euo pipefail

MODEL="${1:-medium}"
DIR="${WHISPER_MODEL_DIR:-$HOME/.config/debrief/models}"
FILE="$DIR/ggml-${MODEL}.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"

mkdir -p "$DIR"
if [ -f "$FILE" ]; then
  echo "Already have $FILE"
  exit 0
fi

# Silero VAD (~860 KB): stops whisper inventing dialogue during silence.
VAD="$DIR/ggml-silero-v5.1.2.bin"
if [ ! -f "$VAD" ]; then
  echo "Downloading the voice-activity model (860 KB) …"
  curl -L --fail -# -o "$VAD.part" \
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
  mv "$VAD.part" "$VAD"
fi

echo "Downloading ggml-${MODEL}.bin …"
curl -L --fail -# -o "$FILE.part" "$URL"
mv "$FILE.part" "$FILE"
ls -lh "$FILE"
