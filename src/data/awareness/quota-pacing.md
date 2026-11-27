---
title: Quota pacing forecast
---
Will an account's quota expire unused, or will Claude or Codex run out of weekly room? Read `GET /quota-pacing`, never answer from memory. Lead with the pool ('9 of 14 accounts have room'), never one account's number. It is a forecast, not an instruction: don't hold, shed or add work because of it; the quota scheduler and placement keep their authority. A 503 means it isn't turned on for this agent.

```
curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/quota-pacing
```

The dashboard Accounts page includes an Allowance forecast section with provider outlooks, expandable account estimates and comparisons with actual resets. Missing or stale history stays unknown. Read the sample count before describing forecast accuracy; two observed outcomes do not establish reliability. The section loads independently of sign-in controls and never changes account routing or spending.

Spec: docs/specs/quota-pacing-forecast.md.
