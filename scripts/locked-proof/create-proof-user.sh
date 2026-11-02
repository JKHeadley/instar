#!/usr/bin/env bash
# Create the throwaway macOS user for the locked-Mac proof run (instarproof).
#
#   create-proof-user.sh --agent-home DIR [--execute] [--replace-vault]
#
# Without --execute it only prints the plan. With --execute (run as an admin with
# passwordless sudo, on the proof Mac):
#   1. generates a throwaway password (20 lowercase letters/digits, layout-safe),
#   2. stores it in the agent's vault FIRST (credential-store.mjs, value on stdin),
#      under key locked_proof_user_password, so no password exists that the vault lacks,
#   3. creates the standard (non-admin) user with sysadminctl, answering its password
#      prompt through a pseudo-terminal (never on a command line, never in a log),
#   4. clears the user's account policies, so macOS does not force a password change
#      at first login and does not lock the account after failed attempts,
#   5. checks the stored password authenticates (dscl -authonly, again by prompt).
# The password is never printed. Remove everything with remove-proof-user.sh.
#
# Tests point LOCKED_PROOF_FAKE_BIN at stand-in commands; then sudo is not used.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROOF_USER="instarproof"
VAULT_KEY="locked_proof_user_password"
AGENT_HOME=""
EXECUTE=0
REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-home) AGENT_HOME="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --replace-vault) REPLACE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$AGENT_HOME" ] || { echo "--agent-home is required" >&2; exit 2; }

if [ -n "${LOCKED_PROOF_FAKE_BIN:-}" ]; then
  SUDO=""; BIN="$LOCKED_PROOF_FAKE_BIN"
  SYSADMINCTL="$BIN/sysadminctl"; DSCL="$BIN/dscl"; PWPOLICY="$BIN/pwpolicy"; STORE="$BIN/credential-store"
else
  SUDO="sudo -n"
  SYSADMINCTL="/usr/sbin/sysadminctl"; DSCL="/usr/bin/dscl"; PWPOLICY="/usr/bin/pwpolicy"
  STORE="node $AGENT_HOME/.instar/scripts/credential-store.mjs"
fi

HOST_LABEL="$(scutil --get ComputerName 2>/dev/null || hostname)"
echo "Plan: create standard user '$PROOF_USER' on $HOST_LABEL; password generated here, stored in the vault of $AGENT_HOME as '$VAULT_KEY' (and Bitwarden) before the user exists; account policies cleared (no forced change at first login)."
if [ "$EXECUTE" -ne 1 ]; then
  echo "Dry run: nothing done. Add --execute on the proof Mac to do it."
  exit 0
fi

if [ -z "${LOCKED_PROOF_FAKE_BIN:-}" ]; then
  [ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 1; }
  sudo -n true 2>/dev/null || { echo "needs passwordless sudo" >&2; exit 1; }
fi
if $DSCL . -read "/Users/$PROOF_USER" UniqueID >/dev/null 2>&1; then
  echo "user $PROOF_USER already exists; remove it first (remove-proof-user.sh)" >&2
  exit 1
fi

PW="$(node --input-type=module -e "import { generateProofPassword } from '$HERE/lib.mjs'; process.stdout.write(generateProofPassword());")"
[ "${#PW}" -eq 20 ] || { echo "password generation failed" >&2; exit 1; }

FORCE_ARG=""
[ "$REPLACE" -eq 1 ] && FORCE_ARG="--force"
# printf is a shell builtin: the value is never an argument of any process.
printf '%s' "$PW" | (cd "$AGENT_HOME" && $STORE "$VAULT_KEY" --bw-name "Instar locked-proof test user ($HOST_LABEL)" \
  --bw-user "$PROOF_USER" --bw-note "Throwaway macOS user for the locked-screen proof run. Delete with the user." $FORCE_ARG)
echo "stored in the vault as $VAULT_KEY"

printf '%s' "$PW" | $SUDO python3 "$HERE/pty-feed.py" --prompts 2 --timeout 120 -- \
  $SYSADMINCTL -addUser "$PROOF_USER" -fullName "Instar proof" -password -
$SUDO $PWPOLICY -u "$PROOF_USER" -clearaccountpolicies >/dev/null
printf '%s' "$PW" | $SUDO python3 "$HERE/pty-feed.py" --prompts 1 --timeout 30 -- $DSCL . -authonly "$PROOF_USER"
unset PW
echo "created $PROOF_USER; the stored password authenticates"
