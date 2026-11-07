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

Check for overdue commitments: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/evolution/actions/overdue

For each overdue action:
1. Assess: Can this be completed now? Is it still relevant?
2. If actionable, attempt to complete it or advance it
3. If no longer relevant, cancel it: curl -s -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/evolution/actions/ACT-XXX -H 'Content-Type: application/json' -d '{"status":"cancelled","resolution":"No longer relevant because..."}'
4. If blocked, escalate to the user via Telegram (if configured)

Also check pending actions (curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" "http://localhost:$PORT/evolution/actions?status=pending") for items that have been pending more than 48 hours without a due date — these are forgotten commitments.

Attention row (one per condition, never per run): if anything is overdue, raise or refresh the single item with id "evolution-overdue": curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/attention -H 'Content-Type: application/json' -d '{"id":"evolution-overdue","conditionKey":"evolution-overdue","title":"Evolution actions are overdue","body":"<count> overdue: <ids>","priority":"medium","source":"agent"}'
When the overdue list is EMPTY, close that row instead: curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/attention/clear -H 'Content-Type: application/json' -d '{"conditionKey":"evolution-overdue","resolution":"no evolution actions are overdue"}'

If no overdue or stale items, exit silently (after the clear above).
