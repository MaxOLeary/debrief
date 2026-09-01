#!/bin/bash
# icon.svg -> Debrief.icns (all Dock/Finder sizes). Run from icon/.
# Uses the shared WebKit SVG renderer from the postit project.
set -e
cd "$(dirname "$0")"
swift ../../../postit/Swift/icon/render.swift icon.svg icon-1024.png
rm -rf Debrief.iconset && mkdir Debrief.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out Debrief.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s*2))
  sips -z $d $d icon-1024.png --out Debrief.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns Debrief.iconset -o Debrief.icns
rm -rf Debrief.iconset
echo "wrote Debrief.icns"
