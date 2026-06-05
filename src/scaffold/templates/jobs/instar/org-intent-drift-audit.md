---
name: ORG-INTENT Drift Audit
description: Weekly check that samples your recent Coherence Gate review history and surfaces accumulated drift against your organizational intent file. Off by default — only useful for agents that have authored an `.instar/ORG-INTENT.md` and want a periodic heads-up when reviewer block rates trend up. Phase 4 of the ORG-INTENT runtime project.
schedule: "0 10 * * 1"
priority: medium
expectedDurationMinutes: 2
model: haiku
enabled: false
tags:
  - cat:learning
  - audit
  - org-intent
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run a weekly drift audit against your organizational intent. This job exists because the per-message Coherence Gate from Phase 1 catches individual constraint violations, but it can't catch the slow accumulation of borderline-passing messages that collectively drift from intent. That's the Klarna failure mode — every individual review passes the gate's threshold, but the agent has gradually optimized for the wrong objective.

The job:

1. Verify the prerequisites. The drift audit only makes sense when `.instar/ORG-INTENT.md` is present AND the Coherence Gate has accumulated at least 5 review entries in the last 7 days. If either condition isn't met, send a short Telegram message saying so and exit — there's nothing to audit yet.

2. Set auth context: `AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"; AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"; PORT="${INSTAR_PORT:-4042}"`

3. Call the drift digest endpoint: `curl -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" "http://localhost:$PORT/intent/org/drift?lookbackDays=7"`. The response is a structured analysis: overall block rate, per-reviewer breakdown, half-window trend comparison (first half vs second half block rate), cross-reference against ORG-INTENT constraints / goals / values, and a single `trend` label (`stable` | `rising` | `concerning` | `insufficient-data` | `no-org-intent`).

4. If `trend === 'stable'` or `trend === 'insufficient-data'` or `trend === 'no-org-intent'`, stay silent. Most weeks should be silent — that means the agent is staying aligned with the organizational intent. The `shouldSurface` field in the response will be `false` in these cases.

5. If `trend === 'rising'` or `trend === 'concerning'`, surface the drift via Telegram. The response includes a `summary` field (plain-English one-paragraph framing) and a `suggestions` array (specific next actions). Compose a conversational message that leads with the trend and what changed: "Block rate climbed from 4% to 12% in the second half of the week — most flags came from value-alignment." Then list the most-flagged reviewer dimensions. Then surface the top 1-2 suggestions. Keep it under 600 characters. Plain English. No raw JSON.

6. After surfacing (or not), the audit is done. No state to persist — the gate's own review history is the canonical store.

IMPORTANT: This is a guardian job, not a doer. Surface the drift and where it might be coming from. Don't try to fix it autonomously. The fix work — if any — is a deliberate update to `.instar/ORG-INTENT.md` constraints, or a configuration change to the gate, or an operator-level decision about whether the agent's behavior is actually drifting or whether the constraints need updating. Surface; don't fix.

If `trend === 'concerning'`, the message should be slightly more urgent in tone — "Worth a look this week" instead of "Heads up on the weekly check-in." But still conversational, still under 600 characters, still suggestion-heavy rather than panic-heavy.

Plain English. Write like you're texting a teammate about something you noticed in last week's data. The user reads these on their phone.
