#!/usr/bin/env bash
# Run inside Ubuntu on the Windows PC, as root, so nothing asks for a password. From PowerShell:
#   wsl -d Ubuntu-24.04 -u root            (opens a root shell; paste this script there)
# Turns on systemd, installs Tailscale and joins the tailnet as "dash-hub" with Tailscale SSH, so the
# Mac can finish the setup and deploy over `ssh dash-hub`. The hub itself runs as your regular Ubuntu user.
# Run it twice: the first run turns on systemd and asks you to restart WSL.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
    echo "Run this as root so it doesn't need a password. In PowerShell run:"
    echo "  wsl -d Ubuntu-24.04 -u root"
    echo "and paste it again there."
    exit 1
fi
# The regular user Ubuntu made at first launch (always uid 1000).
HUB_USER=$(id -nu 1000 2>/dev/null || true)
if [ -z "$HUB_USER" ]; then
    echo "There's no regular Ubuntu user yet. Open Ubuntu from the Start menu once to create one, then run this again."
    exit 1
fi

if ! grep -qs '^systemd=true' /etc/wsl.conf; then
    if grep -qs '^\[boot\]' /etc/wsl.conf; then
        sed -i 's/^\[boot\]$/[boot]\nsystemd=true/' /etc/wsl.conf
    else
        printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf
    fi
    echo
    echo "systemd is on. Now, in PowerShell, run:"
    echo "  wsl --shutdown"
    # Run from a file, $0 is that file, so keep a copy to run again. Pasted into a shell, $0 is just "bash".
    if [ -f "$0" ]; then
        cp "$0" /root/setup-wsl.sh
        echo "  wsl -d Ubuntu-24.04 -u root bash /root/setup-wsl.sh"
    else
        echo "then open Ubuntu again and paste this script once more."
    fi
    exit 0
fi

apt-get update
apt-get install -y curl git build-essential python3-venv python3-pip rsync
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
# User services (the hub, Metro, Syncthing) keep running with no Ubuntu window open.
loginctl enable-linger "$HUB_USER"
echo
echo "Opening a Tailscale sign-in link. Sign in with the same account as the Mac and iPhone."
# --operator lets the hub publish itself with `tailscale serve` without root.
tailscale up --ssh --hostname dash-hub --operator="$HUB_USER"
echo
tailscale status
echo
echo "Done. In the Tailscale admin console (Machines), open dash-hub and choose 'Disable key expiry'."
