#!/bin/zsh
# Builds Dash.app. Pass --install to copy it into ~/Applications.
set -euo pipefail
cd "$(dirname "$0")"

# Optional, untracked build.local next to this script can set DASH_BUNDLE_ID (e.g. com.yourname.dash),
# so your installed app keeps its identity (permissions, login item, settings) across rebuilds.
if [[ -f build.local ]]; then source ./build.local; fi
BUNDLE_ID="${DASH_BUNDLE_ID:-com.example.dash}"

swift build -c release

APP=build/Dash.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Dash "$APP/Contents/MacOS/Dash"
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
cp Resources/Dash.icns "$APP/Contents/Resources/Dash.icns"
# Sign with the local "Dash Local Signing" certificate so macOS keeps Screen Recording and Microphone
# permission across rebuilds. Falls back to ad-hoc signing (permission resets each build).
IDENTITY=$(security find-identity -p codesigning | awk '/"Dash Local Signing"/ {print $2; exit}')
codesign --force --sign "${IDENTITY:--}" --identifier "$BUNDLE_ID" "$APP"

if [[ "${1:-}" == "--install" ]]; then
    # Quit the way ⌘Q does, so Dash asks first if a lecture is recording and closes its claude and
    # jarvis children. pkill (SIGTERM) only if it's still running after that, and never mid-lecture.
    if pgrep -x Dash >/dev/null; then
        echo "Quitting Dash…"
        osascript -e 'quit app "Dash"' >/dev/null 2>&1 || true
        for _ in {1..40}; do
            pgrep -x Dash >/dev/null || break
            sleep 0.5
        done
        if pgrep -x Dash >/dev/null; then
            echo "Dash is still running (a lecture recording, or it didn't answer). Stop the lecture or quit Dash, then run this again." >&2
            echo "To force it anyway: pkill -x Dash && $0 --install" >&2
            exit 1
        fi
    fi
    rm -rf ~/Applications/Dash.app
    mkdir -p ~/Applications
    cp -R "$APP" ~/Applications/
    echo "Installed to ~/Applications/Dash.app"
fi
