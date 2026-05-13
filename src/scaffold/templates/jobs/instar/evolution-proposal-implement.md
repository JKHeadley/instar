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
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=approved 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('proposals',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
---
Implement approved evolution proposals: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=approved

For each approved proposal:
1. Read the full description and understand what needs to be built
2. Implement it: create the skill/hook/job/config change described
3. After implementation, mark complete: curl -s -X PATCH http://localhost:${INSTAR_PORT:-4042}/evolution/proposals/EVO-XXX -H 'Content-Type: application/json' -d '{"status":"implemented","resolution":"What was done"}'

If no approved proposals exist, exit silently.
