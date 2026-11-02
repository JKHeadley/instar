---
name: Evolution Overdue Check
description: Monitor overdue evolution actions and stale commitments. Report only — no autonomous completing or cancelling.
schedule: 0 */4 * * *
priority: high
expectedDurationMinutes: 2
model: haiku
enabled: true
tags:
  - cat:learning
  - role:worker
  - exec:prompt
  - pair:commitment-detection
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/evolution/actions/overdue 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('overdue',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

Report only. Do not complete, cancel or edit any action, and do not message the user: this job keeps ONE dashboard row current, and the agent works the actions themselves in its normal sessions.

Check for overdue actions: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/evolution/actions/overdue

Also count pending actions (curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" "http://localhost:$PORT/evolution/actions?status=pending") that have been pending more than 48 hours without a due date — these are forgotten commitments.

Attention row (one per condition, never per run): if anything is overdue, raise or refresh the single item with id "evolution-overdue". Write the body in exactly this shape and nothing else: "<count> overdue, <stale> pending over 48h". The source is this job's name, never "agent": a scheduled job's row stays on the dashboard and is held back from the user's Attention topic.
curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/attention -H 'Content-Type: application/json' -d '{"id":"evolution-overdue","conditionKey":"evolution-overdue","title":"Evolution actions are overdue","body":"<count> overdue, <stale> pending over 48h","priority":"medium","source":"evolution-overdue-check"}'
When the overdue list is EMPTY, close that row instead: curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/attention/clear -H 'Content-Type: application/json' -d '{"conditionKey":"evolution-overdue","resolution":"no evolution actions are overdue"}'

If no overdue or stale items, exit silently (after the clear above).
