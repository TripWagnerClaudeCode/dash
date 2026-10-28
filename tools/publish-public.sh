#!/bin/zsh
# Publishes the committed code (HEAD) to a separate public repository as one new commit, with no
# history from this one. Before anything is copied, the snapshot is checked twice and nothing is
# published if either check finds something:
#   - every line of ~/.config/dash/public-denylist (one regex per line, case-sensitive: your name,
#     addresses, hostnames…; kept outside the repo, since it lists exactly what mustn't be public)
#   - gitleaks, for keys and tokens
#
#   tools/publish-public.sh                      # check and commit into ~/Dash-public, don't push
#   tools/publish-public.sh --push               # …and push it
#
# The first run creates ~/Dash-public; point it at the public repo once with
#   git -C ~/Dash-public remote add origin git@github.com:<you>/<repo>.git
set -euo pipefail
ROOT=${0:A:h:h}
OUT=${DASH_PUBLIC_DIR:-$HOME/Dash-public}
DENYLIST=${DASH_PUBLIC_DENYLIST:-$HOME/.config/dash/public-denylist}
AUTHOR=${DASH_PUBLIC_AUTHOR:-"Dash authors <noreply@example.com>"}

if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "Commit (or stash) your changes first; only committed code is published." >&2
    exit 1
fi
[[ -f "$DENYLIST" ]] || { echo "No $DENYLIST; create it (one regex per line) so private details can be caught." >&2; exit 1; }
command -v gitleaks >/dev/null || { echo "Install gitleaks first: brew install gitleaks" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE"

echo "Checking the snapshot for private details…"
found=0
while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    if grep -rIlE -- "$pattern" "$STAGE" > /dev/null; then
        echo "  matches a denylist line:" >&2
        grep -rInE -- "$pattern" "$STAGE" | sed "s#^$STAGE/#    #" | head -5 >&2
        found=1
    fi
done < "$DENYLIST"
gitleaks dir "$STAGE" --no-banner --redact > /dev/null 2>&1 || { echo "  gitleaks found a possible secret: gitleaks dir . -v" >&2; found=1; }
(( found == 0 )) || { echo "Nothing was published." >&2; exit 1; }

if [[ ! -d "$OUT/.git" ]]; then
    git init -q -b main "$OUT"
fi
rsync -a --delete --exclude .git "$STAGE/" "$OUT/"
cd "$OUT"
git add -A
if git diff --cached --quiet; then
    echo "The public copy is already up to date."
else
    git -c user.name="${AUTHOR% <*}" -c user.email="${${AUTHOR#*<}%>}" commit -q -m "Dash $(date +%Y-%m-%d)"
    echo "Committed to $OUT: $(git log -1 --format='%h %s')"
fi
if [[ "${1:-}" == "--push" ]]; then
    git push -q -u origin main
    echo "Pushed."
fi
