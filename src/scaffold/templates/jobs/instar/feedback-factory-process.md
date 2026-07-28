---
name: Feedback-Factory Operating Drain
description: "Cadenced end-to-end feedback drain. POST /feedback-factory/drain/tick clusters canonical input, runs registered frontier-model readiness judgment inside deterministic floors, enqueues one durable outbox row per readiness epoch, and—after separate consumer promotion—creates and reads back one Initiative task. Development-agent processing/drain is live; fleet remains dark; consumer ships simulation-first. Spec: docs/specs/feedback-factory-operating-drain.md."
schedule: "*/30 * * * *"
priority: low
expectedDurationMinutes: 2
model: haiku
supervision: tier1
enabled: true
tags:
  - cat:feedback-factory
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run one feedback-factory operating-drain tick. This is a near-silent operated cadence — do NOT message the user. The server owns every transition; this job only triggers and sanity-checks one bounded run.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"
NONCE="feedback-drain-$(date +%s)-$$"

1. Confirm the operated drain is live:
   `curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/feedback-factory/drain/status`
   A 503 is expected only on a fleet-dark install. Read `.instar/config.json`: if `developmentAgent` is not true, exit silently. If it is true, a 503 is degradation—fail this job run so JobRun history and the server audit expose it; never treat it as healthy.

2. Trigger one bounded drain tick:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "X-Instar-Request: 1" -H "X-Instar-Request-Nonce: $NONCE" http://localhost:$PORT/feedback-factory/drain/tick`
   A 202 response reports `{ runId, accepted, reason? }`. Concurrent triggers return the active run rather than starting a second writer. Poll the status route, bounded to 90 seconds, until `lastRun.runId` matches and `lastRun.state` is no longer `accepted` or `running`; never start a second tick while polling.

3. **Tier-1 supervision.** Accept terminal `succeeded` and `no-op`. A `degraded` run must carry a nonempty reason. Never retry in the same run; the durable queue and next cadence own retry. In simulation, canonical claimed/completed counts must not advance. In live mode, completed may never exceed the durable claimed/linked history or the configured batch bound.

4. Exit silently. Do NOT relay anything to Telegram and do NOT summarize. The drain's durable run row, metrics, and bounded self-heal/attention path own observability.
