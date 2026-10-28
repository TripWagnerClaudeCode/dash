#!/bin/zsh
# Deploys the hub from this Mac to dash-hub over Tailscale SSH.
#
#   hub/deploy/deploy.sh --setup   first time: installs Node, Claude Code, Syncthing and jarvis on the hub
#   hub/deploy/deploy.sh           every time after: tests here, copies the committed code (HEAD, never
#                                  uncommitted edits), tests again on the hub's Node, then swaps it in and restarts
#
# Restarting the hub drops the apps for a few seconds; they reconnect on their own.
set -euo pipefail
HUB=${DASH_HUB_HOST:-dash-hub}
# Package installs run as root over Tailscale SSH, since sudo would wait for a password.
HUB_ROOT=root@$HUB
ROOT=${0:A:h:h:h}

if [[ "${1:-}" == "--setup" ]]; then
    echo "Installing Node 24, Syncthing and Claude Code on $HUB…"
    ssh "$HUB_ROOT" 'bash -s' <<'EOF'
set -euo pipefail
if ! node --version 2>/dev/null | grep -q '^v2[4-9]'; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
fi
command -v syncthing >/dev/null || apt-get install -y syncthing
EOF
    ssh "$HUB" 'bash -s' <<'EOF'
set -euo pipefail
command -v claude >/dev/null || [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash
systemctl --user enable --now syncthing.service
mkdir -p ~/.claude/mcp-servers ~/.jarvis ~/Dash
chmod 700 ~/.jarvis
EOF
    echo "Copying jarvis…"
    rsync -az --delete --exclude .venv --exclude __pycache__ --exclude .env --exclude synced \
        "$ROOT/companions/jarvis-mcp/" "$HUB:.claude/mcp-servers/jarvis-mcp/"
    ssh "$HUB" 'cd ~/.claude/mcp-servers/jarvis-mcp && [ -d .venv ] || python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt'
    echo "Copying the Google sign-in for jarvis…"
    scp -q ~/.jarvis/credentials.json ~/.jarvis/google_token.json "$HUB:.jarvis/"
    ssh "$HUB" 'chmod 600 ~/.jarvis/*'
    echo
    echo "Next: sign Claude Code in on the hub once:  ssh -t $HUB claude"
    echo "Then run this script again without --setup."
    exit 0
fi

# Only committed code goes to the hub, so /health's version always names exactly what's running.
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "There are uncommitted changes; commit (or stash) them first, so the hub runs a known commit."
    git -C "$ROOT" status --short
    exit 1
fi
VERSION=$(git -C "$ROOT" describe --always --dirty)

echo "Running the tests here first…"
(cd "$ROOT/hub" && npm run -s check && npm run -s selftest > /dev/null && npm run -s portfoliotest > /dev/null) \
    || { echo "A hub test failed; not deploying. Run: cd hub && npm run check && npm run selftest && npm run portfoliotest"; exit 1; }
(cd "$ROOT/mobile" && npx tsc --noEmit) || { echo "The phone app doesn't type-check; not deploying."; exit 1; }

# ntfy (phone notifications) comes from its own apt repository.
ssh "$HUB_ROOT" 'bash -s' <<'EOF'
set -euo pipefail
if ! command -v ntfy >/dev/null; then
    mkdir -p /etc/apt/keyrings
    curl -fsSL -o /etc/apt/keyrings/ntfy.gpg https://archive.ntfy.sh/apt/keyring.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/ntfy.gpg] https://archive.ntfy.sh/apt stable main" > /etc/apt/sources.list.d/ntfy.list
    apt-get update -qq && apt-get install -y -qq ntfy >/dev/null
    # The package's own system service isn't used; Dash runs ntfy as a user service.
    systemctl disable --now ntfy.service >/dev/null 2>&1 || true
fi
EOF

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git -C "$ROOT" archive HEAD hub mobile companions/jarvis-mcp | tar -x -C "$STAGE"
echo "$VERSION" > "$STAGE/hub/VERSION"

echo "Copying $VERSION to $HUB…"
ssh "$HUB" 'rm -rf ~/Dash.new'
# jarvis waits in Dash.new too, and only replaces the live copy once the hub's tests pass.
rsync -az "$STAGE/hub" "$STAGE/mobile" "$STAGE/companions/jarvis-mcp" "$HUB:Dash.new/"

ssh "$HUB" "VERSION=$VERSION bash -s" <<'EOF'
set -euo pipefail
# The hub's own settings (alert email, tailnet address) live outside the repo; setup-ntfy.sh needs them.
grep -qs '^DASH_PUBLIC_URL=' ~/.config/dash/hub.env || {
    echo "Add DASH_PUBLIC_URL (and DASH_ALERT_EMAIL) to ~/.config/dash/hub.env on the hub first; see hub/deploy/dash-hub.service. Nothing changed."
    exit 1
}
cd ~/Dash.new/hub && npm ci --omit=dev --silent
# The hub's own Node, not just the Mac's. If this fails, the running hub and jarvis are left exactly as they were.
npm run -s selftest > /dev/null || { echo "The self-test failed on the hub; nothing changed. To see why: cd ~/Dash.new/hub && npm run selftest"; exit 1; }
cd ~/Dash.new/mobile && npm ci --silent
# jarvis runs from its own folder; the hub starts it, so the restart below picks up the new copy.
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude .env --exclude synced --exclude tests \
    ~/Dash.new/jarvis-mcp/ ~/.claude/mcp-servers/jarvis-mcp/
rm -rf ~/Dash.new/jarvis-mcp
cd ~/.claude/mcp-servers/jarvis-mcp && .venv/bin/pip install -q -r requirements.txt
rm -rf ~/Dash.prev
[ -d ~/Dash ] && mv ~/Dash ~/Dash.prev
mv ~/Dash.new ~/Dash
mkdir -p ~/.config/systemd/user
cp ~/Dash/hub/deploy/dash-hub.service ~/Dash/hub/deploy/dash-metro.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable dash-hub.service dash-metro.service >/dev/null
~/Dash/hub/deploy/setup-ntfy.sh
systemctl --user restart dash-hub.service
# Metro runs in CI mode (no file watching), so it only serves app changes after a restart.
systemctl --user restart dash-metro.service
tailscale serve --bg http://127.0.0.1:47900 >/dev/null
sleep 2
curl -fsS http://127.0.0.1:47900/health && echo
echo "$(date -Is) $VERSION" >> ~/Dash-deploys.log
EOF
echo "Deployed $VERSION. The previous version is in ~/Dash.prev on the hub."
