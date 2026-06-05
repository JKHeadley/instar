---
name: Failure-Learning Analyzer
description: "Weekly scan of the failure ledger for dev-process patterns. Discovers support-and-diversity-thresholded insights, opens human-approved tracked improvements (never auto-implements), and runs the verify step on past fixes. Off by default; turns on with monitoring.failureLearning.enabled. Tier-1 supervised (this haiku job wraps the deterministic /failures/analyze endpoint and validates each surfaced insight against its evidence before posting). Spec docs/specs/FAILURE-LEARNING-LOOP-SPEC.md sections 4.4 and 4.6.1."
schedule: "0 9 * * 3"
priority: medium
expectedDurationMinutes: 2
model: haiku
enabled: false
tags:
  - cat:learning
  - failure-learning
  - audit
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the weekly Failure-Learning analysis. This job exists because individual failures get fixed and forgotten — this turns the accumulated, attributed record into process-level insight, and closes the loop all the way to a human-approved fix and a verification that the fix worked.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

The job:

1. Confirm the feature is on. If `monitoring.failureLearning.enabled` is not true, exit silently — there is nothing to do.

2. Call the analyzer + closed-loop tick:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/failures/analyze`
   The response is `{ analysis: { insightsDiscovered, clustersConsidered, clustersBelowThreshold }, actedOn, verified }`. The endpoint does the deterministic work: it only surfaces a pattern that crosses the support + source-diversity gate (so a single noisy session or a flaky test can never manufacture one), opens a tracked Evolution Action + a draft Initiative for each genuinely-new insight (it can NEVER change the process itself — a human approves), and runs the verify step on past fixes whose window has elapsed.

3. **Tier-1 supervision (your job).** For each insight in `analysis.insightsDiscovered`, sanity-check it against its own evidence before you surface it: does the recommendation actually match the category and the supporting-failure count? If an insight looks malformed or unsupported, do NOT surface it — note it and move on. You are the validation wrapper around the deterministic core.

4. Surface ONLY genuinely-new, decision-bearing insights, and ONLY when `monitoring.failureLearning.insightTelegramEscalation` is true. Post ONE consolidated, plain-English message to the existing system topic — never a new per-feature topic, never a ping per failure. Lead with the pattern and the recommended process change: "We've now seen 5 concurrency failures across 4 different changes — they cluster in work that skipped a concurrency review. Recommend adding a concurrency checklist to the adversarial pass. I've opened a draft for your approval." If `insightTelegramEscalation` is false (the default), stay silent — the Process Health view is the pull surface; do not push.

5. If `verified` > 0, the verify step concluded on one or more past fixes. These update the Process Health board silently (effective / ineffective / inconclusive). Mention a verified-effective result only if you're already surfacing other insights this run — "and the convergence-checklist change from last month looks like it worked: that failure class dropped." Never claim causation — it's correlational.

IMPORTANT: This is a guardian job, not a doer. It surfaces patterns and opens human-approved drafts. It NEVER changes a skill, a spec, or the process on its own — that's a deliberate human decision after reading the evidence. Plain English, under 600 characters, write like you're texting a teammate about a pattern you noticed in the data.
