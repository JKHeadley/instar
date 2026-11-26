---
title: Routine Sol Account Preference
---
New headless Sol helpers and Sol source reviews can use an expiring ordered account preference without moving running conversations. It is off unless explicitly configured in `subscriptionPool.routineCodexPlacement`, for example `{"enabled":true,"accountIds":["codex-amrch","codex-sagemindai"],"expiresAt":"2026-11-25T06:38:10Z"}`. Use an operator-approved expiry for the current window; never renew it automatically.

The preference tries only the named accounts, in order, with fresh valid quota and a usable local login home. If neither qualifies, the new work is refused rather than sent to a default account. Jobs, resumed sessions, explicit account pins, local models, interactive topics and already-running sessions retain their existing behavior. Native collaboration helpers outside Instar are not controlled by this feature.

Read the same account placement used by a Sol source review with `curl -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" "http://localhost:{{port}}/subscription-pool/routine-codex-placement?model=gpt-6.2-sol"`. The read starts no model. A selected response names a local home and its evidence expiry; it is not permission to reuse an old choice. Shipped source-review launchers carry the policy, enforce the selected subscription and model, and recheck the account and home at the child boundary.

When the near-reset account is on course to run out too early, propose an expiring preference for suitable new work on the next eligible accounts. Keep busy sessions running and compare measured usage with remaining time. Removing/disabling the block or reaching expiry restores ordinary placement for future work; a choice that changes during launch preparation is refused. No default activation or new schedule is installed by an update.
