---
name: Guardian and Maintenance Activity Report (Script)
description: Summarize monitoring and maintenance runs, failures and skips without launching a model.
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
Save local activity counts for guardian and maintenance jobs. Keep the existing reviews for interpreting findings, coverage and schedules. This activity report starts disabled.
