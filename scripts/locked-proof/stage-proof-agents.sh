#!/usr/bin/env bash
# Stage the locked-Mac proof install and its two agents inside the throwaway user.
#
# Three steps, in this order. Each prints the next one when it finishes.
#
#   1. stage-proof-agents.sh --tgz PATH --agent-home DIR [--execute]   install + init + configure (user need not be logged in)
#   2. stage-proof-agents.sh --start [--execute]                       start both servers in the user's login session (after first login)
#   3. stage-proof-agents.sh --finalize --agent-home DIR [--execute]   REQUIRED before any driver run: record each agent as its
#                                                                      own desktop front (needs the machine id from step 2), restart
#
# --agent-home is the operator-side agent home whose vault holds the proof agents'
# dashboard PIN (key locked_proof_dashboard_pin). The PIN is piped to the proof user's
# configure step on stdin; it is never printed or put on a command line. The driver
# refuses to run until both agents have a PIN and are their own front.
#
# Agent A: locked-proof on port 4098 with a Cloudflare quick tunnel. Agent B:
# locked-proof-b on port 4097 (for the "across agents" cases). Both run the
# -lockedproof test build from the user's own prefix, with auto-update off.
# Without --execute it prints the plan only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROOF_USER="instarproof"
HOME_DIR="/Users/$PROOF_USER"
PREFIX="$HOME_DIR/.instar/proof-install"
INSTAR="$PREFIX/node_modules/.bin/instar"
A="$HOME_DIR/.instar/agents/locked-proof"
B="$HOME_DIR/.instar/agents/locked-proof-b"
PIN_KEY="locked_proof_dashboard_pin"
MODE="stage"; TGZ=""; EXECUTE=0; AGENT_HOME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tgz) TGZ="$2"; shift 2 ;;
    --agent-home) AGENT_HOME="$2"; shift 2 ;;
    --start) MODE="start"; shift ;;
    --finalize) MODE="finalize"; shift ;;
    --execute) EXECUTE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

as_user() { sudo -n -u "$PROOF_USER" -H "$@"; }
# Reads the proof agents' dashboard PIN from the operator's vault into PIN. Never printed.
read_pin() {
  [ -n "$AGENT_HOME" ] || { echo "--agent-home is required: the proof agents' dashboard PIN comes from its vault ($PIN_KEY)" >&2; exit 2; }
  PIN="$(cd "$AGENT_HOME" && node .instar/scripts/secret-get.mjs "$PIN_KEY" 2>/dev/null || true)"
  [ -n "$PIN" ] || { echo "vault key $PIN_KEY is empty in $AGENT_HOME: store a 6-digit PIN there first (credential-store.mjs)" >&2; exit 1; }
}
# configure-proof-agent.mjs as the proof user, with the PIN on stdin.
configure() { printf '%s' "$PIN" | as_user node "$HERE/configure-proof-agent.mjs" "$@" --pin-stdin --execute; }
in_session() { sudo -n launchctl asuser "$(id -u "$PROOF_USER")" sudo -n -u "$PROOF_USER" -H "$@"; }

case "$MODE" in
  stage)
    [ -n "$TGZ" ] || { echo "--tgz is required" >&2; exit 2; }
    case "$(basename "$TGZ")" in *-lockedproof.*.tgz) ;; *) echo "refusing: $TGZ is not a -lockedproof test build" >&2; exit 1 ;; esac
    echo "Plan: install $TGZ into $PREFIX as $PROOF_USER; init $A (:4098, quick tunnel) and $B (:4097); auto-update off; no start-on-login job."
    [ "$EXECUTE" -eq 1 ] || { echo "Dry run: nothing done."; exit 0; }
    read_pin
    dscl . -read "/Users/$PROOF_USER" UniqueID >/dev/null || { echo "user $PROOF_USER does not exist" >&2; exit 1; }
    STAGED="/Users/Shared/instar-locked-proof-$(basename "$TGZ")"
    cp "$TGZ" "$STAGED"; chmod 0644 "$STAGED"
    as_user mkdir -p "$PREFIX"
    as_user npm install --prefix "$PREFIX" --no-audit --no-fund "$STAGED"
    as_user "$INSTAR" init --standalone locked-proof --port 4098 --keep
    as_user "$INSTAR" init --standalone locked-proof-b --port 4097 --keep
    configure "$A" --port 4098 --tunnel
    configure "$B" --port 4097
    as_user cp "$HERE/reset-attempts.py" "$HOME_DIR/.instar/reset-attempts.py"
    echo "staged. Next: the person logs in to $PROOF_USER once, then: $0 --start --execute"
    ;;
  start)
    echo "Plan: start both proof servers inside $PROOF_USER's login session."
    [ "$EXECUTE" -eq 1 ] || { echo "Dry run: nothing done."; exit 0; }
    [ "$(stat -f %Su /dev/console)" = "$PROOF_USER" ] || echo "note: $PROOF_USER is not on the console; its session must exist (log in once)"
    in_session "$INSTAR" server start --dir "$A"
    in_session "$INSTAR" server start --dir "$B"
    echo "started. Next (required before the driver): $0 --finalize --agent-home DIR --execute"
    ;;
  finalize)
    echo "Plan: make each proof agent its own desktop front, then restart both."
    [ "$EXECUTE" -eq 1 ] || { echo "Dry run: nothing done."; exit 0; }
    read_pin
    configure "$A" --port 4098 --tunnel --front
    configure "$B" --port 4097 --front
    in_session "$INSTAR" server restart --dir "$A" || in_session "$INSTAR" server start --dir "$A"
    in_session "$INSTAR" server restart --dir "$B" || in_session "$INSTAR" server start --dir "$B"
    echo "finalized. Next: node $HERE/driver.mjs calibrate --execute --agent-home DIR --playwright DIR"
    ;;
esac
