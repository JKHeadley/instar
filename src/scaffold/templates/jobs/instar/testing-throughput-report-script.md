---
name: Testing Throughput Report (Script)
description: Calculate testing throughput and save a plain-text report without launching a model.
schedule: "25 */2 * * *"
priority: medium
expectedDurationMinutes: 2
model: haiku
enabled: false
toolAllowlist: ["Bash"]
unrestrictedTools: false
mcpAccess: none
runner: script
script: testing-throughput-report-script.mjs
scriptTimeoutMinutes: 2
supervision: tier0
scriptSupervision: deterministic
---
Calculate testing throughput from the local verification journal and save a plain-text report. This job is disabled on install. Enable it only on an agent with the baseline report, and coordinate the change with the existing Testing Throughput Report schedule so only one report runs.
