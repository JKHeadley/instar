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

1. Read the operated drain's posture:
   `curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/feedback-factory/drain/status`
   Rule on the JSON body's `posture.state`, whatever the HTTP code (a 503 body carries `posture` too). Read `developmentAgent` from `.instar/config.json`.
   - `live` → go to step 2.
   - `dark` → exit silently. The drain is switched off on purpose (fleet default, or an operator switch-off).
   - `unavailable` → FAIL THE RUN with reason `drain posture unavailable: <posture.reason>`.
   - Anything else — no JSON, no `posture` field, connection refused, 401, 403, any other code → if `developmentAgent` is true, FAIL THE RUN with reason `drain status unreadable: HTTP <code or unreachable>`; otherwise exit silently.

   To FAIL THE RUN, run exactly this (with the reason filled in), then stop and finish normally — do not retry, do not tick:
   `[ -n "$INSTAR_JOB_FAILURE_FILE" ] && printf '%s' "<reason>" > "$INSTAR_JOB_FAILURE_FILE"`
   The scheduler reads that file when this run ends and records the run as failed with the reason. Saying "failed" in your output does NOT record a failure; only the file does.

2. Trigger one bounded drain tick:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H "X-Instar-Request: 1" -H "X-Instar-Request-Nonce: $NONCE" http://localhost:$PORT/feedback-factory/drain/tick`
   A 202 response reports `{ runId, accepted, reason? }`. Concurrent triggers return the active run rather than starting a second writer. Poll the status route, bounded to 90 seconds, until `lastRun.runId` matches and `lastRun.state` is no longer `accepted` or `running`; never start a second tick while polling.

3. **Tier-1 supervision.** Accept terminal `succeeded` and `no-op`. A `degraded` run must carry a nonempty reason; a `degraded` run without one → FAIL THE RUN (step 1 command) with reason `degraded run without reason: <runId>`. Never retry in the same run; the durable queue and next cadence own retry. In simulation, canonical claimed/completed counts must not advance. In live mode, completed may never exceed the durable claimed/linked history or the configured batch bound. A broken invariant → FAIL THE RUN with reason `invariant broken: <which>`. A poll that ends at 90 seconds with the run still `accepted`/`running` is not a failure; the next cadence observes it.

4. Exit silently. Do NOT relay anything to Telegram and do NOT summarize. The drain's durable run row, metrics, and bounded self-heal/attention path own observability; a declared failure reaches the operator through the scheduler's consecutive-failure alert.
