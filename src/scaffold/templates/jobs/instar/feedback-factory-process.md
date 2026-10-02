---
name: Feedback-Factory Operating Drain
description: "Cadenced end-to-end feedback drain. POST /feedback-factory/drain/tick clusters canonical input, runs registered frontier-model readiness judgment inside deterministic floors, enqueues one durable outbox row per readiness epoch, and—after separate consumer promotion—creates and reads back one Initiative task. Development-agent processing/drain is live; fleet remains dark; consumer ships simulation-first. Spec: docs/specs/feedback-factory-operating-drain.md."
schedule: "*/30 * * * *"
priority: low
expectedDurationMinutes: 5
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
Run one feedback-factory operating-drain tick. This is a near-silent operated cadence — do NOT message the user. The server owns every transition; this job only triggers one bounded run and records an honest outcome.

Run the command below ONCE, exactly as written, in a single Bash call with `timeout: 300000`. Do not rewrite it, split it, or re-type it as shell code: the script carries every rule of this job, and an improvised shell loop has broken it before (zsh refuses a variable named `status`, and the run was recorded as a success).

```bash
python3 - <<'FEEDBACK_DRAIN_TICK'
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
DEVELOPMENT_AGENT = CONFIG.get('developmentAgent') is True
# A run is capped at 115 s of wall clock; poll past that so a slow run's outcome is still read here.
POLL_SECONDS = float(os.environ.get('FEEDBACK_DRAIN_POLL_SECONDS') or 180)

def fail(reason):
    path = os.environ.get('INSTAR_JOB_FAILURE_FILE')
    if path:
        with open(path, 'w') as fh:
            fh.write(reason[:480])
    print('FEEDBACK_DRAIN_RESULT failed: ' + reason)
    sys.exit(0)

def done(message):
    print('FEEDBACK_DRAIN_RESULT ' + message)
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

def drain_status():
    code, body = call('GET', '/feedback-factory/drain/status')
    posture = body.get('posture') if isinstance(body, dict) else None
    state = posture.get('state') if isinstance(posture, dict) else None
    return code, body, posture, state

def count(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0

def work_counts(body):
    work = ((body or {}).get('drain') or {}).get('work') or {}
    return count(work.get('claimed')) + count(work.get('completed'))

# 1. Posture: the JSON posture decides, whatever the HTTP code.
code, before, posture, state = drain_status()
if state == 'dark':
    done('dark')
if state == 'unavailable':
    fail('drain posture unavailable: ' + str(posture.get('reason') or 'unknown'))
if state != 'live':
    if DEVELOPMENT_AGENT:
        fail('drain status unreadable: HTTP ' + (str(code) if isinstance(code, int) else str(before)))
    done('status unreadable on a fleet agent')

# 2. One bounded tick. A refused tick is a failed run (for example a demoted authority).
nonce = 'feedback-drain-' + str(int(time.time())) + '-' + str(os.getpid())
code, tick = call('POST', '/feedback-factory/drain/tick', {'X-Instar-Request': '1', 'X-Instar-Request-Nonce': nonce})
if code != 202 or not isinstance(tick, dict) or not tick.get('runId'):
    detail = tick.get('error') if isinstance(tick, dict) else tick
    paused = ((before.get('authority') or {}).get('pausedBecause') if isinstance(before, dict) else None)
    fail('drain tick refused: HTTP ' + str(code) + ' ' + str(detail or '') + (' (authority paused: ' + str(paused) + ')' if paused else ''))
run_id = tick['runId']
if tick.get('proxied'):
    done('proxied to the owner machine, run ' + run_id + '; the owner records its outcome')

# 3. Poll this run to a terminal state. Still running past the drain's wall clock is a failed run:
# no later cadence reads this run's outcome (live 2026-10-01: two degraded 70 s runs were recorded
# as successes by a 60 s poll).
deadline = time.time() + POLL_SECONDS
last = None
after = None
while time.time() < deadline:
    code, after, _, _ = drain_status()
    last = (after or {}).get('lastRun') if isinstance(after, dict) else None
    if isinstance(last, dict) and last.get('runId') == run_id and last.get('state') not in ('accepted', 'running'):
        break
    time.sleep(3)
else:
    seen = (str(last.get('runId')) + ' ' + str(last.get('state'))) if isinstance(last, dict) else 'no lastRun (HTTP ' + str(code) + ')'
    fail('drain run ' + run_id + ' still in flight after ' + str(int(POLL_SECONDS)) + ' s, past the drain wall clock (last seen: ' + seen + ')')

# 4. Tier-1 supervision of the terminal run.
run_state = last.get('state')
reason = str(last.get('reason') or '').strip()
if run_state in ('succeeded', 'no-op'):
    if isinstance(after, dict) and after.get('consumerLive') is False and work_counts(after) > work_counts(before):
        fail('invariant broken: claimed/completed work advanced while the consumer is in simulation (run ' + run_id + ')')
    done(run_state + ' ' + run_id)
fail('drain run ' + str(run_state) + ': ' + (reason or 'no reason given') + ' (run ' + run_id + ')')
FEEDBACK_DRAIN_TICK
```

The script prints one `FEEDBACK_DRAIN_RESULT` line. It records a failed run itself by writing the reason to `$INSTAR_JOB_FAILURE_FILE` (the scheduler reads that file when the run ends); saying "failed" in your output does NOT record a failure. Outcomes it enforces:
- Posture `dark` → silent exit. `unavailable` → failed run. Unreadable status → failed run on a development agent, silent exit on the fleet.
- A refused tick (any HTTP code other than 202, e.g. `current registered readiness agent required` after the authority was demoted) → failed run, naming why the authority is paused when the status says.
- A tick proxied to the owner machine → success here; its outcome lives in the owner's run history and status.
- Terminal `succeeded` / `no-op` → success (a `succeeded` run may carry an informational reason such as `readiness-time-exhausted-rest-due`). Still in flight after 180 s → failed run. Terminal `degraded`, `failed` or `abandoned` → failed run carrying the drain's reason.
- In simulation, claimed/completed work counts must not advance; if they do → failed run.

Never retry in the same run; the durable queue and the next cadence own retry. Then exit silently. Do NOT relay anything to Telegram and do NOT summarize. A failed run reaches the operator through the scheduler's consecutive-failure alert.
