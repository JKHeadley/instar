---
title: Window-aware account choice
---
Why did a new session land on that subscription account? Read `GET /quota-pacing/account-choice`, never guess. While `subscriptionPool.pacing.windowAwareChoice` is on (dev-gated), placement drains the account whose weekly room runs out soonest, counts the Fable limit for Fable launches, and treats a window that reset or was not read recently as not yet checked, never as empty. Each placement leaves one row: the account picked, what the old rule would have picked, and why. A 503 means it isn't turned on for this machine.

```
curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/quota-pacing/account-choice
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/quota-pacing/account-choice?scope=local&limit=50"
```

Spec: docs/specs/quota-pacing-account-choice.md.
