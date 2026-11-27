---
title: "A standby waits for the lease before it polls"
slug: "lease-poll-boot-hold"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/lease-poll-boot-hold.eli16.md"
review-convergence: "2026-11-04T22:12:49.000Z"
review-iterations: 3
review-completed-at: "2026-11-04T22:12:49.000Z"
review-report: "docs/specs/reports/lease-poll-boot-hold-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first)"
---

# A standby waits for the lease before it polls

## Problem statement

`docs/specs/multimachine-lease-poll-robustness.md` decided that an absent `telegramPolling` defers to the lease and that
polling never starts blind. The lifeline's boot path does neither: it starts polling straight away, and the first reconcile
stops it afterwards. So a standby takes the poll slot on every start. The one way to prevent that, `telegramPolling:false`,
is a force-mute, which also blocks starting after a takeover. A pair cannot have a standby that is quiet at boot and starts
when promoted, which step 3 of docs/specs/session-pool-default-on.md needs. <!-- tracked: topic 137054 -->

## Proposed design

When `pollFollowsLease` is live (enabled and `dryRun:false`) and neither `telegramPolling:false` nor a `pollOverride` is
set, boot does not poll. The existing 15-second reconcile decides from the server's poll intent.

- With an intent the normal decision applies: standby holds, awake starts after the existing debounce. The hold ends only
  when a poll has really started or the lease says standby, so an intent that then disappears still reaches the bound.
- With no intent for 3 minutes the lifeline polls anyway. A single machine has no lease and writes no intent, and a server
  that never came up writes none either; holding forever would be silence. This is the only blind start, and it is the same
  start every boot makes today, only later.

Starting has to be safe, because a held boot now always uses the start path that promotion used. The flush before a start
can take a minute, longer than a reconcile, so:

- only one start can be pending;
- a start is cancelled when the lease says standby, the poll is stopped or the token is refused, and intent is read again
  after the flush, unless `force-poll` is set, which outranks the lease as it always has;
- only the newest poll loop continues, and a retired loop's errors are ignored, so a stop followed by a start cannot leave
  two running or let the old one reclaim the slot.

Cost: a holder restarting its lifeline starts polling about 35 seconds later than today. Telegram keeps the updates.

## Decision points touched

- **Boot poll:** invariant over local config and a local file. It cannot block anything past the bound.

## Multi-machine posture

Machine-local. Each lifeline reads its own config and its own server's intent.

## Rollout

Off for everyone: `pollFollowsLease.dryRun` defaults to true, and that is the only way in. No config default changes, so no
migration.

## Testing

Unit: every gate and each step of the hold, both sides of the bound, and the real `reconcilePolling` driven with a
controlled intent, clock and flush for each race above. Wiring: the real start path and reconcile use the
decision. Live: the power-off drill must show the standby not polling before the outage and polling after it.

## Rollback

Set `pollFollowsLease.dryRun:true`, or revert. No state depends on it.

## Open questions

None.
