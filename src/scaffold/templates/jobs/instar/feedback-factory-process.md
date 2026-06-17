---
name: Feedback-Factory Processor
description: "Cadenced clustering pass over the canonical feedback-factory store. Runs the already-parity'd processUnprocessed pipeline via POST /feedback-factory/process: it reads unprocessed fleet reports, groups them into dedup clusters (similarity/Jaccard), auto-reopens a cluster on a possible-regression merge, and flips each processed item unprocessed→processing. Appends LOCAL JSONL only — no external action, no force-close of a curated cluster. Dev-gated dark (feedbackFactory.processing): LIVE on a development agent, the route 503s on the fleet so this job exits silently. Tier-1 supervised (this haiku job wraps the deterministic endpoint and sanity-checks the pass result against the post-pass stats). Spec docs/specs/feedback-factory-migration.md §191 (the wiring that makes the ported processor not dead code)."
schedule: "*/30 * * * *"
priority: low
expectedDurationMinutes: 2
model: haiku
supervision: tier1
enabled: false
tags:
  - cat:feedback-factory
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run one feedback-factory clustering pass. This is a mechanical, near-silent watchdog — do NOT message the user. It exists because the canonical store ingests new fleet reports continuously, but nothing clusters/triages them without a production trigger; this job IS that trigger on a cadence.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

1. Confirm the capability is live. Read the stats first:
   `curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/feedback-factory/stats`
   A 503 means the feature is dark for this agent (`feedbackFactory.processing` gated off) — exit silently, there is nothing to do. On 200 the body is `{ total, byStatus, clusterCount, dispatchCount, lastWriteAt }`. Note `byStatus.unprocessed` — that is the work in front of this pass.

2. Trigger one clustering pass:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/feedback-factory/process`
   The response is `{ processed, metrics: { captured, created, merged, reopened }, stats: { total, byStatus, clusterCount, dispatchCount, lastWriteAt } }`. The endpoint does the deterministic work: it reads unprocessed items + active clusters, decides merge/create per item (parity'd logic), auto-reopens on a possible-regression merge, and marks each item processed. It appends LOCAL JSONL only — it takes no external action and never force-closes a curated cluster.

3. **Tier-1 supervision (your job).** Sanity-check the pass against its own stats before concluding: `processed` should equal the number of items that were `unprocessed` going in (step 1's `byStatus.unprocessed`), and the post-pass `stats.byStatus.unprocessed` should have dropped by `processed`. `created + merged` from `metrics` should account for the processed items. If the numbers are internally inconsistent (e.g. `processed > 0` but `unprocessed` did not drop), do NOT retry-flood — note it once and exit; the next tick re-attempts.

4. Exit silently. This job is just the cadence — it produces dedup-cluster signals, not user messages. Do NOT relay anything to Telegram and do NOT summarize. If a curl fails, that failure is itself recorded server-side; do not retry-flood.
