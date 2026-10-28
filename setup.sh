#!/bin/zsh
# One-time setup of everything Dash depends on, for a fresh Mac. Safe to re-run:
# it never overwrites an existing skill folder or jarvis config.
#
#   git clone <this repo> ~/Dash && cd ~/Dash && ./setup.sh
#
# Installs the jarvis MCP server (~/.claude/mcp-servers/jarvis-mcp) with its own venv, copies any
# Claude Code skills in companions/skills into ~/.claude/skills, registers jarvis, then builds Dash.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD

say() { print -P "%F{cyan}==>%f $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1 }; }

[[ "$(uname)" == "Darwin" ]] || { echo "Dash is macOS only."; exit 1 }
need swift "Run: xcode-select --install"
need claude "Install Claude Code (https://claude.com/claude-code), run 'claude' once and log in."

# jarvis needs Python 3.10+ (the mcp package requires it).
PY=""
for p in python3.13 python3.12 python3.11 python3.10; do
    command -v $p >/dev/null 2>&1 && { PY=$(command -v $p); break }
done
if [[ -z "$PY" ]]; then
    need brew "Install Homebrew (https://brew.sh) or Python 3.10+."
    say "Installing Python 3.12"
    brew install python@3.12
    PY=$(command -v python3.12 || echo "$(brew --prefix)/opt/python@3.12/bin/python3.12")
fi

JARVIS=$HOME/.claude/mcp-servers/jarvis-mcp
say "Installing jarvis MCP server to $JARVIS"
mkdir -p "$JARVIS"
rsync -a --exclude '.env' companions/jarvis-mcp/ "$JARVIS/"
[[ -x "$JARVIS/.venv/bin/python" ]] || "$PY" -m venv "$JARVIS/.venv"
"$JARVIS/.venv/bin/pip" install -q --upgrade pip
"$JARVIS/.venv/bin/pip" install -q -r "$JARVIS/requirements.txt"
"$JARVIS/.venv/bin/python" -m playwright install chromium || echo "(browser tools skipped: playwright install failed)"

say "Registering jarvis with Claude Code"
if claude mcp get jarvis >/dev/null 2>&1; then
    echo "jarvis already registered, leaving it."
else
    claude mcp add jarvis -s user -- "$JARVIS/.venv/bin/python" "$JARVIS/server.py"
fi

# Skills aren't part of the repo; put your own in companions/skills to have them installed here.
if [[ -d companions/skills ]]; then
    say "Copying skills to ~/.claude/skills (existing folders are kept)"
    mkdir -p "$HOME/.claude/skills"
    for d in companions/skills/*/(N); do
        name=${d:t}
        if [[ -e "$HOME/.claude/skills/$name" ]]; then
            echo "  keep   $name"
        else
            cp -R "$d" "$HOME/.claude/skills/$name"
            echo "  add    $name"
        fi
    done
fi

mkdir -p "$HOME/.jarvis" "$HOME/Documents/Dash" "$HOME/Library/Application Support/Dash"

say "Building and installing Dash"
./build.sh --install

cat <<EOF

Done. Left to do by hand (secrets are deliberately not in the repo):

  1. Google email + calendar: put your OAuth client file at ~/.jarvis/credentials.json
     (Google Cloud Console > Desktop app client, Gmail + Calendar + Docs APIs). The first
     email/calendar call opens a browser to sign in.
  2. Optional: copy ~/ABOUT_ME.md from your old Mac (Dash and the study skills read it).
  3. Robinhood: open Dash > Portfolio > Connect (tokens live in the Keychain, per Mac).
  4. Permissions: Dash asks for Screen Recording and Microphone on first use.
  5. Brightspace to-do (~/BrightspaceToDo/todo.md) is rebuilt by the brightspace-todo skill.
  6. Optional, keeps Screen Recording permission across rebuilds: create a self-signed code
     signing certificate named "Dash Local Signing" in Keychain Access, then ./build.sh --install.
     Without it the build is ad-hoc signed and macOS re-asks after each rebuild.

Open Dash with: open ~/Applications/Dash.app   (⌥L console, ⌥A lens)
EOF
