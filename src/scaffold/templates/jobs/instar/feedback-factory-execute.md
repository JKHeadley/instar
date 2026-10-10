---
name: Feedback-Factory Execute
description: "Cadenced feedback executor. POST /feedback-factory/execute/tick reconciles running fix attempts (confined build sessions), drives executor pull requests through the review gate (merge only at the exact head the repository owner approved), follows merged fixes through release and 30 quiet days, and — within admission limits — starts new confined attempts on the top-ranked work items. Development-agent live; fleet dark; dry-run until feedbackFactory.execute.dryRun is false. Spec: docs/specs/feedback-triage-and-execution.md §4."
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
gate: "curl -sf -H \"Authorization: Bearer $INSTAR_AUTH_TOKEN\" -H \"X-Instar-AgentId: $INSTAR_AGENT_ID\" http://localhost:${INSTAR_PORT:-4042}/feedback-factory/triage/summary >/dev/null 2>&1"
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Trigger one feedback executor tick. This is a near-silent operated cadence — do NOT message the user. The server owns every decision; this job only triggers one bounded run and records an honest outcome.

Run the command below ONCE, exactly as written, in a single Bash call with `timeout: 60000`. Do not rewrite it, split it, or re-type it as shell code.

```bash
python3 - <<'FEEDBACK_EXECUTE_TICK'
import json, os, sys, urllib.error, urllib.request

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

def fail(reason):
    path = os.environ.get('INSTAR_JOB_FAILURE_FILE')
    if path:
        with open(path, 'w') as fh:
            fh.write(reason[:480])
    print('FEEDBACK_EXECUTE_RESULT failed: ' + reason)
    sys.exit(0)

def done(message):
    print('FEEDBACK_EXECUTE_RESULT ' + message)
    sys.exit(0)

headers = {'Authorization': 'Bearer ' + TOKEN, 'X-Instar-AgentId': AGENT_ID, 'X-Instar-Request': '1'}
request = urllib.request.Request(BASE + '/feedback-factory/execute/tick', method='POST', headers=headers, data=b'')
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        code, raw = response.status, response.read()
except urllib.error.HTTPError as error:
    code, raw = error.code, error.read()
except Exception as error:
    fail('server unreachable (' + type(error).__name__ + ')')
try:
    body = json.loads(raw.decode('utf8') or 'null')
except Exception:
    body = None
if code == 503:
    reason = body.get('reason') if isinstance(body, dict) else None
    done('not running here: ' + str(reason or 'dark'))
if code == 409:
    owner = body.get('owner') if isinstance(body, dict) else None
    done('healthy no-op: ' + str((body or {}).get('error') if isinstance(body, dict) else 'conflict') + (' (owner ' + str(owner) + ')' if owner else ''))
if code == 429:
    done('rate-limited; the next cadence runs it')
if code == 202 and isinstance(body, dict) and body.get('runId'):
    done('accepted ' + str(body['runId']))
fail('execute tick refused: HTTP ' + str(code) + ' ' + str(body))
FEEDBACK_EXECUTE_TICK
```

The script prints one `FEEDBACK_EXECUTE_RESULT` line and records a failed run itself through `$INSTAR_JOB_FAILURE_FILE`. Outcomes it enforces:
- HTTP 503 → the executor is dark here, has no source checkout, is disabled (it still disarms any armed pull request on the way), or refuses to run because the approver is not independent of this agent or the repository disallows auto-merge → silent exit. The executor's own status and the operator's action list carry those reasons.
- HTTP 409 (not the drain owner, or a tick already running) → healthy no-op. HTTP 429 → the next cadence runs it.
- HTTP 202 → the run proceeds in the background on the server (a fix attempt can take hours); the server records its own outcome.

Never retry in the same run. Then exit silently. Do NOT relay anything to Telegram and do NOT summarize.
