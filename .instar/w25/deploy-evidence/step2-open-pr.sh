#!/usr/bin/env bash
# Step 2 — open the release PR. Run ONLY after w25-deploy-preflight.sh exits 0.
set -euo pipefail
cd /Users/dabombstudio/.instar/agents/echo
.instar/scripts/w25-deploy-preflight.sh >/dev/null || { echo "REFUSED: preflight is not green"; exit 1; }
TIP=$(git ls-remote origin refs/heads/w25/release-candidate | cut -c1-9)
[ -n "$TIP" ] || { echo "REFUSED: w25/release-candidate not on origin"; exit 1; }
echo "opening PR from w25/release-candidate ($TIP) -> main"
gh pr create --base main --head w25/release-candidate \
  --title "W25 CONVERSION: seven proven W24 repairs, composed and measured together" \
  --body-file .instar/w25/PR-BODY.md
gh pr view --json number,url --jq '"PR #\(.number) \(.url)"'
