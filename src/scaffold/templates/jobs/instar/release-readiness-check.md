---
name: Release Readiness Check
description: Surface a stalled/blocked instar release (Layer B of release-readiness-visibility). Evaluates canonical main and raises ONE deduped Attention item when finished work sits unreleased too long. Ships OFF — Echo dogfoods first.
schedule: "0 */6 * * *"
priority: low
expectedDurationMinutes: 1
model: haiku
enabled: false
tags:
  - cat:release-hygiene
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the release-readiness check once. This is a mechanical, near-silent watchdog — do NOT message the user.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"

1. Trigger one evaluation tick:
   curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/release-readiness/tick -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID"
2. That endpoint runs the ReleaseReadinessSentinel: it fetches canonical main, checks whether unreleased feature/fix work is piling up while publishing is blocked, and (only above the age threshold) raises a single deduped Attention item. All transitions are written to logs/sentinel-events.jsonl.
3. Exit silently. The sentinel owns all signalling (Attention queue) — this job is just the cadence. Do not relay anything to Telegram; do not summarize. If the curl fails, that is itself recorded by the server; do not retry-flood.
