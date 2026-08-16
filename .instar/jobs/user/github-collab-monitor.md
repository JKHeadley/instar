---
name: GitHub Collaboration Monitor
description: Scan and review GitHub PRs, forks, and collaboration activity. Stage 1 (Haiku) classifies activity, Stage 2 (Opus) reviews items needing attention.
schedule: 0 8,20 * * *
priority: medium
expectedDurationMinutes: 15
model: haiku
enabled: true
tags:
  - cat:development
  - role:worker
  - exec:prompt
  - pair:github-collab-review
gate: gh auth status 2>/dev/null | grep -q 'Logged in' && ! test -f .instar/github-monitor-paused
toolAllowlist:
  - Read
---
Read and follow the instructions in .instar/prompts/github-monitor-stage1.md — this is a GitHub activity scan job. Execute all steps in order. If no new activity is found, exit silently after updating the handoff note.
