#!/usr/bin/env bash
# Compiles the tiny AppKit addon that rounds the visualizer window.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/native/shapewindow.m"
OUT="$ROOT/src/native/shapewindow.node"
INC="$(node -p "require('path').join(process.execPath, '..', '..', 'include', 'node')")"
[ -f "$INC/node_api.h" ] || { echo "node_api.h not at $INC"; exit 1; }

mkdir -p "$(dirname "$OUT")"
clang -shared -fobjc-arc -O2 \
  -undefined dynamic_lookup \
  -mmacosx-version-min=11.0 \
  -arch "$(uname -m)" \
  -I"$INC" \
  -o "$OUT" "$SRC" \
  -framework AppKit \
  -framework QuartzCore
echo "built $OUT"
