---
name: Feedback-Factory Triage
description: "Cadenced feedback triage. POST /feedback-factory/triage/tick lets the registered frontier-model triage authority decide work, hold or ignore for feedback work items within deterministic floors, brings held items back on their timers or new reports, and keeps the self-heal ladder and ignore-rate brake going. Development-agent live; fleet dark; inert until the operator approves the triage authority. Spec: docs/specs/feedback-triage-and-execution.md."
schedule: "*/15 * * * *"
priority: low
expectedDurationMinutes: 3
model: haiku
supervision: tier1
enabled: true
tags:
  - cat:feedback-factory
  - role:worker
  - exec:prompt
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/feedback-factory/triage/summary >/dev/null 2>&1"
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run one feedback triage tick. This is a near-silent operated cadence — do NOT message the user. The server owns every decision; this job only triggers one bounded run and records an honest outcome.

Run the command below ONCE, exactly as written, in a single Bash call with `timeout: 240000`. Do not rewrite it, split it, or re-type it as shell code.

```bash
python3 - <<'FEEDBACK_TRIAGE_TICK'
import json, os, sys, time, urllib.error, urllib.request

def config():
    try:
        with open('.instar/config.json') as fh:
            return json.load(fh)
    except Exception:
        return {}

CONFIG = config()
TOKEN = os.environ.get('INSTAR_AUTH_TOKEN') or (CONFIG.get('authToken') if isinstance(CONFIG.get('authToken'), str) else '')
AGENT_ID = os.environ.get('INSTAR_AGENT_ID') or str(CONFIG.get('projectName') or '')
BASE = 'http://localhost:' + str(os.environ.get('INSTAR_PORT') or CONFIG.get('port') or 4042)
POLL_SECONDS = 150
# These outcomes belong to the server's own self-heal ladder or brakes; they are not a failed run.
SELF_MANAGED = ('authority-', 'quota-', 'call-cap-reached', 'triage-output-unusable', 'triage-time-exhausted-rest-due', 'no-intelligence-provider')

def fail(reason):
    path = os.environ.get('INSTAR_JOB_FAILURE_FILE')
    if path:
        with open(path, 'w') as fh:
            fh.write(reason[:480])
    print('FEEDBACK_TRIAGE_RESULT failed: ' + reason)
    sys.exit(0)

def done(message):
    print('FEEDBACK_TRIAGE_RESULT ' + message)
    sys.exit(0)

def call(method, route, extra=None):
    headers = {'Authorization': 'Bearer ' + TOKEN, 'X-Instar-AgentId': AGENT_ID}
    headers.update(extra or {})
    request = urllib.request.Request(BASE + route, method=method, headers=headers, data=b'' if method == 'POST' else None)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            code, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, raw = error.code, error.read()
    except Exception as error:
        return None, 'unreachable (' + type(error).__name__ + ')'
    try:
        return code, json.loads(raw.decode('utf8') or 'null')
    except Exception:
        return code, None

code, tick = call('POST', '/feedback-factory/triage/tick', {'X-Instar-Request': '1'})
if code == 503:
    done('dark')
if code == 409:
    owner = tick.get('owner') if isinstance(tick, dict) else None
    done('healthy no-op: ' + str((tick or {}).get('error') if isinstance(tick, dict) else 'conflict') + (' (owner ' + str(owner) + ')' if owner else ''))
if code == 429:
    done('rate-limited; the next cadence runs it')
if code != 202 or not isinstance(tick, dict) or not tick.get('runId'):
    fail('triage tick refused: HTTP ' + str(code) + ' ' + str(tick))
run_id = tick['runId']

deadline = time.time() + POLL_SECONDS
last = None
while time.time() < deadline:
    code, summary = call('GET', '/feedback-factory/triage/summary')
    last = (summary or {}).get('lastTick') if isinstance(summary, dict) else None
    if isinstance(last, dict) and last.get('runId') == run_id:
        break
    time.sleep(3)
else:
    fail('triage run ' + run_id + ' still in flight after ' + str(POLL_SECONDS) + ' s')

result = last.get('result')
reason = str(last.get('reason') or '')
if result in ('succeeded', 'no-op'):
    done(str(result) + ' ' + run_id + ' decided=' + str(last.get('decided')) + (' (' + reason + ')' if reason else ''))
if any(reason.startswith(prefix) for prefix in SELF_MANAGED):
    done('degraded, self-managed: ' + reason + ' (run ' + run_id + ')')
fail('triage run ' + str(result) + ': ' + (reason or 'no reason given') + ' (run ' + run_id + ')')
FEEDBACK_TRIAGE_TICK
```

The script prints one `FEEDBACK_TRIAGE_RESULT` line and records a failed run itself through `$INSTAR_JOB_FAILURE_FILE`. Outcomes it enforces:
- HTTP 503 (triage dark on this agent) → silent exit. HTTP 409 (this machine is not the drain owner, or a tick is already running) → healthy no-op. HTTP 429 → the next cadence runs it.
- Terminal `succeeded` / `no-op` → success. A `degraded` run whose reason belongs to the server's own self-heal ladder, quota pause, call cap or authority approval state → success (the server reports and escalates those itself). Any other degraded run, or a run still in flight after 150 s → failed run.

Never retry in the same run. Then exit silently. Do NOT relay anything to Telegram and do NOT summarize.
