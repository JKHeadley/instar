---
name: Feedback-Factory Action List
description: "Once-a-day feedback triage action list for the operator. POST /feedback-factory/triage/action-list composes only NEW items that need the operator (the triage authority awaiting approval, serious or multi-report holds that need review, a recommendation to turn ignores live), at most 10 plus a count line, each with a direct link, and sends it to feedbackFactory.execute.actionTopicId or the Attention hub. The server enforces the 23:00–07:30 quiet window and once-per-item delivery. Spec: docs/specs/feedback-triage-and-execution.md §5."
schedule: "0 8 * * *"
priority: low
expectedDurationMinutes: 1
model: haiku
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
Ask the server to send today's feedback triage action list. The server composes and delivers it (or decides there is nothing new); do NOT write or send any message yourself.

Run the command below ONCE, exactly as written, in a single Bash call with `timeout: 60000`.

```bash
python3 - <<'FEEDBACK_ACTION_LIST'
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
request = urllib.request.Request(BASE + '/feedback-factory/triage/action-list', method='POST', data=b'',
    headers={'Authorization': 'Bearer ' + TOKEN, 'X-Instar-AgentId': AGENT_ID, 'X-Instar-Request': '1'})
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        code, body = response.status, json.loads(response.read().decode('utf8') or 'null')
except urllib.error.HTTPError as error:
    code, body = error.code, None
except Exception as error:
    code, body = None, str(type(error).__name__)
if code in (503, 409):
    print('FEEDBACK_ACTION_LIST skipped: HTTP ' + str(code))
    sys.exit(0)
if code != 200 or not isinstance(body, dict):
    path = os.environ.get('INSTAR_JOB_FAILURE_FILE')
    if path:
        with open(path, 'w') as fh:
            fh.write('action list delivery failed: HTTP ' + str(code))
    print('FEEDBACK_ACTION_LIST failed: HTTP ' + str(code))
    sys.exit(0)
print('FEEDBACK_ACTION_LIST ' + ('sent ' + str(body.get('items')) + ' item(s)' if body.get('sent') else 'not sent: ' + str(body.get('reason'))))
FEEDBACK_ACTION_LIST
```

Exit silently after the single result line. Do NOT relay or summarize anything.
