---
name: Framework-Onboarding Mentor
description: Heartbeat that drives one mentor tick — Stage A (drive the mentee as the user, blind to internals), leak check, Stage B forensics, and ledger capture. Off by default; the actual loop, budget gate, and safe-window check live in-process behind POST /mentor/tick (mentor.enabled=false until promoted). Phase §19.4 of FRAMEWORK-ONBOARDING-MENTOR-SPEC.md.
schedule: "*/15 * * * *"
priority: low
expectedDurationMinutes: 1
model: haiku
enabled: false
tags:
  - cat:learning
  - mentor
  - framework-integration
toolAllowlist: "*"
unrestrictedTools: true
---
Run one mentor heartbeat by POSTing to the local mentor endpoint, then stop.

This job is a thin trigger — all the real logic (the leak-detector canary, the fail-closed budget
gate, the durable safe-window check, the Stage-A spawn with an empty tool grant, the leak detector,
Stage-B forensics, and the ledger capture) runs IN-PROCESS inside the server, not in this session.
That keeps the structural two-hats enforcement in code, not in this prompt.

Do exactly this:

1. Resolve auth context:
   `AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"; AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"; PORT="${INSTAR_PORT:-4042}"`

2. POST to `http://localhost:${PORT}/mentor/tick` with the bearer token:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:${PORT}/mentor/tick`

3. Read the JSON result. It will be one of:
   - `{"ran":false,"reason":"disabled"}` — the mentor is off (the default). Nothing to do; stop.
   - `{"ran":false,"reason":"budget"|"unsafe-window"|"canary-failed"}` — it correctly skipped this
     tick. Stop; the next heartbeat will try again.
   - `{"ran":true,...}` — a mentor tick ran. Note `leakDetected` and `observationsWritten` briefly,
     then stop.

4. Do NOT do any mentoring work yourself in this session, do NOT read the mentee's logs or code,
   and do NOT send the mentee any message — the in-process tick owns all of that. You are only the
   timer that pokes it. Then exit.

This job is OFF by default. Enable it (and set `mentor.mode` to `dry-run`, then `live`, in
`.instar/config.json`) only when you want continuous framework-onboarding mentoring — the
graduated-rollout track drives that promotion with your sign-off at each step.
