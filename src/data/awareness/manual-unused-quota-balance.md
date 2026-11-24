---
title: Balance A Manual Codex Move Against Unused Allowance
---
The existing manual account-swap route can choose a Codex destination from local quota forecasts when an approved move should spread work toward allowance that would otherwise expire unused. Send `POST /subscription-pool/swap` with `{"sessionName":"<tmux name>","exhaustedAccountId":"<current account>","balanceUnusedQuota":true}` and the existing bearer authentication. The server chooses the account and credential home; do not supply an arbitrary target or home.

The explicit option ranks fresh, identity-matched local accounts by their positive weekly forecast gap divided by time to reset and by one plus their running sessions. It serializes these manual moves through refresh settlement, so several simultaneous requests do not all see the same old occupancy. Unknown forecasts refuse the requested balancing mode. Existing session-work and refresh-rate gates still apply; this is not permission to interrupt busy work.

A `manual-balance-settlement-pending` result means a refresh may have happened. Do not blindly retry or remove its state file. The saved intent blocks further balancing until the expected replacement session appears. Reconcile that session through the existing session state before requesting another move. An unreadable saved intent also refuses this mode.

Omitting the option or sending false retains ordinary manual swap behavior. Reactive rescue, proactive swaps, new-session routing and background jobs are unchanged. The scoring is a local placement judgment, not a quota reservation, provider-wide controller or guarantee of savings. Continue to compare actual usage with remaining time and keep the user's approval boundaries.
