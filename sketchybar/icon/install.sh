#!/bin/bash
# Rebuild the icon from grid.txt and install it where SketchyBar can see it.
#   ./install.sh          rebuild font + images, install the font
#   ./install.sh --reload also restart sketchybar so it picks the font up
set -euo pipefail
cd "$(dirname "$0")"

[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip -q install fonttools

./.venv/bin/python build-font.py
node export-images.js

mkdir -p "$HOME/Library/Fonts"
cp DebriefIcons.ttf "$HOME/Library/Fonts/DebriefIcons.ttf"
echo "installed ~/Library/Fonts/DebriefIcons.ttf"

# sketchybar caches available fonts at launch, so --reload is not enough.
if [ "${1:-}" = "--reload" ]; then
  brew services restart sketchybar
  echo "sketchybar restarted"
else
  echo "run 'brew services restart sketchybar' to pick up a font change"
fi
