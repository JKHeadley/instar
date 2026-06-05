---
name: Identity Review
description: Review identity coherence, check soul.md drift, nudge reflection if identity-relevant learnings have accumulated.
schedule: 0 3 * * *
priority: medium
expectedDurationMinutes: 5
model: opus
enabled: true
tags:
  - cat:identity
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1 && test -f .instar/soul.md
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Identity review — check your identity coherence and growth.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"

1. **Check soul.md drift**: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:${INSTAR_PORT:-4042}/identity/soul/drift
   - If anyAboveThreshold is true, review the divergence. Is this healthy growth or unexpected drift?
   - If drift looks healthy, mark it reviewed: the growth is intentional.
   - If drift looks concerning, flag with [ATTENTION] so the user is notified.

2. **Check pending changes**: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:${INSTAR_PORT:-4042}/identity/soul/pending
   - If pending changes exist, surface them to the user via Telegram (the user should approve/reject these).

3. **Check for identity-relevant learnings**: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:${INSTAR_PORT:-4042}/evolution/learnings?applied=false
   - For each unapplied learning, assess: is this about operational knowledge (how to do something) or about your values, beliefs, or self-understanding?
   - If you find 3+ identity-relevant learnings since your last soul.md update, consider running /reflect.
   - Don't force it — if none of the learnings touch on identity, that's fine. Exit silently.

4. **Check AGENT.md evolution**: Read .instar/AGENT.md
   - Do your principles still match your actual behavior?
   - Is the Self-Observations section populated? If you've noticed behavioral patterns, document them.
   - Update Identity History if you make changes.

5. **Integrity check**: curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:${INSTAR_PORT:-4042}/identity/soul/integrity
   - If integrity fails, flag with [ATTENTION] — soul.md may have been modified outside normal channels.

If everything is coherent and no reflection is needed, exit silently. Only report via [ATTENTION] if drift is concerning, integrity fails, or pending changes need user action.
