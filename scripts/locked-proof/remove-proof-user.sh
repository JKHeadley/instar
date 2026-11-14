#!/usr/bin/env bash
# Tear down the locked-Mac proof user: stop its agents, log it out, delete it.
#   remove-proof-user.sh [--execute]
# Its macOS permission rows stay (they name a path that no longer exists). The vault
# key locked_proof_user_password is left for the operator-side agent to delete.
set -euo pipefail
PROOF_USER="instarproof"
EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
echo "Plan: stop $PROOF_USER's processes, log it out, delete the user and its home (sysadminctl -deleteUser)."
[ "$EXECUTE" -eq 1 ] || { echo "Dry run: nothing done."; exit 0; }
dscl . -read "/Users/$PROOF_USER" UniqueID >/dev/null 2>&1 || { echo "no user $PROOF_USER"; exit 0; }
[ "$(stat -f %Su /dev/console)" = "$PROOF_USER" ] && { echo "refusing: $PROOF_USER is on the console; switch to another user first" >&2; exit 1; }
UID_N="$(id -u "$PROOF_USER")"
sudo -n launchctl bootout "gui/$UID_N" 2>/dev/null || true
sudo -n pkill -KILL -U "$PROOF_USER" || true
sudo -n /usr/sbin/sysadminctl -deleteUser "$PROOF_USER" -secure
echo "removed $PROOF_USER"
