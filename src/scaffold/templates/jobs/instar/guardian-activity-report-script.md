---
name: Guardian Activity Report (Script)
description: Summarize monitoring-job runs, failures and skips without launching a model.
schedule: "0 */6 * * *"
priority: low
expectedDurationMinutes: 2
model: haiku
enabled: false
toolAllowlist: ["Bash"]
unrestrictedTools: false
mcpAccess: none
runner: script
script: guardian-activity-report-script.mjs
scriptTimeoutMinutes: 2
supervision: tier0
scriptSupervision: deterministic
---
Read the guardian category's run and skip counts and save a local activity report. Keep the existing guardian review for interpreting findings, coverage and schedules. This activity report starts disabled.
