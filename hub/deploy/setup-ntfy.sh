#!/bin/bash
# Runs on the hub (deploy.sh calls it): ntfy for Dash's phone notifications. Safe to run again.
#
# ntfy listens on 127.0.0.1 and `tailscale serve` publishes it on :8443 to your devices only. Anyone
# on the tailnet (just your own devices) may subscribe; only the hub can publish, with a token. For
# instant delivery on iOS, ntfy.sh relays a wake-up that carries only a message id; the phone then
# fetches the message itself from this server over Tailscale.
#
# ntfy's public address is DASH_PUBLIC_URL (the hub's tailnet address, set in ~/.config/dash/hub.env,
# which dash-hub.service reads too) on port 8443.
set -euo pipefail
if [ -f ~/.config/dash/hub.env ]; then
    set -a
    . ~/.config/dash/hub.env
    set +a
fi
if [ -z "${DASH_PUBLIC_URL:-}" ]; then
    echo "ntfy: DASH_PUBLIC_URL isn't set. Add a line like DASH_PUBLIC_URL=https://dash-hub.your-tailnet.ts.net" >&2
    echo "      to ~/.config/dash/hub.env on the hub (tailscale status shows the name), then run this again." >&2
    exit 1
fi
PUBLIC="${DASH_PUBLIC_URL%/}:8443"
DATA=$HOME/.local/share/dash
CONF=$HOME/.config/dash-ntfy
mkdir -p "$DATA/ntfy" "$DATA/secrets" "$CONF" ~/.config/systemd/user
chmod 700 "$DATA/secrets"
cat > "$CONF/server.yml" <<YML
base-url: "$PUBLIC"
listen-http: "127.0.0.1:2586"
behind-proxy: true
upstream-base-url: "https://ntfy.sh"
cache-file: "$DATA/ntfy/cache.db"
cache-duration: "72h"
auth-file: "$DATA/ntfy/auth.db"
auth-default-access: "read-only"
enable-signup: false
enable-login: false
web-root: "disable"
YML
cp ~/Dash/hub/deploy/ntfy.service ~/.config/systemd/user/dash-ntfy.service
systemctl --user daemon-reload
systemctl --user enable dash-ntfy.service >/dev/null
systemctl --user restart dash-ntfy.service
sleep 1
if [ ! -s "$DATA/secrets/ntfy.json" ]; then
    AUTH=(--auth-file "$DATA/ntfy/auth.db" --auth-default-access read-only)
    NTFY_PASSWORD=$(openssl rand -hex 24) ntfy user "${AUTH[@]}" add --role=admin dash >/dev/null
    TOKEN=$(ntfy token "${AUTH[@]}" add dash | grep -o 'tk_[A-Za-z0-9]*')
    [ -n "$TOKEN" ] || { echo "ntfy: couldn't create a publish token" >&2; exit 1; }
    TOPIC=dash-$(openssl rand -hex 8)
    umask 077
    printf '{"url":"http://127.0.0.1:2586","public":"%s","topic":"%s","token":"%s"}\n' "$PUBLIC" "$TOPIC" "$TOKEN" > "$DATA/secrets/ntfy.json"
    echo "ntfy: created the publish token and topic"
fi
tailscale serve --bg --https=8443 http://127.0.0.1:2586 >/dev/null
