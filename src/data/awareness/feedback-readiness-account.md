---
title: Feedback readiness serving account
---
Feedback readiness calls can run on one chosen subscription account. Set `feedbackFactory.readiness.account` to a pool account id (for example a Codex account with weekly room) and readiness uses exactly that account after a fresh live quota check below 75%, or refuses with a named reason (`pinned-account-missing`, `pinned-account-saturated`, `pinned-account-unverified`, `pinned-account-quota-unreadable`). It never falls back to the shared default. Without a pin, readiness follows `feedbackFactory.triage.accountSelectionMode`: `off` keeps the shared provider, `observe` only records the account it would pick, `on` uses the least-used verified account. The setting is read live, so no restart is needed.

Before resuming readiness after an account change, confirm the serving account:

```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/feedback-factory/drain/status | jq .readinessAccount
```

`last.state` is `served` (with `accountId` and `verified`), `shared`, or `refused` (with `reason`). A refusal only defers the waiting groups to the next review; it never pauses or demotes the readiness approval.
