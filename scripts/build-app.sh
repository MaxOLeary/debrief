#!/usr/bin/env bash
# Builds a real, signed "Debrief.app".
#
# Why bother instead of just `npm start`: macOS ties Screen Recording and
# Microphone permission to a code signature. Run from source and the grant
# lands on "Electron" at a node_modules path, and the next `npm install`
# throws it away. A signed bundle with its own identifier keeps the grant.
#
# Staging happens outside the repo on purpose — this tree lives on the
# Desktop, which is iCloud-synced.
#
# Usage: ./scripts/build-app.sh [--install]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="Debrief"
BUNDLE_ID="com.maxoleary.debrief"
VERSION="1.0.0"
SIGN_ID="${SIGN_ID:-}"
STAGE="$(mktemp -d /tmp/debrief-build.XXXXXX)"
APP="$STAGE/$NAME.app"
trap 'rm -rf "$STAGE"' EXIT

ELECTRON_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
[ -d "$ELECTRON_APP" ] || { echo "Electron not installed. Run: npm install"; exit 1; }

echo "==> Building window-shape addon"
bash "$APP_DIR/scripts/build-shapewindow.sh"

echo "==> Copying Electron runtime"
ditto "$ELECTRON_APP" "$APP"

echo "==> Renaming executable"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$NAME"
rm -f "$APP/Contents/Resources/default_app.asar"

echo "==> Writing Info.plist"
PLIST="$APP/Contents/Info.plist"
pb () { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null 2>&1 || true; }
pb "Set :CFBundleExecutable $NAME"
pb "Set :CFBundleName $NAME"
pb "Set :CFBundleDisplayName $NAME"
pb "Set :CFBundleIdentifier $BUNDLE_ID"
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $VERSION"
pb "Delete :NSHumanReadableCopyright"
# LSUIElement keeps it out of the Dock and the app switcher: menu bar only.
pb "Delete :LSUIElement"; pb "Add :LSUIElement bool true"
pb "Delete :NSMicrophoneUsageDescription"
pb "Add :NSMicrophoneUsageDescription string 'Debrief records your voice so it can transcribe the meeting on this Mac.'"
pb "Delete :NSAudioCaptureUsageDescription"
pb "Add :NSAudioCaptureUsageDescription string 'Debrief captures the audio your Mac plays so the other people in the call end up in the transcript.'"
pb "Delete :NSCameraUsageDescription"
pb "Delete :NSBluetoothAlwaysUsageDescription"
pb "Delete :NSBluetoothPeripheralUsageDescription"

echo "==> Installing app icon"
# Replace Electron's atom icon with the Debrief bubble (assets/icon/make-icns.sh).
cp "$APP_DIR/assets/icon/Debrief.icns" "$APP/Contents/Resources/Debrief.icns"
rm -f "$APP/Contents/Resources/electron.icns"
pb "Set :CFBundleIconFile Debrief"

echo "==> Copying application code"
RES="$APP/Contents/Resources/app"
mkdir -p "$RES"
cp -R "$APP_DIR/src" "$APP_DIR/package.json" "$APP_DIR/.env.example" \
      "$APP_DIR/assets" "$RES/"
# Runtime dependencies only — Electron itself is the bundle.
mkdir -p "$RES/node_modules"
for dep in "$APP_DIR"/node_modules/*; do
  base="$(basename "$dep")"
  case "$base" in electron|.bin|.package-lock.json) continue ;; esac
  cp -R "$dep" "$RES/node_modules/"
done

echo "==> Stripping extended attributes"
# cp -R drags Finder metadata along, and codesign refuses to sign a bundle
# that carries it ("resource fork ... not allowed").
xattr -cr "$APP"

echo "==> Signing"
if [ -z "$SIGN_ID" ]; then
  # Prefer a dedicated cert, fall back to the Postit one, then ad-hoc.
  IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  # A dedicated cert if one ever exists, otherwise the Postit Dev cert that
  # already holds this machine's TCC grants, otherwise ad-hoc.
  for candidate in "Debrief Dev" "Postit Dev"; do
    if printf '%s' "$IDENTITIES" | grep -q "\"$candidate\""; then SIGN_ID="$candidate"; break; fi
  done
  [ -z "$SIGN_ID" ] && SIGN_ID="-"
fi
echo "    identity: $SIGN_ID"

# Inside out: frameworks and helpers first, the outer bundle last.
find "$APP/Contents/Frameworks" -name "*.framework" -maxdepth 1 -print0 2>/dev/null |
  while IFS= read -r -d '' fw; do
    codesign --force --sign "$SIGN_ID" --timestamp=none "$fw" 2>/dev/null || true
  done
find "$APP/Contents/Frameworks" -name "*.app" -maxdepth 1 -print0 2>/dev/null |
  while IFS= read -r -d '' helper; do
    codesign --force --sign "$SIGN_ID" --timestamp=none "$helper" 2>/dev/null || true
  done
find "$APP/Contents/Frameworks" \( -name "*.dylib" -o -name "*.node" \) -print0 2>/dev/null |
  while IFS= read -r -d '' lib; do
    codesign --force --sign "$SIGN_ID" --timestamp=none "$lib" 2>/dev/null || true
  done
find "$RES" -name "*.node" -print0 2>/dev/null |
  while IFS= read -r -d '' lib; do
    codesign --force --sign "$SIGN_ID" --timestamp=none "$lib" 2>/dev/null || true
  done
codesign --force --sign "$SIGN_ID" --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

if [ "${1:-}" = "--install" ]; then
  DEST="/Applications/$NAME.app"
  echo "==> Installing to $DEST"
  if [ -e "$DEST" ]; then
    pkill -f "$DEST/Contents/MacOS/$NAME" 2>/dev/null || true
    sleep 1
    rm -rf "$DEST"
  fi
  cp -R "$APP" "$DEST"
  echo "    installed"
  echo "$DEST"
else
  OUT="$HOME/.local/build/$NAME.app"
  mkdir -p "$(dirname "$OUT")"
  rm -rf "$OUT"
  cp -R "$APP" "$OUT"
  echo "==> Built (not installed): $OUT"
  echo "    run ./scripts/build-app.sh --install to put it in /Applications"
  echo "$OUT"
fi
