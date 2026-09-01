#!/bin/bash
# Click the Debrief dot.
#   left click  -> start / stop recording
#   right click -> open the notes folder
# Commands go through a file the app polls (see debrief/lib/bridge.js).

CMD_DIR="$HOME/.config/debrief"
APP="/Applications/Debrief.app"

# Launch with `open -a`, never by exec'ing the binary: macOS credits TCC
# permissions to whatever launched the process, so exec'ing it from a shell
# hands the Screen Recording grant to the terminal instead of the app.
if ! pgrep -qf "Debrief.app/Contents/MacOS"; then
  open -a "$APP"
  sleep 2
fi

mkdir -p "$CMD_DIR"
case "$BUTTON" in
  right) echo "open-folder" > "$CMD_DIR/command" ;;
  *)     echo "toggle"      > "$CMD_DIR/command" ;;
esac

# The app writes state.json within ~400ms; nudge the item so the dot flips
# without waiting for the next poll.
sleep 1
sketchybar --trigger debrief_changed
