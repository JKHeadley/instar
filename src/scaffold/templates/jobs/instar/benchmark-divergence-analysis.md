---
name: Benchmark-Divergence Analysis Pass
description: "Cadenced trigger for the Benchmark-Divergence Detector's ANALYZE pass (docs/specs/benchmark-divergence-detector.md FD8/FD12). Runs POST /benchmark-divergence/analyze with {\"trigger\":\"cadence\"}: on the serving-lease holder ONLY, the server re-reads a rolling window of matured days from the per-model quality rollup (never raw rows), pool-collects every machine's aggregates through the FD9 clamps, compares real grade-rates against the mirrored INSTAR-Bench predictions, and idempotently upserts advisory findings. Non-holders answer 409 (nothing to do — the holder's cadence covers the pool); dark agents answer 503. Tier-0 supervision is JUSTIFIED here (FD12): the pass is fully deterministic aggregation + comparison with no LLM step anywhere — there is nothing for a supervisor model to validate that the endpoint's own idempotency and clamps do not already enforce. Ships enabled:false fleet-wide (FD13 — dark fleet, live-in-dryRun on a development agent; the rollout step enables THIS manifest on the development agent so the dryRun soak actually runs on cadence). NEVER messages the user (observe-only: findings are advisory rows behind GET /benchmark-divergence, never messages). Spec docs/specs/benchmark-divergence-detector.md."
schedule: "45 3 * * *"
priority: low
expectedDurationMinutes: 2
supervision: tier0
enabled: false
tags:
  - cat:observability
  - benchmark-divergence
  - role:worker
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Trigger one benchmark-divergence analysis pass. This is a mechanical, near-silent cadence job — do NOT message the user (the detector is observe-only; a pass produces advisory finding rows, never messages, and never interprets them — interpretation belongs to the operator's read of GET /benchmark-divergence).

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

1. Trigger the pass:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "Content-Type: application/json" -d '{"trigger":"cadence"}' http://localhost:$PORT/benchmark-divergence/analyze`
   The body carries ONLY the trigger kind — every knob (window, thresholds, retention) comes from config, never from this job. Expected outcomes, all healthy:
   - `503` — the detector is dark on this agent (`benchmarkDivergence` resolves off). Exit silently; nothing to do.
   - `409 not-lease-holder` — another machine holds the serving lease and its cadence covers the pool. Exit silently; nothing to do.
   - `429 rate-limited` — a pass already ran within the minimum interval. Exit silently; the idempotent next cadence re-attempts.
   - `200` — the pass ran (or was jitter-scheduled: `scheduled:true` with a `delayMs` — the FD8 anti-systematic-exclusion jitter; the server completes it on its own). In dryRun the response reports `wouldUpsert` (zero durable writes); live it reports `findingsUpserted`.

2. Exit silently. Do NOT relay anything to Telegram, do NOT summarize, and do NOT act on any finding yourself — findings are advisory (Signal vs. Authority) and reach the operator through the read surface.
