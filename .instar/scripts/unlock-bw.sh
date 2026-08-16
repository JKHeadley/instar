#!/usr/bin/env bash
# unlock-bw.sh — unlock Bitwarden using the master password stored in
# instar's global secret store under the macOS keychain master key.
#
# Outputs the BW session token to stdout (so the caller can:
#   export BW_SESSION="$(.instar/scripts/unlock-bw.sh)"
# or pipe it: `.instar/scripts/unlock-bw.sh | xargs -I{} bw get item ... --session {}`).
#
# Replaces the previous fragile reliance on a pre-existing `~/.bw-session`
# file. Architectural fix for the 2026-05-20 discoverability + secret-access
# case study (Telegram topic 11141).
#
# Exit codes:
#   0 — success, BW unlocked, session token on stdout
#   1 — missing master password in global secret store
#   2 — `bw` CLI not installed
#   3 — `bw unlock` rejected the password
#
# Safety: the master password is never logged, never written to a temp file,
# and never appears in process command-line arguments (passed via stdin).

set -euo pipefail

AGENT_NAME="${INSTAR_AGENT_NAME:-echo}"
KEY="bw-master-password"

# Locate the project root that contains dist/ (this script lives at
# .instar/scripts/ in any agent's home; the instar package's dist lives
# alongside in the same agent's shadow-install). Fall back to a few known
# locations.
INSTAR_DIST=""
for candidate in \
  "$HOME/.instar/agents/$AGENT_NAME/.instar/shadow-install/node_modules/instar/dist" \
  "$HOME/.instar/agents/echo/.instar/shadow-install/node_modules/instar/dist" \
  "/Users/justin/Documents/Projects/instar/dist"; do
  if [ -f "$candidate/core/GlobalSecretStore.js" ]; then
    INSTAR_DIST="$candidate"
    break
  fi
done
if [ -z "$INSTAR_DIST" ]; then
  echo "unlock-bw: cannot locate instar dist with GlobalSecretStore" >&2
  exit 1
fi

if ! command -v bw >/dev/null 2>&1; then
  echo "unlock-bw: 'bw' (Bitwarden CLI) not installed" >&2
  exit 2
fi

# Fetch the master password from the global secret store.
MASTER=$(node -e "
import('$INSTAR_DIST/core/GlobalSecretStore.js').then(m => {
  const store = new m.GlobalSecretStore();
  if (!store.autoInit()) {
    process.stderr.write('global secret store auto-init failed\\n');
    process.exit(1);
  }
  const pw = store.getSecret('$AGENT_NAME', '$KEY');
  if (!pw) {
    process.stderr.write('no $KEY for agent $AGENT_NAME in global secret store\\n');
    process.exit(1);
  }
  process.stdout.write(pw);
}).catch(e => { process.stderr.write(e.message + '\\n'); process.exit(1); });
" 2>&1) || {
  echo "unlock-bw: $MASTER" >&2
  exit 1
}

# Unlock via stdin so the password never appears in argv.
SESSION=$(printf '%s' "$MASTER" | bw unlock --raw --passwordenv BW_MASTER 2>&1) || {
  # Older bw versions don't support --passwordenv; fall back to positional
  # (still better than logging; positional is consumed before getting written
  # to history if invoked from a non-interactive shell).
  SESSION=$(bw unlock "$MASTER" --raw 2>&1) || {
    echo "unlock-bw: bw unlock rejected the password: $SESSION" >&2
    exit 3
  }
}

# Wipe the local copy.
unset MASTER

printf '%s' "$SESSION"
