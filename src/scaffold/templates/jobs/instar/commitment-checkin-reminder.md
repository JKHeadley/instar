---
name: Commitment Check-In Reminder
description: "Drives ONE check-in reminder pass (ACT-724; docs/specs/dated-commitment-reminder.md). Calls POST /commitments/check-in-reminder/pass: the server scans open commitments whose `checkInAt` has arrived and posts exactly one fixed-template reminder each to the commitment's own topic. Idempotent — the `checkInReminderSentAt` stamp is written only AFTER a successful send, so a re-run, a retried trigger, or two passes racing cannot double-send, and a failed send is retried (bounded) rather than silently marked delivered. Tier-0 supervision is JUSTIFIED: the pass is a deterministic predicate over durable state plus a fixed-template send — there is no LLM step for a supervisor to validate, and the endpoint's own idempotency and per-pass cap already bound it. Ships enabled:false (dark; the feature itself is dev-agent gated and dryRun-first). This job NEVER authors prose — the reminder text is code-generated and the job's own output is mechanical."
schedule: "*/5 * * * *"
priority: medium
expectedDurationMinutes: 1
supervision: tier0
enabled: false
tags:
  - cat:commitments
  - check-in-reminder
  - role:worker
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Trigger one commitment check-in reminder pass. This is a mechanical cadence job — do NOT message the user yourself. The reminder message is composed and delivered server-side from a fixed template; your job is only to fire the pass and report the counts.

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"

curl -sS -m 60 -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "http://localhost:${PORT}/commitments/check-in-reminder/pass"

Interpreting the response:

- `503 check-in-reminder-not-enabled` — the feature is dark on this agent. Expected on the fleet. Nothing to do, nothing to report.
- `{"ran":true,"dryRun":true,"wouldSend":N}` — soak mode. The pass decided what it WOULD send and sent nothing. Normal during the dark window.
- `{"ran":true,"sent":N}` — N reminders delivered.
- `"gaveUp":N` greater than zero — N reminders are genuinely UNDELIVERED after exhausting retries. This is the one outcome worth surfacing: read `GET /commitments/check-in-reminder` for the `undelivered` list. Those are promises the user did not receive.

Do not retry the pass yourself on a non-zero `failed` count — the next scheduled pass retries automatically, bounded, and the endpoint is idempotent.
