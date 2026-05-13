---
name: Relationship Maintenance
description: Review tracked relationships and surface observations about stale contacts.
schedule: 0 9 * * *
priority: low
expectedDurationMinutes: 3
model: haiku
enabled: true
tags:
  - cat:relationships
  - role:worker
  - exec:prompt
toolAllowlist: "*"
unrestrictedTools: true
---
Review all relationship files in .instar/relationships/. Note anyone you haven't heard from in over 2 weeks who has significance >= 3. If there are observations worth surfacing, report them. If everything looks fine, do nothing.
