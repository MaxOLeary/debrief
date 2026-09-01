#!/bin/bash
# Debrief — the native Tray icon lives in the auto-hidden macOS menu bar,
# so this mirrors it into the bar Max actually sees.
#
# Reads ~/.config/debrief/state.json, written by the app on every state
# change. No jq dependency: the file is one flat object, grep pulls the fields.

CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/sketchybar}"
source "$CONFIG_DIR/colors.sh"

# Max's pixel speech bubble, U+E900 in DebriefIcons.ttf (built from
# sketchybar/icon/grid.txt). It is a font glyph, not an image, so icon.color
# still recolours it per state - an image in SketchyBar cannot be tinted.
BUBBLE=""

STATE="${MN_STATE:-$HOME/.config/debrief/state.json}"

field() { # field <key>  -> the string value, or empty
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$STATE" 2>/dev/null
}

if ! pgrep -qf "Debrief.app/Contents/MacOS"; then
  PHASE="off"
else
  PHASE="$(field phase)"
  [ -z "$PHASE" ] && PHASE="idle"
fi

LABEL="$(field label)"

case "$PHASE" in
  recording)
    # Red bubble, with the running clock.
    ICON="$BUBBLE"
    COLOR=$RED
    [ -z "$LABEL" ] && LABEL="00:00"
    DRAW=on
    ;;
  processing)
    ICON="$BUBBLE"
    COLOR=$AMBER
    [ -z "$LABEL" ] && LABEL="…"
    DRAW=on
    ;;
  off)
    # App isn't running. Same bubble, dimmed, no text.
    ICON="$BUBBLE"
    COLOR=$DIM
    LABEL=""
    DRAW=on
    ;;
  *)
    ICON="$BUBBLE"
    COLOR=$WHITE
    LABEL=""
    DRAW=on
    ;;
esac

sketchybar --set "$NAME" icon="$ICON" \
                         icon.color="$COLOR" \
                         icon.drawing="$DRAW" \
                         label="$LABEL" \
                         label.color="$COLOR" \
                         label.drawing=$([ -n "$LABEL" ] && echo on || echo off)
