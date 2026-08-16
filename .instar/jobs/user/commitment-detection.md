---
name: Commitment Detection
description: Scan recent messages for promises and commitments, register them as evolution actions. Replaces CommitmentSentinel server process.
schedule: "*/15 * * * *"
priority: high
expectedDurationMinutes: 1
model: haiku
enabled: true
tags:
  - cat:evolution
  - role:worker
  - exec:prompt
  - pair:evolution-overdue-check
gate: curl -sf http://localhost:4042/health >/dev/null 2>&1
toolAllowlist:
  - Read
---
[NOTIFICATION PROTOCOL: This job runs in quiet mode. The user will NOT see your output unless you explicitly signal something needs attention. If you find something actionable or noteworthy, include "[ATTENTION] reason" on its own line in your output. If everything is routine and healthy, just complete normally — no signal needed, the user won't be bothered.]

[VIEW METADATA]
When creating private views (POST /view), include metadata to link the report to this job:
  "metadata": { "source": { "type": "job", "id": "commitment-detection" } }
[/VIEW METADATA]

Scan recent messages for commitments and promises.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

1. Read your bookmark: cat .instar/state/commitment-detection-bookmark.json 2>/dev/null || echo '{"lastProcessedId": 0}'
2. Fetch new messages since bookmark from Telegram message log: tail -100 .instar/telegram-messages.jsonl
3. For each new message, check: does it contain a commitment, promise, or action item? Look for patterns like 'I will', 'let me', 'I'll build', 'we should', 'TODO', 'action item', deadlines, etc.
4. For each detected commitment, register it: curl -s -X POST http://localhost:4042/evolution/actions -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"title":"...","source":"commitment-detection","description":"...","dueDate":"..."}'
5. Update bookmark with the last processed message ID.

Only process NEW messages since last bookmark. Exit silently if no new commitments found.

After processing, write a handoff note:
echo "commitment-detection: $(date -u)" > .instar/state/job-handoff-commitment-detection.md
echo "Commitments processed: [COUNT]" >> .instar/state/job-handoff-commitment-detection.md
