#!/bin/zsh
# Puts Syncthing's per-folder settings for Dash in place, on this Mac and on dash-hub. Safe to run again.
# The folders themselves (and pairing the two devices) were set up by hand; this keeps the parts that
# matter for safety in the repo: the ignore lists, and file versioning so a bad write or delete on one
# side can be undone from the other (~/<folder>/.stversions).
set -euo pipefail
HUB=${DASH_HUB_HOST:-dash-hub}
HERE=${0:A:h}
SYNCED=(documents desktop dash-shared skills brightspace)   # staggered versions, kept 30 days
TRASH=(downloads)                                           # deleted/replaced files kept 14 days

versioning() {   # runs the same commands on whichever side it's piped to
    cat <<EOF
for f in ${SYNCED[*]}; do
    syncthing cli config folders \$f versioning type set staggered
    syncthing cli config folders \$f versioning params set maxAge 2592000
done
for f in ${TRASH[*]}; do
    syncthing cli config folders \$f versioning type set trashcan
    syncthing cli config folders \$f versioning params set cleanoutDays 14
done
EOF
}

echo "This Mac…"
versioning | zsh
for f in ${SYNCED[*]} ${TRASH[*]}; do cp "$HERE/shared.stignore" "$(syncthing cli config folders $f path get)/.stignore"; done
cp "$HERE/hub-backup.stignore" "$(syncthing cli config folders dash-hub-data path get)/.stignore"

echo "$HUB…"
versioning | ssh "$HUB" bash
for f in ${SYNCED[*]} ${TRASH[*]}; do
    scp -q "$HERE/shared.stignore" "$HUB:$(ssh "$HUB" syncthing cli config folders $f path get)/.stignore"
done
scp -q "$HERE/hub-data.stignore" "$HUB:.local/share/dash/.stignore"
echo "Done."
