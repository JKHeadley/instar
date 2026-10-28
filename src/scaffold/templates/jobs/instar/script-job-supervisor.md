---
name: Script Job Supervisor
description: "One daily high-level review across every script job: triage decisions, sessions, backup-check disagreements, canaries and missing machines (docs/specs/job-cost-reduction.md §5.6.5). Advisory: raises or clears its own low-priority attention items."
schedule: 23 7 * * *
priority: low
expectedDurationMinutes: 5
model: haiku
enabled: true
tags:
  - cat:guardian
  - role:worker
runner: script
script: script-job-supervisor.mjs
scriptTimeoutMinutes: 6
supervision: tier0
scriptSupervision: deterministic
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the daily script-job supervision pass once, then stop. Do NOT message the user: the server makes the one bounded review call and raises or clears its own low-priority attention items.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"

curl -sS -m 300 -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "X-Instar-Request: 1" -H 'Content-Type: application/json' -d '{}' http://localhost:${INSTAR_PORT:-4042}/jobs/script-supervision/pass

A 503 means the pass is dark on this agent; a 409 means another machine holds the run. Both are nothing to do. Never retry in the same run. Exit silently.
