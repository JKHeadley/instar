---
name: LLM-Decision Grading Pass
description: "Hourly deterministic grading pass over the LLM-decision quality substrate. Runs POST /decision-quality/grade-pass: the endpoint walks NEW outcome evidence since the durable per-decision-point cursor (keyset (ts, correlation_id) — same-ms bursts cannot skip rows), applies the registered deterministic evidence rules, and upserts right/wrong/unknown grades idempotently (re-runs converge, never multiply; bounded per pass by provenance.quality.maxDecisionsPerPass). ZERO LLM spend in the pass itself — the grading ladder in this build is deterministic-only (FD11; the LLM evidence-interpreter rung ships NO code, ACT-1198). Ships enabled:false (cost-bearing job class); the operator read surface is GET /decision-quality. NEVER messages the user (FD5 — the meter is observe-only; grading produces rows, not messages). Runs per machine over that machine's local rows (the ratified machine-local data posture). Tier-1 supervised (this haiku job wraps the deterministic endpoint and sanity-checks the response shape). Spec docs/specs/llm-decision-quality-meter.md §5.5."
schedule: "0 * * * *"
priority: low
expectedDurationMinutes: 2
model: haiku
supervision: tier1
enabled: false
tags:
  - cat:observability
  - decision-quality
  - role:worker
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
perMachineIndependent: true
---
Run one deterministic LLM-decision grading pass. This is a mechanical, near-silent cadence job — do NOT message the user (FD5: the quality meter is observe-only; grading writes grade rows, never messages, and never interprets the grades — interpretation belongs to the operator's read of GET /decision-quality). It exists because outcome evidence accrues continuously, but nothing grades it without a production trigger; this job IS that trigger on the hourly cadence the evidence windows are derived from.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

1. Trigger one grading pass:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "Content-Type: application/json" -d '{}' http://localhost:$PORT/decision-quality/grade-pass`
   The body is `{}` on purpose — every knob (pass bound, evidence windows, retention) comes from config, never from this job. A 503 means the quality substrate is dark for this agent (`provenance.uniformSeam` resolves off) — exit silently, there is nothing to do. On 200 the response is `{ graded, byRule, cursors }` where `cursors` maps decisionPoint → the advanced boundary. The endpoint does ALL the deterministic work: durable-cursor keyset walk, bounded per pass, idempotent grade upserts, P19 backoff on a stuck rule.

2. **Tier-1 supervision (your job).** Sanity-check the response shape before concluding: `graded` should be a number ≥ 0, `byRule` an object, and `cursors` an object (possibly empty — an idle pass is healthy, not an error). If the response is malformed or the curl fails, do NOT retry-flood — note it once and exit; the next hourly tick re-attempts, and re-runs converge by the endpoint's idempotency.

3. Exit silently. This job is just the cadence — it produces grade rows, not user messages. Do NOT relay anything to Telegram, do NOT summarize, and do NOT interpret or act on the grades yourself.
