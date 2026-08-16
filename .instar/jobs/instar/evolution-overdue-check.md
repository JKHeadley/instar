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
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" http://localhost:${INSTAR_PORT:-4042}/evolution/actions/overdue 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('overdue',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
---
Check for overdue commitments: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/actions/overdue

For each overdue action:
1. Assess: Can this be completed now? Is it still relevant?
2. If actionable, attempt to complete it or advance it
3. If no longer relevant, cancel it: curl -s -X PATCH http://localhost:${INSTAR_PORT:-4042}/evolution/actions/ACT-XXX -H 'Content-Type: application/json' -d '{"status":"cancelled","resolution":"No longer relevant because..."}'
4. If blocked, escalate to the user via Telegram (if configured)

Also check pending actions (curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/actions?status=pending) for items that have been pending more than 48 hours without a due date — these are forgotten commitments.

If no overdue or stale items, exit silently.
