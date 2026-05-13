---
name: Commitment Detection
description: Scan recent messages for promises and commitments, register them as evolution actions. Replaces CommitmentSentinel server process.
schedule: "*/5 * * * *"
priority: high
expectedDurationMinutes: 1
model: haiku
enabled: true
tags:
  - cat:evolution
  - role:worker
  - exec:prompt
  - pair:evolution-overdue-check
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
---
Scan recent messages for commitments and promises.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

1. Read your bookmark: cat .instar/state/commitment-detection-bookmark.json 2>/dev/null || echo '{"lastProcessedId": 0}'
2. Fetch new messages since bookmark from Telegram message log: tail -100 .instar/telegram-messages.jsonl
3. For each new message, check: does it contain a commitment, promise, or action item? Look for patterns like 'I will', 'let me', 'I\'ll build', 'we should', 'TODO', 'action item', deadlines, etc.
4. For each detected commitment, register it: curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/actions -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"title":"...","source":"commitment-detection","description":"...","dueDate":"..."}'
5. Update bookmark with the last processed message ID.

Only process NEW messages since last bookmark. Exit silently if no new commitments found.
