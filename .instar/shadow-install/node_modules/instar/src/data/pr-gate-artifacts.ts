/**
 * PR-Gate shipped artifacts — PR-REVIEW-HARDENING-SPEC Phase A.
 *
 * These template constants are the source of truth for files shipped
 * by `PostUpdateMigrator.migratePrPipelineArtifacts()` to every agent
 * (or only to JKHeadley/instar for the `.github/` and `docs/` entries).
 *
 * Each shipped artifact carries a companion `*_SHA256` constant. At
 * migration time, the migrator recomputes sha256(content) and asserts
 * equality with the expected hash BEFORE writing to disk. This defends
 * against post-publish tampering of the content string alone: a
 * tamperer would have to modify BOTH constants, and any single-sided
 * modification halts migration with a critical error logged to
 * `security.jsonl` (once wired) and `result.errors`.
 *
 * HOW TO UPDATE A SHIPPED ARTIFACT:
 *   1. Edit the content constant.
 *   2. Recompute its sha256 — e.g., `shasum -a 256 < <(node -e "console.log(require('./dist/data/pr-gate-artifacts.js').ELIGIBILITY_SCHEMA_SQL)")`
 *      or use the helper at tests/unit/pr-gate-artifacts.test.ts which
 *      asserts self-consistency.
 *   3. Paste the new hash into the matching `*_SHA256` constant.
 *   4. Bump the schema version comment below if editing the SQL.
 *   5. The test asserts hash-vs-content agreement as a build gate.
 *
 * During Phase A, the pr-gate endpoints are inert (`prGate.phase = 'off'`
 * — see commit 8). These artifacts ship ahead of endpoint activation so
 * the code paths exist, can be inspected, and can be smoke-tested in
 * Phase B's shadow mode without shipping new files at each phase flip.
 */

// ── eligibility-schema.sql ───────────────────────────────────────────
//
// SQLite schema for .instar/secrets/pr-gate/eligibility.sqlite.
// Spec §Layer 1. Tables: live, archive, revoked-tokens. Indexes per
// spec: (pr-number, head-sha) primary, authorized-by-token-id for
// revocation queries. WAL + NORMAL + busy_timeout + INCREMENTAL vacuum
// set at DB open, not in the schema (PRAGMAs are connection-scoped).
// Schema-version row in a meta table; future migrations bump it.

export const ELIGIBILITY_SCHEMA_SQL = `-- PR-gate eligibility schema — PR-REVIEW-HARDENING-SPEC Phase A.
-- Schema version 1. Do not edit in-place after shipping; bump version
-- and add a migration script instead.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Live eligibility records. Bounded at 10,000 rows (enforced by server,
-- not by schema). Records move to archive on PR close/merge.
CREATE TABLE IF NOT EXISTS live (
  pr_number              INTEGER NOT NULL,
  head_sha               TEXT NOT NULL,
  eligible               INTEGER NOT NULL,                 -- 0 or 1
  reason                 TEXT NOT NULL,                    -- structured reason code
  authorized_by_token_id TEXT NOT NULL,
  proof_bundle_path      TEXT NOT NULL,                    -- relative to upgrades/side-effects/pr/
  proof_bundle_sha256    TEXT NOT NULL,
  push_iteration         INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,                    -- ISO 8601 UTC
  expires_at             TEXT NOT NULL,                    -- ISO 8601 UTC; 24h from created_at
  PRIMARY KEY (pr_number, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_live_token ON live(authorized_by_token_id);
CREATE INDEX IF NOT EXISTS idx_live_expires ON live(expires_at);

-- Archive table — same shape as live plus archival metadata. 90-day
-- retention enforced by server (not schema).
CREATE TABLE IF NOT EXISTS archive (
  pr_number              INTEGER NOT NULL,
  head_sha               TEXT NOT NULL,
  eligible               INTEGER NOT NULL,
  reason                 TEXT NOT NULL,
  authorized_by_token_id TEXT NOT NULL,
  proof_bundle_path      TEXT NOT NULL,
  proof_bundle_sha256    TEXT NOT NULL,
  push_iteration         INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  archived_at            TEXT NOT NULL,
  archive_reason         TEXT NOT NULL,                    -- 'merged', 'closed', 'superseded'
  PRIMARY KEY (pr_number, head_sha, archived_at)
);

CREATE INDEX IF NOT EXISTS idx_archive_pr ON archive(pr_number);
CREATE INDEX IF NOT EXISTS idx_archive_token ON archive(authorized_by_token_id);

-- Revoked token registry. /pr-gate/status JOINs against this for O(1)
-- revocation checks. No full-table UPDATE on token revocation — write
-- token_id here and queries filter.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_id    TEXT PRIMARY KEY,
  revoked_at  TEXT NOT NULL,                               -- ISO 8601 UTC
  reason      TEXT NOT NULL,
  revoked_by  TEXT NOT NULL                                -- 'JKHeadley' or similar admin id
);
`;

export const ELIGIBILITY_SCHEMA_SQL_SHA256 = 'b953475e7a0fdab104c0bb11ae9d4262622c867840fe6ee8d50d1ce56e53225a';

// ── push-gate.sh ─────────────────────────────────────────────────────
//
// Fork-and-fix Layer 2 push-gate. Queries /pr-gate/status for the
// current (pr, head-sha) before any `git push`. During Phase A
// (prGate.phase='off'), /pr-gate/status returns 404 and the script
// treats that as "gate disabled, pass-through". In later phases the
// endpoint returns structured responses.

export const PUSH_GATE_SH = `#!/usr/bin/env bash
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

: "\${PR_NUMBER:?PR_NUMBER not set}"
: "\${HEAD_SHA:?HEAD_SHA not set}"

INSTAR_PORT="\${INSTAR_PORT:-4042}"
AUTH_TOKEN="\${INSTAR_AUTH_TOKEN:-}"
if [[ -z "\$AUTH_TOKEN" && -r .instar/config.json ]]; then
  AUTH_TOKEN="\$(node -e "console.log(JSON.parse(require('fs').readFileSync('.instar/config.json','utf-8')).authToken||'')" 2>/dev/null || echo '')"
fi

URL="http://localhost:\${INSTAR_PORT}/pr-gate/status?pr=\${PR_NUMBER}&sha=\${HEAD_SHA}"

attempt=0
max_attempts=3
response=''
http_code=''
while (( attempt < max_attempts )); do
  set +e
  response="\$(curl -sS -m 10 -w '\\n__HTTP_CODE__:%{http_code}' \\
    \${AUTH_TOKEN:+-H "Authorization: Bearer \$AUTH_TOKEN"} \\
    "\$URL" 2>/dev/null)"
  rc=\$?
  set -e
  if (( rc == 0 )); then
    http_code="\$(printf '%s' "\$response" | awk -F: '/__HTTP_CODE__:/ {print \$2}')"
    response="\$(printf '%s' "\$response" | sed '/__HTTP_CODE__:/d')"
    break
  fi
  attempt=\$((attempt + 1))
  sleep 2
done

if (( attempt >= max_attempts )); then
  echo "push-gate: gate unreachable after \$max_attempts attempts — pending, not pass" >&2
  exit 2
fi

case "\$http_code" in
  200)
    eligible="\$(printf '%s' "\$response" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).eligible===true?'yes':'no')}catch{console.log('no')}})" 2>/dev/null || echo 'no')"
    if [[ "\$eligible" == 'yes' ]]; then
      echo "push-gate: eligible (PR #\${PR_NUMBER} sha \${HEAD_SHA:0:8})"
      exit 0
    else
      reason="\$(printf '%s' "\$response" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).reason||'unspecified')}catch{console.log('unparseable')}})" 2>/dev/null || echo 'unparseable')"
      echo "push-gate: BLOCKED (PR #\${PR_NUMBER} sha \${HEAD_SHA:0:8}): \$reason" >&2
      exit 1
    fi
    ;;
  404)
    # Phase A semantics: endpoint not registered, gate disabled.
    echo "push-gate: gate disabled (prGate.phase=off), allowing push"
    exit 0
    ;;
  *)
    echo "push-gate: unexpected HTTP \$http_code — pending, not pass" >&2
    exit 2
    ;;
esac
`;

export const PUSH_GATE_SH_SHA256 = '3aabc693e1efad43b60342294767d39321381dd4693eb1e72bc249197f480c87';

// ── .github/workflows/instar-pr-gate.yml ─────────────────────────────
//
// Layer 3 — GitHub Action as required status check. Instar-source-only
// (JKHeadley/instar). `pull_request` trigger, no pull_request_target,
// no checkout of PR code execution, narrow permissions. Challenge-
// response flow per spec §Upgrade 5. Actions pinned to commit SHAs
// (not floating tags) to prevent action-poisoning.

export const INSTAR_PR_GATE_WORKFLOW_YML = `# instar-pr-gate — Layer 3 of PR-REVIEW-HARDENING enforcement.
#
# Triggered on pull_request open/sync; queries the primary Echo server's
# /pr-gate/status via challenge-response for current (PR, head-sha) and
# reports the result as a required status check named 'instar-pr-gate'.
#
# Security properties (enforced structurally):
#   - pull_request trigger only (NOT pull_request_target — no repo secrets
#     in fork-PR context outside explicit reads).
#   - No checkout of PR code is ever executed. We only read
#     github.event.pull_request.head.sha.
#   - Workflow-level permissions: {}. Step-level permissions narrowed to
#     what the Echo-API query needs.
#   - Action pins use commit SHAs, not floating tags.
#   - Secret read via env: (never args:). Log output masked.
#
# Phase A: this file ships but Echo's /pr-gate/status endpoint is
# unregistered (prGate.phase='off') — the Action treats 404 as 'pending'
# and does not block merges. Branch protection requiring this check is
# configured in Phase D per docs/pr-gate-setup.md.

name: instar-pr-gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions: {}

jobs:
  gate:
    runs-on: ubuntu-latest
    permissions:
      statuses: write
      pull-requests: read
    steps:
      - name: Query Echo pr-gate (challenge)
        id: challenge
        env:
          PR_GATE_READ_TOKEN: \${{ secrets.PR_GATE_READ_TOKEN }}
          PR_GATE_SERVER_URL: \${{ secrets.PR_GATE_SERVER_URL }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          set -u
          if [ -z "\${PR_GATE_READ_TOKEN:-}" ] || [ -z "\${PR_GATE_SERVER_URL:-}" ]; then
            echo "::warning::PR_GATE_READ_TOKEN or PR_GATE_SERVER_URL not configured — gate pending"
            echo "status=pending" >> "\$GITHUB_OUTPUT"
            exit 0
          fi
          attempt=0
          while [ "\$attempt" -lt 3 ]; do
            set +e
            resp="\$(curl -sS -m 15 -w '\\n__HTTP__:%{http_code}' \\
              -H "Authorization: Bearer \$PR_GATE_READ_TOKEN" \\
              "\$PR_GATE_SERVER_URL/pr-gate/status/challenge?pr=\$PR_NUMBER&sha=\$HEAD_SHA")"
            rc=\$?
            set -e
            if [ "\$rc" -eq 0 ]; then break; fi
            attempt=\$((attempt + 1))
            sleep 20
          done
          if [ "\$attempt" -ge 3 ]; then
            echo "::warning::Echo server unreachable after 3 attempts — gate pending"
            echo "status=pending" >> "\$GITHUB_OUTPUT"
            exit 0
          fi
          http="\$(printf '%s' "\$resp" | awk -F: '/__HTTP__:/ {print \$2}')"
          body="\$(printf '%s' "\$resp" | sed '/__HTTP__:/d')"
          case "\$http" in
            404) echo "::notice::pr-gate endpoint disabled (phase=off) — pending"; echo "status=pending" >> "\$GITHUB_OUTPUT" ;;
            200) echo "status=challenged" >> "\$GITHUB_OUTPUT"; printf '%s' "\$body" > challenge.json ;;
            *)   echo "::warning::Unexpected HTTP \$http — pending"; echo "status=pending" >> "\$GITHUB_OUTPUT" ;;
          esac

      - name: Exit early when pending
        if: steps.challenge.outputs.status != 'challenged'
        run: |
          echo "Gate status: \${{ steps.challenge.outputs.status }}"
`;

export const INSTAR_PR_GATE_WORKFLOW_YML_SHA256 = '07e1caee13720ca3650bdba6f14a837675b5af7382be323ecc402d099ae3616a';

// ── docs/pr-gate-setup.md ────────────────────────────────────────────
//
// Runbook for enabling branch protection with instar-pr-gate as a
// required status check. Only shipped to JKHeadley/instar.

export const PR_GATE_SETUP_MD = `# PR-Gate Setup Runbook

This runbook is for the \`JKHeadley/instar\` source repo only. It walks
through enabling the \`instar-pr-gate\` GitHub status check as a required
check for merges to \`main\`. Ships as part of PR-REVIEW-HARDENING-SPEC
Phase A; the actual enforcement flips on in Phase D.

## Prerequisites

- You have admin rights on \`JKHeadley/instar\`.
- \`gh auth status\` shows you're logged in with a token that can read/write repo settings.
- Echo is paired with this repo as \`prGate.primaryMachineId\` (see \`.instar/config.json\`).

## Step 1 — Verify the workflow file shipped

\`\`\`bash
ls -la .github/workflows/instar-pr-gate.yml
\`\`\`

The file should be present and owned by the repo (not a symlink). If
missing, run \`npx instar update\` to re-run \`PostUpdateMigrator\`.

## Step 2 — Set up repo secrets

Two secrets are required for Layer 3:

\`\`\`bash
gh secret set PR_GATE_READ_TOKEN --body "<from .instar/secrets/pr-gate/tokens.json 'read' field>"
gh secret set PR_GATE_SERVER_URL --body "<https://your-echo-tunnel-url>"
\`\`\`

The tunnel URL must terminate at the \`prGate.primaryMachineId\` Echo
instance. Failover rotation of this secret is documented in the
"Failover" section below.

## Step 3 — Required-check configuration (deferred to Phase D)

Phase A through Phase C: skip this step. The workflow runs in
reporting mode; branch protection is NOT yet required.

Phase D: run the following to require the \`instar-pr-gate\` check on
\`main\`:

\`\`\`bash
gh api \\
  --method PATCH \\
  -H "Accept: application/vnd.github+json" \\
  /repos/JKHeadley/instar/branches/main/protection/required_status_checks \\
  -f strict=true \\
  -F 'contexts[]=instar-pr-gate'
\`\`\`

Verify:

\`\`\`bash
gh api repos/JKHeadley/instar/branches/main/protection | jq '.required_status_checks.contexts'
\`\`\`

Must include \`"instar-pr-gate"\`.

## Step 4 — Programmatic health check

Echo exposes \`/pr-gate/branch-protection-status\` which calls the GitHub
API and reports whether \`instar-pr-gate\` is currently marked required:

\`\`\`bash
curl -H "Authorization: Bearer \$AUTH" http://localhost:4042/pr-gate/branch-protection-status
\`\`\`

Green response = gate is required. Red = gate is running but not
required (intermediate state during Phase C → D transition).

## Failover

If the primary Echo machine is unavailable for extended periods, failover
steps:

1. On the new primary machine, set \`prGate.primaryMachineId\` in
   \`.instar/config.json\` to the new machine-id.
2. Rotate \`PR_GATE_SERVER_URL\` to the new machine's tunnel URL:
   \`\`\`bash
   gh secret set PR_GATE_SERVER_URL --body "<new-tunnel-url>"
   \`\`\`
3. The next PR event will route to the new primary. In-flight records
   that haven't been replicated re-run the pipeline on next push.

## Phase transition checklist

- **Phase A → B**: set \`prGate.phase\` to \`'shadow'\` in
  \`.instar/config.json\`. No user-visible change; endpoints start
  accepting writes but never block.
- **Phase B → C**: set \`prGate.phase\` to \`'layer1-2'\`. Push-gate
  enforces. Action reports but does not require.
- **Phase C → D**: set \`prGate.phase\` to \`'layer3'\`. Complete this
  runbook's Step 3. Action becomes required.

## Kill switch

Set \`prGate.phase\` to \`'off'\` in \`.instar/config.json\`. All
\`/pr-gate/*\` endpoints start returning 404. Any in-flight Action run
will see 404 and set its status to \`pending\` — merges will NOT be
blocked by the gate. This is safe to flip at any time.
`;

export const PR_GATE_SETUP_MD_SHA256 = '6ed0533f23a2fca994e16663391cd4186ecf9e1faff2868e8b07b1776ab93f1c';
