---
name: Rope-Health Digest
description: "Daily one-line mesh rope-health digest (docs/specs/u4-5-rope-health-alerts.md §2). Reads the RopeHealthMonitor's GET /mesh/rope-health surface and, ONLY when something is non-ok, emits at most ONE consolidated section (≤3 sentences, machine-named, content-scrubbed: rope kind + machine nickname + relative times only). Ships enabled:true with a 503-silent body — a DELIBERATE, argued divergence from the feedback-factory-process enabled:false precedent (R-r2-7/R-r3-2): the digest's whole gating already lives in the monitoring.ropeHealth dev-agent gate (dark fleet → the route 503s → this job exits silently at zero cost; live dev agent → the digest flows from day one). Delivery honors monitoring.ropeHealth.digestTopicId (R-r2-8): UNSET → log only, never a send. Tier-1 supervised (this haiku job wraps the deterministic endpoint; the server composes the digest text). Operator note: an agent-home G1 coherence script that audits mesh health should CONSUME GET /mesh/rope-health rather than re-deriving rope state — this monitor is the mechanism; any daily script is a reader."
schedule: "0 9 * * *"
priority: low
expectedDurationMinutes: 2
model: haiku
supervision: tier1
enabled: true
tags:
  - cat:monitoring
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Emit the daily mesh rope-health digest. This is a mechanical, near-silent reporter — when everything is healthy you say NOTHING anywhere.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

1. Read the monitor (the ?digest=1 read records the emission metric):
   `curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" "http://localhost:$PORT/mesh/rope-health?digest=1"`
   - A **503** means the rope-health monitor is dark for this agent (`monitoring.ropeHealth` dev-gated off) — exit silently, there is nothing to do. This is the designed fleet posture, not an error.
   - On 200 the body is `{ lastEvaluatedAt, peers: [...], keyExpiry, digest, counters }`. The `digest` field is the server-composed, content-scrubbed, ≤3-sentence consolidated section — you never compose rope text yourself.

2. If `digest` is `null`: everything is ok. Exit silently — no message, no log noise.

3. If `digest` is non-null, resolve the delivery topic:
   `python3 -c "import json; c=json.load(open('.instar/config.json')); print(c.get('monitoring',{}).get('ropeHealth',{}).get('digestTopicId',''))"`
   - **Empty/unset** (the default): LOG the digest line to stdout (it lands in the job transcript) and exit. Do NOT send it anywhere — the operator has not named a hub topic yet.
   - **Set to a topic id N**: send EXACTLY the digest text (one consolidated section, nothing appended) to that topic:
     `cat <<'EOF' | .instar/scripts/telegram-reply.sh N`
     `<the digest text>`
     `EOF`

4. **Tier-1 supervision (your job).** Sanity-check before sending: the digest must be ≤3 sentences and must NOT contain raw IPs, URLs, tunnel hostnames, tailnet names, or emails (the server scrubs by construction — if you ever see one, do NOT send; note it once in the transcript and exit; the next day's run re-checks). Never retry-flood a failed send; the failure is recorded server-side.

5. Exit silently. Do not summarize, do not message the user beyond the single digest delivery above.
