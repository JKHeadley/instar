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
runner: script
script: health-check.mjs
scriptTimeoutMinutes: 1
anomalies:
  - kind: disk-low
    class: recoverable
  - kind: disk-critical
    class: critical
  - kind: sessions-exhausted
    class: recoverable
  - kind: llm-unreliable
    class: recoverable
  - kind: degradation:*
    class: recoverable
supervision: tier0
scriptSupervision: triage
triageEvidence: full
triageFields:
  - disk_free_pct
  - sessions_current
  - sessions_max
  - degradations
  - llm_status
triageBareOk:
  - healthy
triageBareSkipped:
  - feature-dark
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run a quick health check: verify the instar server is responding (curl http://localhost:${INSTAR_PORT:-4042}/health), check disk space (df -h), and report any issues. Only send a message if something needs attention — silence means healthy. IMPORTANT: If you find issues, describe them in plain conversational language. Never dump raw JSON, field names, error codes, or structured data. The user reads these on their phone — write like you're texting them a quick heads-up. If the health response includes a degradationSummary array, relay those narrative strings directly.
