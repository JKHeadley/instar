---
name: Overseer Activity Report (Script)
description: Summarize monitoring, maintenance and learning runs, failures and skips without launching a model.
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
Save local activity counts for guardian, maintenance and learning jobs. Keep the existing reviews for interpreting findings, coverage and schedules. This activity report starts disabled.
