#!/usr/bin/env bash
# push-gate.sh — Layer 2 of PR-REVIEW-HARDENING enforcement.
# Queries the local Echo server's /pr-gate/status for the current
# (PR, head-sha) before allowing a git push to proceed.
#
# Usage (from inside the fork-and-fix skill):
#   PR_NUMBER=42 HEAD_SHA=abc123 push-gate.sh || exit 1
#
# Exit codes:
#   0  — eligible, proceed
#   1  — blocked by gate (refuse push)
#   2  — gate unavailable after retries (treat as pending, not pass)
#
# Phase A semantics: prGate.phase='off' → endpoint 404s → script returns
# exit 0 (gate disabled). This matches the "no runtime surface" contract
# of Phase A. Later phases activate the eligibility enforcement.

set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER not set}"
: "${HEAD_SHA:?HEAD_SHA not set}"

INSTAR_PORT="${INSTAR_PORT:-4042}"
AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
if [[ -z "$AUTH_TOKEN" && -r .instar/config.json ]]; then
  AUTH_TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.instar/config.json','utf-8')).authToken||'')" 2>/dev/null || echo '')"
fi

URL="http://localhost:${INSTAR_PORT}/pr-gate/status?pr=${PR_NUMBER}&sha=${HEAD_SHA}"

attempt=0
max_attempts=3
response=''
http_code=''
while (( attempt < max_attempts )); do
  set +e
  response="$(curl -sS -m 10 -w '\n__HTTP_CODE__:%{http_code}' \
    ${AUTH_TOKEN:+-H "Authorization: Bearer $AUTH_TOKEN"} \
    "$URL" 2>/dev/null)"
  rc=$?
  set -e
  if (( rc == 0 )); then
    http_code="$(printf '%s' "$response" | awk -F: '/__HTTP_CODE__:/ {print $2}')"
    response="$(printf '%s' "$response" | sed '/__HTTP_CODE__:/d')"
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if (( attempt >= max_attempts )); then
  echo "push-gate: gate unreachable after $max_attempts attempts — pending, not pass" >&2
  exit 2
fi

case "$http_code" in
  200)
    eligible="$(printf '%s' "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).eligible===true?'yes':'no')}catch{console.log('no')}})" 2>/dev/null || echo 'no')"
    if [[ "$eligible" == 'yes' ]]; then
      echo "push-gate: eligible (PR #${PR_NUMBER} sha ${HEAD_SHA:0:8})"
      exit 0
    else
      reason="$(printf '%s' "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).reason||'unspecified')}catch{console.log('unparseable')}})" 2>/dev/null || echo 'unparseable')"
      echo "push-gate: BLOCKED (PR #${PR_NUMBER} sha ${HEAD_SHA:0:8}): $reason" >&2
      exit 1
    fi
    ;;
  404)
    # Phase A semantics: endpoint not registered, gate disabled.
    echo "push-gate: gate disabled (prGate.phase=off), allowing push"
    exit 0
    ;;
  *)
    echo "push-gate: unexpected HTTP $http_code — pending, not pass" >&2
    exit 2
    ;;
esac
