# Side-Effects Review — lease renewal no longer waits on an unreachable peer

**Version / slug:** `lease-renew-unreachable-peers`
**Date:** `2026-09-27`
**Author:** `echo`
**Second-pass reviewer:** `required (outbound-messaging authority: the lease gates origin sends)`

## Summary of the change

`HttpLeaseTransport.broadcast()` awaited every peer (`Promise.all`). With one
permanently-unreachable peer (Studio registry: "Mac Mini" `m_4cbc…`, lastSeen
2026-09-15, 3240 consecutive failures), each renewal waited that peer's 30s
rope timeout. The coordinator's `withTickTimeout('lease-renew')` is 20s, so
`server.log` shows `tick-await timeout after 20000ms: lease-renew` on every
renewal, 64 times in one day, while other peers (`m_cc2e…`, `m_e8c9…`) were
confirming. The renewal's confirmation arrived late (≥30s) in the background.
Under event-loop starvation from parallel test runs, it slipped past the 60s
monotonic self-fence. `holdsLease()` went false, and origin `authorize()`
refused sends `destination-not-authorized` for ~30 min.

Fix: `broadcast()` resolves `true` on the first confirming peer, and `false`
when all peers have settled unconfirmed or `broadcastDeadlineMs` (default 8s;
server derives `min(8s, 0.4 × tickWatchdog.awaitTimeoutMs)`) passes. In-flight
dials are not aborted; they still settle on `requestTimeoutMs` and still feed
the resolver's rope health and `lastBroadcastOkAt` (a late confirm keeps
`isReachable()` honest).

Files: `src/core/HttpLeaseTransport.ts`, `src/commands/server.ts` (derive the
deadline), `tests/helpers/originLeaseDependency.ts` (fixture options), new unit
and integration tests.

### Considered and dropped (Occam)

- **Counting a recent authenticated inbound lease pull as confirmation.** The
  logs show the incident did not need it: peers were confirming outbound
  broadcasts, and the dead peer's wait was the whole failure. It would add a new
  confirmation source whose split-brain case differs from the broadcast ack: a
  pull carries no puller epoch, so a peer at a higher epoch would not be
  detected the way `verifyLeaseAck`'s `higher-epoch` verdict detects it. No
  named failure in evidence needs it, so it is not built.
- **Can a "registry online but unreachable on every rope" peer ever count as
  presumed-gone?** Yes. `isPeerPresumedDead` uses router-observed heartbeat
  liveness when the peer has heartbeated this incarnation (it ages out when
  heartbeats stop). Otherwise it falls back to registry `lastSeen` older than
  `failoverThresholdMs` (15 min). The Studio's Mac Mini (lastSeen 12 days old)
  already counts as gone. The one case that never counts as gone is a peer with
  an unparseable/missing `lastSeen` and no heartbeats. That is the documented
  conservative choice in `leaseLiveness.ts`. After this fix it no longer blocks
  renewal when any other peer confirms.

## Decision-point inventory

- `HttpLeaseTransport.broadcast()` returns the renewal-confirmation signal that
  `LeaseCoordinator.renew()` consumes. **Modify:** it is time-bounded and
  returns on the first confirmation. The confirmation *criterion* is unchanged:
  any one peer, a verified epoch-equal ack for ack-capable peers.

---

## 1. Over-block

Less than before. One risk: a peer answering only after 8s is not counted this
round (before, a late answer was counted in the background). With renew every
30s and TTL 60s, the lease lapses only if no peer confirms within 8s on two
consecutive renewals. A peer that slow is at the edge of the 5–40s receiver-stall
envelope noted in the transport. The deadline is 40% of the tick budget, which
itself already abandoned such answers from the tick's point of view.

## 2. Under-block

The monotonic self-fence, epoch CAS, signature checks and the solo-hold gates
are unchanged, so nothing new is let through. `broadcast()` returning early does
not change *who* counts as confirmation.

## 3. Level-of-abstraction fit

The wait-on-all was in the transport, so the bound belongs there. The
coordinator keeps its transport-agnostic confirm/hold/grace decision. The
tick-level `withTickTimeout` stays as the outer backstop.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`: the transport produces a confirmation
signal; the authority (`LeaseCoordinator.renew` + `FencedLease`) is unchanged.
No brittle check gains blocking power. The change removes an accidental block.

## 5. Interactions

- Acquisition, hand-back and tombstone paths also call `broadcast()` (via
  `LeaseCoordinator.broadcast`). There it only marks renew-ok on success, and
  the first-confirm semantics match. The CAS already decided acquisition.
- Hedged multi-rope dialing inside `dialPeer` is unchanged. The overall
  deadline sits above it.
- `leaseRenewing` re-entrancy: renew now finishes inside the tick, so renewals
  no longer overlap (before, a timed-out renew kept running while the next
  began).
- Origin display-authority staleness (`TelegramOriginBoot` `healthy()`: 30s
  snapshot age; a config read over its 2s deadline sets the snapshot to null)
  also refused sends during the incident. That fail-closed is intentional and
  guards config changes. Relaxing it is a separate safety question, tracked with
  a deadline as a follow-up commitment. <!-- tracked: CMT-610 -->

## 6. External surfaces

No wire-format, route or config-schema change. The new option
`broadcastDeadlineMs` is derived in `server.ts` from existing config. Timing
depends on the event loop. Under heavy starvation the 8s timer may fire late,
but the result is still bounded by the tick timeout's own timer.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine lease itself. Every machine runs the same transport.
The holder's renewal is what changes. Peers see renewals sooner and more
steadily. No state is replicated differently.

## 8. Rollback cost

Revert the PR (a hot-fix release). No data, config or migration involved.

## Constitution / standards touched

- **The Agent Is Always Reachable** (STANDARDS-REGISTRY): a dead peer muting
  the agent broke the reachability floor. The fix restores it without weakening
  the split-brain fence.
- **Occam / simplest robust route:** one bounded race replaces `Promise.all`;
  inbound-pull confirmation was dropped (above).
- **Safety floors:** no duplicate sends. Two machines speaking at once stays
  prevented by the unchanged epoch CAS, signatures and self-fence. The tests
  prove the fenced side (409 when a peer is only recently silent).

## Second-pass review

(appended below by the reviewer)

Concur with the review.

- Split-brain: the confirmation criterion is byte-for-byte unchanged. `dialPeer`,
  `interpretResponse` (epoch-equal verified ack for ack-capable peers; legacy 2xx
  otherwise) and `hedge` are untouched. The old `Promise.all` already returned true
  when any one peer confirmed, even if another peer's answer was `higher-epoch`, and
  that verdict was never ingested by `broadcast()` then either. So early resolution
  cannot make a holder keep a lease it would not have kept before. The only new
  outcome is "false at the deadline" where the old code might have said "true late".
  That is fail-closed. `soloCaptainHoldEligible`, the monotonic self-fence and the
  epoch CAS still decide everything after that.
- Promise race: correct. `finish` is idempotent via `settled`. `deadline` is
  assigned before any `.then` can run because `dialPeer` is async, so there is no
  TDZ read. The timer is cleared on every settle path. `.catch(() => {})` sits
  before `.finally`, so there are no unhandled rejections. `pending` decrements
  exactly once per peer. The zero-peer case returns before the Promise.
- Other callers: acquire, hand-back, tombstone and relinquish go through
  `LeaseCoordinator.broadcast`, which only calls `markRenewOk` on true. The CAS
  already decided those paths, and the dials still run to completion in the
  background, so delivery to peers is unchanged.
- Artifact claims check out against the code, including the `leaseRenewing`
  overlap note: `withTickTimeout` rejects but does not cancel, so `finally` used to
  clear the guard while the old renew was still running.
- Tests: I ran both new files and all 10 pass. Against the old `Promise.all` code,
  the unit test "first confirming peer while another hangs" would wait out the 30s
  rope. Both sides of the fence are proven: presumed-gone means hold and 200;
  recently alive means lapse and 409.
- Minor, non-blocking: (a) the tests only use the legacy 2xx dial. No test has a
  fast mesh peer answering `higher-epoch` next to a hung peer. That path's code is
  unchanged, so this is a coverage gap, not a defect. (b) `server.ts` computes
  `broadcastDeadlineMs` once at construction. `tickWatchdogCfg.awaitTimeoutMs` is
  read live, so if someone hot-lowers the tick await below ~20s, the 8s deadline
  can exceed 40% of it until restart. It is still bounded by the tick timeout.
  (c) The 8s deadline timer is not `unref()`'d. It is always cleared, so this is
  harmless.

— second-pass reviewer subagent, 2026-09-27
