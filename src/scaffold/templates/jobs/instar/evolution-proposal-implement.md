---
name: Evolution Proposal Implement
description: "Phase B: Pick up approved evolution proposals and implement them with full context. Paired with evolution-proposal-evaluate."
schedule: 0 1,7,13,19 * * *
priority: medium
expectedDurationMinutes: 10
model: opus
enabled: true
tags:
  - cat:learning
  - role:worker
  - exec:prompt
  - pair:evolution-proposal-evaluate
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=approved 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('proposals',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
---
AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

Implement approved evolution proposals: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" "http://localhost:$PORT/evolution/proposals?status=approved"

For each approved proposal:
1. Read the full description and understand what needs to be built
2. Implement it: create the skill/hook/job/config change described
3. After implementation, mark complete: curl -s -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/evolution/proposals/EVO-XXX -H 'Content-Type: application/json' -d '{"status":"implemented","resolution":"What was done"}'

If no approved proposals exist, exit silently.
