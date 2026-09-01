#!/usr/bin/env bash
# Makes Debrief start at login and stop at logout, per the house rule
# that every menu bar app gets a LaunchAgent instead of an in-app toggle.
#
# Run ./scripts/build-app.sh --install first — this points at the real bundle,
# not at `npm start`, so macOS keeps the Screen Recording grant.
set -euo pipefail

APP="/Applications/Debrief.app"
LABEL="com.maxoleary.debrief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -d "$APP" ]; then
  echo "Not installed: $APP"
  echo "Run ./scripts/build-app.sh --install first."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>$APP</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>ProcessType</key>      <string>Interactive</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST"
sleep 2
pgrep -f "MacOS/Debrief" >/dev/null && echo "Running." || echo "Not running yet — check ~/Library/Logs/Debrief.log"
