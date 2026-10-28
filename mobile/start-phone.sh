#!/bin/zsh
# Serves the app to Expo Go over Tailscale, so the phone can load it on campus Wi-Fi or cellular,
# not only when it's on the same network as the Mac.
set -euo pipefail
cd "$(dirname "$0")"

TS=""
for candidate in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    [[ -x "$candidate" ]] && { TS=$candidate; break }
done
[[ -n "$TS" ]] || { echo "Tailscale isn't installed. Install it, sign in, and run this again."; exit 1 }

IP=$("$TS" ip -4 2>/dev/null | head -1)
[[ -n "$IP" ]] || { echo "Tailscale is installed but not signed in. Open it, sign in, and run this again."; exit 1 }

echo "Serving Dash to Expo Go at $IP (Tailscale)"
REACT_NATIVE_PACKAGER_HOSTNAME=$IP exec npx expo start --lan
