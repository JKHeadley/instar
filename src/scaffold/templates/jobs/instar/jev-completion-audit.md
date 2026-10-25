---
name: Jev Job-Completion Audit Batch
description: "Batch pass of the observe-only Jev job-completion audit (spec: jev-job-supervision.md). Runs POST /jev-audit/batch: the endpoint sweeps evidence-pack retention, then audits captured completion packs against Jev (suspicious first, then priority, then uniform seeded sampling) under the dailyCallCap budget, writing verdict rows that decide NOTHING. Ships enabled:false and the endpoint is additionally inert unless intelligence.jevJobCompletionAudit is enabled with a future soakEndsAt and a vault typesafe_api_key. NEVER messages the user. completionAudit: excluded — the auditor never audits itself."
schedule: "0 */6 * * *"
priority: low
expectedDurationMinutes: 3
model: haiku
supervision: tier1
completionAudit: excluded
enabled: false
tags:
  - cat:observability
  - jev
  - role:worker
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
perMachineIndependent: true
---
Run one batch pass of the Jev job-completion audit. This is a mechanical, near-silent cadence job — do NOT message the user (the audit is observe-only; it writes verdict rows, never messages, and never interprets its own verdicts — interpretation belongs to the soak report).

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

1. Trigger one batch pass:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "Content-Type: application/json" -d '{}' http://localhost:$PORT/jev-audit/batch`
   A 503 means the audit is not constructed on this agent — exit silently, nothing to do. On 200 the response is `{ audited, skipped, retentionRemoved }`; a `skipped.disabled` or `skipped.soak-expired` count means the feature is dark or outside its soak window — also exit silently, that is the shipped state.

2. **Tier-1 supervision (your job).** Sanity-check the response shape: `audited` a number ≥ 0, `skipped` an object. If the curl fails or the shape is malformed, note it once and exit — do NOT retry-flood; the next 6-hourly tick re-attempts and the endpoint is idempotent (packs with a verdict row are never re-audited).

3. Exit silently. No Telegram, no summaries, no acting on verdicts.
