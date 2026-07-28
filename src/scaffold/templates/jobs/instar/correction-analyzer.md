---
name: Correction & Preference Learning Analyzer
description: "Weekly scan of the correction ledger for recurring corrections + preferences. Runs the 3-pronged restart-proof recurrence gate, routes each crossing learning (explicit-preference → preferences write the session-start hook injects; infra-gap → a human-approved /feedback proposal; policy-relaxation → Attention for one-tap approval), and runs the closed-loop verify step. Off by default; turns on with monitoring.correctionLearning.enabled. Tier-1 supervised (this haiku job wraps the deterministic /corrections/analyze endpoint and sanity-checks each routed learning against its evidence). SIGNAL-ONLY — never blocks or rewrites a message. Spec docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md sections 3.5, 3.6, 3.7."
schedule: "0 9 * * 3"
priority: medium
expectedDurationMinutes: 2
model: haiku
enabled: false
tags:
  - cat:learning
  - correction-learning
  - audit
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the weekly Correction & Preference Learning analysis. This job exists because a correction the user makes in three different sessions over a week looks like three unrelated one-offs — the recurring ones, the ones that matter most, are exactly the ones no single session can see. This turns the accumulated, distilled record into a routed lesson, and closes the loop on the preference path.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

The job:

1. Confirm the feature is on. If `monitoring.correctionLearning.enabled` is not true, exit silently — there is nothing to do.

2. Call the analyzer + closed-loop tick:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/corrections/analyze`
   The response is `{ analysis: { considered, crossed, belowThreshold }, routed: { total, toFeedback, toPreferences, toAttention }, verified }`. The endpoint does the deterministic work: it only routes a learning that crosses the THREE-PRONGED recurrence gate (minSupport AND distinct calendar days AND a second orthogonal prong), keying on a code-determined provenance weight so an injected prompt cannot steer it. An explicit preference is written to the preferences file the session-start hook injects on every boot; an infra-gap becomes a human-approved tracked draft (or, only if autoFeedback is on, a /feedback proposal through the real route guards); a policy-relaxation learning is routed to the Attention queue for your one-tap approval — never silently applied. It can NEVER mint a proposal or edit a memory file (by-construction authority guard).

3. **Tier-1 supervision (your job).** For each routed learning, sanity-check it against its own evidence before you surface it: does the summary actually match a recurring correction, and does the support count justify acting on it? If a routed learning looks malformed or unsupported, do NOT surface it — note it and move on. You are the validation wrapper around the deterministic core.

4. Surface ONLY genuinely-new, decision-bearing learnings, and ONLY when `monitoring.correctionLearning.telegramDigest` is true. Post ONE consolidated, plain-English message to the existing system topic — never a new per-feature topic, never a ping per correction. Lead with what was learned: "I noticed you keep asking me to lead with the one action across a few sessions, so I have saved that as a preference I will follow from now on." If telegramDigest is false (the default), stay silent — the /corrections read surface is the pull surface; do not push.

5. If `verified` is greater than zero, the verify step concluded on one or more past learnings. A preference is marked verified only when it did not recur within its window AND the saved preference is still on disk (silence alone is never treated as success). Mention a verified-effective result only if you are already surfacing other learnings this run.

IMPORTANT: This is a guardian job, not a doer. It distills, records, and routes — it NEVER blocks or rewrites a message, and it NEVER changes the agent's policy or edits a memory file on its own. A policy-relaxation learning always goes to a human, never gets auto-applied. Plain English, under 600 characters, write like you are texting a teammate about a pattern you noticed.
