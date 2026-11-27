#!/usr/bin/env bash
# Tear down a locked-Mac proof user: stop its agents, log it out, delete it.
#   remove-proof-user.sh [--fixture proof|switch] [--execute]
# --fixture is the same closed choice as create-proof-user.sh; nothing else names the
# account, so no other user on the Mac can be passed in:
#   proof  (default) instarproof        (made with full name "Instar proof")
#   switch           instarproofswitch  (made with full name "Instar proof switch")
# It refuses, before stopping anything, when the account is on the console, is not
# confirmed outside the admin group, or does not carry the full name its create step set.
# Its macOS permission rows stay (they name a path that no longer exists). Its vault key
# is left for the operator-side agent to delete.
#
# Tests point LOCKED_PROOF_FAKE_BIN at stand-in commands; then sudo is not used.
set -euo pipefail
FIXTURE="proof"
EXECUTE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$FIXTURE" in
  proof)  PROOF_USER="instarproof";       FULL_NAME="Instar proof" ;;
  switch) PROOF_USER="instarproofswitch"; FULL_NAME="Instar proof switch" ;;
  *) echo "unknown fixture: $FIXTURE (proof or switch)" >&2; exit 2 ;;
esac

if [ -n "${LOCKED_PROOF_FAKE_BIN:-}" ]; then
  SUDO=""; BIN="$LOCKED_PROOF_FAKE_BIN"
  DSCL="$BIN/dscl"; MEMBERUTIL="$BIN/dsmemberutil"; LAUNCHCTL="$BIN/launchctl"; PKILL="$BIN/pkill"
  SYSADMINCTL="$BIN/sysadminctl"; CONSOLE_OWNER="$BIN/console-owner"; ID="$BIN/id"
else
  SUDO="sudo -n"
  DSCL="/usr/bin/dscl"; MEMBERUTIL="/usr/bin/dsmemberutil"; LAUNCHCTL="/bin/launchctl"; PKILL="/usr/bin/pkill"
  SYSADMINCTL="/usr/sbin/sysadminctl"; CONSOLE_OWNER="stat -f %Su /dev/console"; ID="/usr/bin/id"
fi

echo "Plan: stop $PROOF_USER's processes, log it out, delete the user and its home (sysadminctl -deleteUser)."
[ "$EXECUTE" -eq 1 ] || { echo "Dry run: nothing done."; exit 0; }
$DSCL . -read "/Users/$PROOF_USER" UniqueID >/dev/null 2>&1 || { echo "no user $PROOF_USER"; exit 0; }
OWNER="$($CONSOLE_OWNER 2>/dev/null || true)"
[ -n "$OWNER" ] || { echo "refusing: the console owner could not be read" >&2; exit 1; }
[ "$OWNER" != "$PROOF_USER" ] || { echo "refusing: $PROOF_USER is on the console; switch to another user first" >&2; exit 1; }
if [ "$($MEMBERUTIL checkmembership -U "$PROOF_USER" -G admin 2>/dev/null || true)" != "user is not a member of the group" ]; then
  echo "refusing: $PROOF_USER is not confirmed outside the admin group, so it is not the throwaway this script made" >&2
  exit 1
fi
# dscl prints "RealName: x", or "RealName:" with the value on the next, indented line.
REAL_NAME="$($DSCL . -read "/Users/$PROOF_USER" RealName 2>/dev/null \
  | awk 'sub(/^RealName:[ ]*/, "") { sub(/[ ]+$/, ""); if ($0 != "") { print; exit } want = 1; next } want { gsub(/^[ ]+|[ ]+$/, ""); print; exit }' || true)"
if [ "$REAL_NAME" != "$FULL_NAME" ]; then
  echo "refusing: $PROOF_USER has full name '$REAL_NAME', not '$FULL_NAME', so it is not the throwaway this script made" >&2
  exit 1
fi
UID_N="$($ID -u "$PROOF_USER")"
$SUDO $LAUNCHCTL bootout "gui/$UID_N" 2>/dev/null || true
$SUDO $PKILL -KILL -U "$PROOF_USER" || true
$SUDO $SYSADMINCTL -deleteUser "$PROOF_USER" -secure
echo "removed $PROOF_USER"
