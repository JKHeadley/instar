---
name: Health Check
description: Monitor server health, session status, and system resources.
schedule: "*/5 * * * *"
priority: critical
expectedDurationMinutes: 1
model: haiku
enabled: true
tags:
  - cat:guardian
toolAllowlist: "*"
unrestrictedTools: true
---
Run a quick health check: verify the instar server is responding (curl http://localhost:${INSTAR_PORT:-4042}/health), check disk space (df -h), and report any issues. Only send a message if something needs attention — silence means healthy. IMPORTANT: If you find issues, describe them in plain conversational language. Never dump raw JSON, field names, error codes, or structured data. The user reads these on their phone — write like you're texting them a quick heads-up. If the health response includes a degradationSummary array, relay those narrative strings directly.
