---
name: Insight Harvest
description: Synthesize learnings from the learning registry, detect patterns, and generate evolution proposals from high-confidence insights.
schedule: 0 */8 * * *
priority: low
expectedDurationMinutes: 3
model: opus
enabled: true
tags:
  - cat:learning
  - evolution
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/evolution/learnings?applied=false 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('learnings',[])) > 0 else 1)\""
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Harvest and synthesize learnings: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/learnings?applied=false

Review unapplied learnings and look for:
1. **Patterns**: Multiple learnings pointing to the same conclusion
2. **Actionable insights**: Learnings that suggest a specific change
3. **Cross-domain connections**: Insights from one area that apply to another

For each actionable pattern found, create an evolution proposal:
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/proposals -H 'Content-Type: application/json' -d '{"title":"...","source":"insight-harvest from LRN-XXX","description":"...","type":"...","impact":"...","effort":"..."}'

Then mark the relevant learnings as applied:
curl -s -X PATCH http://localhost:${INSTAR_PORT:-4042}/evolution/learnings/LRN-XXX/apply -H 'Content-Type: application/json' -d '{"appliedTo":"EVO-XXX"}'

Also update MEMORY.md with any patterns worth preserving long-term.

If no actionable patterns found, exit silently.
