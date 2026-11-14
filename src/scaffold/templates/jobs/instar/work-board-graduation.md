---
name: Work Board Graduation
description: "Writes the Work Board pilot's day-7 and day-14 measurement records (docs/specs/work-board-asks.md, Maturation plan). The gate passes only when a record is due, which is twice in the pilot's life, so on every other day (and on every agent where the board is off) no session starts. The server measures from the card store and writes the record; this job fires the pass and reports the counts. It never messages anyone and never judges the result: whether the pilot graduates is the operator's own reading."
schedule: "20 9 * * *"
priority: low
expectedDurationMinutes: 1
model: haiku
enabled: true
catchUpPolicy: run-once
tags:
  - cat:learning
  - work-board
  - role:worker
  - exec:prompt
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/work-board/graduation 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('due',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

Write the Work Board pilot's due measurement record. This is a mechanical job: do not message the user, and do not judge whether the pilot passed.

Fire the pass: curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H 'Content-Type: application/json' http://localhost:$PORT/work-board/graduation/pass -d '{}'

The answer lists `written` (the days whose record was written now) and `due`. If it says `skipped: not-lease-holder`, another machine writes the record; exit. If the call fails or answers an error, report the exact error as this job's result and exit; the next daily run tries again.

Report one line: which days were written. Then exit.
