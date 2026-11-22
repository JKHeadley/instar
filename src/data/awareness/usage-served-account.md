---
title: Spend by the account that actually ran it
---
The usage ledger records, for each request, which subscription account actually served it, read from the folder the transcript was written in and the recorded sign-in checks, never from the session's label alone. When asked "which account did this week's work come from?", "did a session run on a different account than it was tagged with?" or "how much work is one percent of an account's week?", read it first (dev-gated: `503 served-account-off` when dark):

```
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/usage/accounts"
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/usage/account-mismatches?limit=50"
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/usage/accounts/size?account=ACCOUNT_ID"
```

Unidentified spend is shown apart and never credited to a login. A Codex mismatch is unconfirmed (Codex sign-ins are not checked) and is never a placement bug on its own. Cost per point is a workload-dependent lower bound, or "cannot-tell" with the reason; never quote it as an account's capacity.
