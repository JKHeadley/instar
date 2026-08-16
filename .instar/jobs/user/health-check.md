---
name: Health Check
description: Monitor server health, session status, and system resources.
schedule: "*/15 * * * *"
priority: critical
expectedDurationMinutes: 1
model: haiku
enabled: true
tags:
  - cat:guardian
toolAllowlist:
  - Read
---
[NOTIFICATION PROTOCOL: This job runs in quiet mode. The user will NOT see your output unless you explicitly signal something needs attention. If you find something actionable or noteworthy, include "[ATTENTION] reason" on its own line in your output. If everything is routine and healthy, just complete normally — no signal needed, the user won't be bothered.]

[VIEW METADATA]
When creating private views (POST /view), include metadata to link the report to this job:
  "metadata": { "source": { "type": "job", "id": "health-check" } }
[/VIEW METADATA]

Run a quick health check: verify the instar server is responding (curl http://localhost:4042/health), check disk space (df -h), and report any issues. Only send a message if something needs attention — silence means healthy. IMPORTANT: If you find issues, describe them in plain conversational language. Never dump raw JSON, field names, error codes, or structured data. The user reads these on their phone — write like you're texting them a quick heads-up. If the health response includes a degradationSummary array, relay those narrative strings directly.

After checking, write a handoff note:
echo "health-check: $(date -u)" > .instar/state/job-handoff-health-check.md
echo "Status: [healthy/degraded]" >> .instar/state/job-handoff-health-check.md
