---
title: "Takeover on a pair with no shared lease medium"
slug: "lease-takeover-no-shared-medium"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/lease-takeover-no-shared-medium.eli16.md"
review-convergence: "2026-11-04T11:45:24.000Z"
review-iterations: 3
review-completed-at: "2026-11-04T11:45:24.000Z"
review-report: "docs/specs/reports/lease-takeover-no-shared-medium-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first; fix named as step 3 in docs/specs/session-pool-default-on.md)"
---

# Takeover on a pair with no shared lease medium

## Problem statement

Topic 136880's test (fb-29bc773f-713): a two-machine agent with no git remote lost its main machine, and
the standby did not take over in 20 minutes. Read in the code, three separate things fail:

1. **The write is misread.** `GitLeaseStore.casWrite` saves the candidate, commits, and the push fails
   because there is nowhere to push. `commitAndPush` returns false, the store re-reads, sees its own
   candidate, and returns `ok:false`. The coordinator logs "CAS lost to epoch N (our candidate N)".
   `selfIssued` and `peerTakeoverAuthorizedEpoch` are never set. The same loop then finds its own candidate
   and calls `renew()`, which self-suspends because the last confirmed renewal dates from boot. This applies
   when `autoPush` is on; with it off, `commitAndPush` returns true after the commit.
2. **A survivor cannot keep the lease.** `renew()` must be confirmed by a broadcast, and a dead peer
   confirms nothing. After `leaseTtlMs` (60 s by default) the machine self-suspends, and the next tick re-acquires
   as `current-lease-expired` at a higher epoch. It serves part of each cycle and the epoch climbs without
   end. `soloCaptainHold` exists for this but is dark, and needs a named preferred machine, which a new
   pair does not have. This one is not specific to git: `LocalLeaseStore` survivors do the same, including
   the main machine when the standby is the one that dies.
3. **Moving the lease does not start serving.** Nothing subscribes to `promote`. A standby's Telegram is
   send-only until `pollFollowsLease` is live, and that is dev-gated and dry-run by default. The scheduler is
   built only on a machine awake at boot. So even a clean takeover answers nobody on a default new pair.

A store swap is the wrong fix (round 3 of the default-on review): it loses the epoch, the boot order and
`instar wakeup`.

## Proposed design

### Change 1: the store tells the truth about a local write

`GitLeaseStore` gains a dep `localCommitIsFinal(): boolean`, true when `soloCaptainHold` is on, no machine
is named preferred, the registry has at least one non-revoked peer, and `git remote` is empty. It is read
only after `commitAndPush` returned false, so the healthy path pays nothing, and read each time, so adding
a remote takes effect without a restart. A read that fails counts as false, which is today's behaviour.

If it is true, and the registry on disk holds exactly this candidate (holder, epoch and nonce), `casWrite`
returns `ok:true`. No other return changes. `refresh` stays as it is: a local write proves nothing about a
peer, which is why renewal goes through the broadcast.

`GitLeaseStore` also gains `forceLocalExpiry`, under the same condition, because `relinquish` relies on it
and only `LocalLeaseStore` had one: a same-epoch tie loser on git would otherwise keep reading as holder.
It keeps the epoch as the floor and commits nothing.

`GitSync.commitAndPush` does not change, because `sync()` reports its boolean as `pushed`.

### Change 2: a holder in an unnamed pool keeps its epoch

`soloCaptainHoldEligible` stays behind `soloCaptainHold.enabled` and the two existing vetoes (no higher
epoch seen, no higher-epoch evidence). One rule is added: **when this machine has at least one non-revoked
peer and no machine is named preferred, the preferred and peers-gone tests do not apply.** A holder that cannot confirm its renewal keeps the same
epoch, and only a higher epoch ends that.

| Pool | Today | New |
|---|---|---|
| Named | as today | unchanged, takeovers included |
| Unnamed, holder cannot confirm | self-suspends, re-acquires, epoch climbs | keeps the same epoch |
| Unnamed, standby sees the lease expire | takes over | takes over, and now keeps it |

This covers the common case: the standby's laptop lid closes and the main machine carries on with no gap. A
new dep `survivorMayHold(): boolean` holds that condition, read live; absent or false is today's behaviour, so
a single machine is untouched.

Review rejected two earlier forms of this rule. Making the main machine wait for peers to be presumed gone
left it dark for about 14 minutes, because that threshold is 15 minutes and the lease 60 seconds, and it could
wedge, because a peer unheard since boot is never presumed gone.

### Change 3: ask before taking back your own lapsed lease

A live holder no longer lapses, so this only happens after a restart or a wake. In an unnamed pool with the
switch on, `acquireIfEligible` pulls from peers once, with a hard 10-second deadline, before re-acquiring its
own lapsed lease. A takeover made meanwhile is then seen rather than tied at the same epoch. If nobody answers
in time, it re-acquires once, and Change 2 keeps it.

### What this does not do

The lease moving is necessary for takeover and not sufficient, per problem 3. Turning takeover on for new
pairs also needs `pollFollowsLease` live and the scheduler started on promotion. Both are named conditions of
step 3 in docs/specs/session-pool-default-on.md <!-- tracked: topic 137054 --> and are built before the switch
changes for anyone. The live drill below runs with `pollFollowsLease` on, and records what the scheduler did.

An agent with no Telegram or app has no renew timer, only a 120 s tick against the 60 s lease, so the hold may
not fire there and its epoch can climb. Nothing is served there, so this costs an epoch number, not a reply.

### What happens in a link cut

On two machines with no third party, a dead peer and a cut link look identical. The options are:

- one side goes dark, which also means going dark when the other side really died; or
- both believe they hold during the cut, and it heals on reconnect.

This spec takes the second, because keeping the agent reachable is the point of a second machine. The usual
cut is one machine losing its network, and that machine cannot reach Telegram, so it serves nobody. If both
have internet, two pollers fight over updates, delivery becomes unpredictable and jobs run on both sides. That
is the real cost, and the live link-cut test measures it.

Healing is clean. The old holder stays at N and the standby is at N+1 from about one lease length into the cut,
so on reconnect N+1 wins through the existing fence, with no tie. A same-epoch tie can still come from a restart
during a cut, or in a pool of three or more from two standbys taking the same expired epoch. Either takes the
existing contested path; `GitLeaseStore.forceLocalExpiry` makes that work on git.

The standard *Cross-Machine Coherence* allows this and bounds it: a partition may produce two machines
believing they hold, never a durable second authority, and believers must converge on heal. It applies only to
unnamed pools with the switch on, at any pool size. A pool that wants the old rule names a preferred machine.

## Decision points touched

- **Hold without confirmation:** invariant with floors. It never advances the epoch; a higher epoch always
  ends it; it requires a named switch.
- **Re-acquire own lapsed lease:** invariant. It adds one read before an unchanged decision.
- **Local write counts as written:** invariant, config fact (no remote) plus a read-back of the exact
  candidate from the registry file. That proves the write persisted, not that a git commit landed; the
  registry file is what every reader uses, so it is the right boundary.

None is a brittle check with authority over messages; they are lease rules inside the existing fence.

## Multi-machine posture

The lease is the coordination layer itself. The store change is machine-local; a mixed pair (one
`LocalLeaseStore`, one `GitLeaseStore`) is the tested case, since 136880's pair was mixed. Peers on an
older build still accept a higher signed epoch through the tunnel.

## Testing

- Unit: `GitLeaseStore` with no remote returns ok only for its exact candidate, with a peer present;
  unreadable remote and no-peer cases stay `ok:false`.
- Unit: every row of the table, and the switch off for all three changes.
- Unit: 30 minutes of ticks with the peer silent leave the epoch flat, on the standby after takeover and on
  the main machine after the standby goes quiet.
- Unit: after a restart a peer's takeover is seen before any re-acquire; with no answer it re-acquires once.
- Unit: heal: survivor at N+1 meets old holder at N; the old holder stops. Same-epoch tie resolves with
  `GitLeaseStore`, and the loser stops reading as holder before the winner's epoch arrives.
- Integration: two real coordinators and real stores on temp git repos with no remote, one stopped.
- E2E: the production wiring in `server.ts` passes the new deps (wiring integrity).
- Single machine: no peers, behaviour byte-identical.
- Live, on a test pair with the switch and `pollFollowsLease` on: a 30-minute power-off with every reply
  delivered and a flat epoch, and a link cut. Link-cut pass: within 2 minutes of reconnect exactly one machine
  holds and polls, no job starts on the other, and a message sent then is answered once. The same with one
  machine restarted during the cut, which exercises the same-epoch path. The standby needs the bot token, since a join-built one cannot answer.

## Maturation plan

- **ladder:** multiMachine.leaseSelfHeal.soloCaptainHold

All three changes sit behind the switch, which stays dark by default, so with it off (tested) no acquisition
or serving behaviour changes.
Turning it on for new pairs is its own change, after the live drill above passes, and is step 3 of
docs/specs/session-pool-default-on.md. The existing ladder entry's `fired` and `error` rows carry the
evidence; a hold that a peer's higher epoch ended is the `error` row it already writes.

## Migration

No new config key and no default change, so nothing to migrate. `instar pair` and `instar join` keep their
printed note until the default flips.

## Rollback

`soloCaptainHold.enabled: false` restores all three, read live.
No data changes shape.

## Open questions

None needing the operator. The link-cut choice above is recorded for review.
