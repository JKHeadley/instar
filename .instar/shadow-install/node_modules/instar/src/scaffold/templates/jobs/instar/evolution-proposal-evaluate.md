---
name: Evolution Proposal Evaluate
description: "Phase A: Read pending evolution proposals, evaluate their merit, accept or reject. Paired with evolution-proposal-implement."
schedule: 0 */6 * * *
priority: medium
expectedDurationMinutes: 3
model: sonnet
enabled: true
tags:
  - cat:learning
  - role:worker
  - exec:prompt
  - pair:evolution-proposal-implement
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=proposed 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('proposals',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
---
Review pending evolution proposals: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=proposed

For each proposal:
1. Read the title, description, type, and source
2. Evaluate: Is this a genuine improvement? Is the effort worth the impact? Does it align with our goals?
3. If approved, update status: curl -s -X PATCH http://localhost:${INSTAR_PORT:-4042}/evolution/proposals/EVO-XXX -H 'Content-Type: application/json' -d '{"status":"approved"}'
4. If rejected or deferred, update with reason.

Do NOT implement approved proposals — that's handled by the paired evolution-proposal-implement job.

Also check the dashboard: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution — report any highlights to the user if they seem important.

If no proposals need attention, exit silently.
