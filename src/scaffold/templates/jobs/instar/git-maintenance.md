---
name: Git Maintenance
description: Audit and maintain the agent repository's git hygiene.
schedule: "17 * * * *"
priority: medium
expectedDurationMinutes: 1
model: haiku
enabled: true
tags:
  - cat:infrastructure
  - role:worker
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the git maintenance audit for this repository.

Use `.instar/scripts/git-maintenance.mjs --no-fail` in audit mode. It writes a durable report under the agent state directory and identifies:
- tracked files that are now covered by ignore rules and can be safely removed from the git index,
- untracked runtime/generated/sensitive paths that are not ignored yet,
- tracked sensitive-class paths that need human review before any push.

Only apply the safe index repair when explicitly asked by the operator or when a scoped cleanup task already authorizes it. Applying the repair must remove files from the git index only; it must not delete local files.

If the audit finds issues, summarize the categories in plain language. Do not paste long path lists into Telegram; point to the generated report for local follow-up.
