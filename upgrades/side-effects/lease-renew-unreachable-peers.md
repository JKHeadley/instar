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

Round 2 (independent review, CHANGES REQUIRED) added two things:

- **Slow valid confirmations are kept.** When the deadline has already answered
  `false` and a peer then confirms the SAME signed renewal, `broadcast()` calls an
  `onLateConfirm` callback once. `LeaseCoordinator.adoptLateRenewal()` installs the
  renewal and re-arms the self-fence only if it is still current: not suspended,
  still our lease at the same epoch, not released, no higher epoch observed or
  reported, and not older (by nonce) than a renewal already installed. A peer that
  always answers in ~10s now keeps the holder serving, as it did before this PR.
- **Verified higher-epoch acks fence.** `interpretResponse()` already verified a
  signed `higher-epoch` ack and then dropped it (also true on the base). The
  transport now keeps a monotonic high-water mark (`higherEpochEvidence()`) and
  starts a best-effort pull of that peer's signed lease through the existing pull
  path. The ack's responder is not assumed to be the holder, and no holder lease
  is fabricated from the ack. `holdsLease()`, `renew()` and the solo-captain hold
  all refuse an epoch below that mark. A later same-epoch ack from another peer
  cannot lower it. It is recorded per response, so it works whether the ack lands
  before, after early success, or after the deadline.

Files: `src/core/HttpLeaseTransport.ts`, `src/core/LeaseCoordinator.ts` (late
adopt + higher-epoch fence), `src/commands/server.ts` (derive the deadline), `tests/helpers/originLeaseDependency.ts` (fixture options), new unit
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

Round 1 of this artifact was wrong here, and the independent review reproduced
it: with the 8s deadline alone, a healthy peer whose genuine ack took 10s had its
confirmation thrown away. The holder suspended after two renewals, while the base
code (which awaited the ack) kept serving. That was a loss of previously working
service, not only the tick giving up on work it could not use.

Round 2 closes it: a confirmation arriving after the deadline, still inside
`requestTimeoutMs`, is adopted through `adoptLateRenewal()`. A peer answering
anywhere in the 5–30s receiver-stall envelope confirms the renewal as before; renew
itself returns within the 8s deadline and serves on grace in between. Tested
directly (four consecutive renewals with 10s signed acks).

New fence: a peer's verified `higher-epoch` ack stops this machine holding its
older epoch. That is correct fencing, not over-block: the peer signed, against our
challenge nonce, that it has folded a higher epoch. If the peer's signed lease is
never pulled (its pull fails every time), this machine stays fenced until its own
lease expires and normal acquisition moves past the reported epoch. It is never
stuck forever.

## 2. Under-block

The monotonic self-fence, epoch CAS, signature checks and the solo-hold gates
are unchanged. `broadcast()` returning early does not change *who* counts as
confirmation. A late adopt cannot revive a suspended holder, a lease this machine
relinquished after sending the renewal (a relinquish generation counter, checked
both on late adopt and on renew's own on-time confirmation), a released lease, or
an epoch that a higher one has superseded (tested: an ack arriving after
suspension, and an ack arriving after `relinquish()`, both leave `holdsLease()`
false).

Still missed, and stated plainly:

- The legacy single-rope path (mesh transport disabled by config; default is on)
  counts any 2xx and reads no ack, so it sees no higher-epoch evidence. That is
  byte-for-byte base behavior.
- Between a higher-epoch ack arriving and nothing else, the fence is immediate
  (it reads the evidence mark directly). But a peer that has NOT answered at all
  gives no evidence, so a partition can still hide a takeover. See section 7.

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
  deadline sits above it. The higher-epoch record happens inside
  `interpretResponse()`, per attempt, so a hedge loser's verified higher-epoch
  answer is still recorded.
- `adoptLateRenewal()` and `renew()` both write `selfIssued`; the nonce check
  makes the later renewal win, so an old late ack never overwrites a newer
  renewal. A solo hold that already installed the same renewal makes the late
  adopt a no-op.
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
`broadcastDeadlineMs` is derived in `server.ts` from existing config, once at
startup. The tick watchdog reads its await live, so lowering the await after
startup can leave the deadline above 40% of it until the next restart (still
bounded by the tick timeout itself). The server.ts comment now says so. Timing
depends on the event loop. Under heavy starvation the 8s timer may fire late,
but the result is still bounded by the tick timeout's own timer.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine lease itself. Every machine runs the same transport.
The holder's renewal is what changes. Peers see renewals sooner and more
steadily. No state is replicated differently.

What this does NOT guarantee: one ack proves contact with one peer, which is the
existing confirmation rule. It is not proof of unique ownership across arbitrary
partitions. The production store is `LocalLeaseStore`, whose CAS is local, not
shared. An ack is one receiver's view, not a globally serialized write, so two
connected groups can hold different views during a partition (the existing
split-brain E2E expects two awake machines during a partition and convergence
after healing). This change neither creates nor closes that substrate limit; it
only stops a dead peer from muting a holder, and makes a verified higher epoch
fence the older holder when a peer does report one.

## 8. Rollback cost

Revert the PR (a hot-fix release). No data, config or migration involved.

## Constitution / standards touched

- **The Agent Is Always Reachable** (STANDARDS-REGISTRY): a dead peer muting
  the agent broke the reachability floor. The fix restores it without weakening
  the split-brain fence.
- **Occam / simplest robust route:** one bounded race replaces `Promise.all`;
  inbound-pull confirmation was dropped (above).
- **Safety floors (no duplicate sends):** round 1 claimed this unconditionally;
  that claim is withdrawn (see section 7). What this change does: it adds no new
  path to authority, keeps every existing fence, and adds one (a verified higher
  epoch fences the older holder at the send gate — integration test: 409, no
  Telegram call). Partition-time double speech remains the substrate's existing,
  unchanged limit.

Instar 2.0 constitution rules the review cited, and how this round meets them:
Rule 15 (reachability): slow peers and dead peers no longer mute the holder.
Rules 31 / 77 (no lost working service): the 10s-ack regression is fixed and
tested across renewals. Rules 1 / 63 (safety floors): the higher-epoch fence
feeds the existing authority (`holdsLease`) and the send gate refuses. Rules 34 /
70 / 108 / 111 (evidence, checking the foundation): the negative tests now run
real signed acks over the production mesh path, the base-code gap is named, and
the overclaim is corrected. Rule 116 (Occam): one callback and one high-water
number; no new protocol, quorum or config.

## Architecture evidence

The charter names `node scripts/check-architecture.mjs`. That script belongs to
Instar 2.0 and does not exist in this 1.x tree (running it gives
`MODULE_NOT_FOUND`), so it cannot pass or fail here. The 1.x tree's architecture
enforcement is `npm run lint`: `tsc --noEmit` plus the architecture lints
(destructive-op funnels, no direct LLM HTTP, sync-subprocess chokepoint, CAS emit
placement, state registry, standards hierarchy, and the rest). On this tree it
exits 0. Whether the 2.0 command applies to a 1.x hotfix needs an operator
decision; this artifact does not claim an exemption.

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

## Second-pass review — round 2

Concern raised: a late ack can revive a lease this machine has just relinquished.
`adoptLateRenewal()` checks suspended, holder, `released`, epoch, higher-epoch
evidence and nonce. None of these sees a local relinquish. `relinquish()` (the
contested tie-break loser, G1 zombie relinquish, and `relinquishAndBroadcast()`,
the silent-standby release) clears `selfIssued` and calls
`store.forceLocalExpiry()`. That leaves the local view as holder = self, same
epoch, `released: false`, expired. It does not install the tombstone locally.
When the pre-relinquish renewal's ack lands after the deadline, every guard
passes, `selfIssued` gets the renewal's fresh expiry, and `holdsLease()` flips
back to true. I reproduced this with the real `HttpLeaseTransport` and
`LeaseCoordinator` (vite-node probe; 100ms deadline, 300ms peer): acquire, then
renew (deadline, grace), then `relinquish()` (holdsLease false), then the late
ack arrives (holdsLease true, holder A). The one-shot latches on silent-standby
and contested relinquish then do not fire again. A non-observe-only machine
(tie-break loser or G1 zombie) keeps renewing from there until a higher epoch
folds over it.

This is parity with the base, not a new regression. The base `renew()` awaiting
`Promise.all` would install the renewal on a confirmation that landed after a
concurrent relinquish, in the same window up to `requestTimeoutMs`. But round 2's
docstring ("A stale ack can never revive superseded ownership") and section 2 of
this artifact ("A late adopt cannot revive ... a released lease") both claim more
than the code does. Smallest repair: add a relinquish generation counter. Bump it
in `relinquish()`, capture it at the start of `renew()`, and have
`adoptLateRenewal()` (and ideally renew's own `confirmed` branch, which closes the
base race too) refuse when it changed. Add a regression test for
relinquish-then-late-ack. Otherwise, correct the two claims.

Verified sound (no change needed):
- `onLateConfirm` fires only after `finish(false)` won (`resolvedFalse` is set
  inside the settled-once `finish`), at most once per broadcast (`lateReported`).
  It never fires after an early true. When all peers settled unconfirmed, no dials
  are left to fire it.
- Ordering against renew(): the nonce guard makes the newest installed renewal
  win. If the adopt ever runs before renew's own continuation, renew then sees a
  fresh `markRenewOk` and returns grace. Harmless either way.
- Suspended / superseded / newer-overwritten: refused (suspended flag; epoch
  equality plus the higher-epoch evidence check; nonce `>=`). After a suspend,
  resuming goes through `acquireIfEligible`, which re-acquires at epoch+1, so a
  late epoch-N ack fails the epoch check.
- `higherEpochEvidence`: a monotonic high-water mark. Same-epoch acks cannot
  lower it. It is read by `holdsLease`, `renew` and `soloCaptainHoldEligible`.
  There is no permanent lockout: renew refuses without suspending, the lease
  expires, and acquisition climbs past it (at worst an epoch climb). The pull
  starts only on a new maximum, has a `.catch`, and the pull path never calls
  `noteHigherEpoch`, so there is no loop and no unhandled rejection. Minor:
  acquisition does not floor its new epoch on the evidence, so with a failed pull
  it can mint the same epoch B holds. That is the existing same-epoch contested
  path, not new.
- Tests are real. The new unit and integration cases use `signLeaseAck` over the
  production `PeerEndpointResolver` mesh path with `meshAckCapable` peers. They
  cover both sides: 10s acks keep serving versus no ack lapses; higher-epoch acks
  fence early, beside a confirming peer, after early success and after the
  deadline; the send gate returns 409 with no wire call versus 200. The lapse
  test's post-suspension ack does arrive (the mock ignores the abort signal), so
  its "never revives" assertion really exercises the suspended guard. Unit 13/13
  and integration 5/5 pass on this tree.
- The other artifact claims (section 7 partition limit, deadline derived once at
  startup, the architecture-evidence disposition) match the code.

— second-pass reviewer subagent, round 2, 2026-09-27

### Builder response to the round-2 concern

Fixed as recommended. `LeaseCoordinator` now has `relinquishGeneration`, bumped in
`relinquish()` (which every relinquish path, including `relinquishAndBroadcast()`,
goes through). `renew()` captures it before the broadcast; if it changed by the
time the broadcast answers, renew returns false without installing, and
`adoptLateRenewal()` refuses too. This also closes the same race on the base code.
Two regression tests: a late ack after `relinquish()`, and an on-time ack for a
renewal in flight across `relinquish()`. Both fail without the counter and pass
with it (unit file 15/15). The docstring now names the relinquish check instead
of the blanket claim.

Concur — concern resolved. `relinquishGeneration` is bumped in `relinquish()`, which every relinquish path goes through. It is captured before the broadcast and checked on both routes that install a renewal: renew's own continuation returns false before the confirmed, solo-hold and grace branches, and `adoptLateRenewal()` refuses first thing. The two new tests cover the late-ack and on-time-ack cases, and they match the revival I reproduced earlier. The unit file passes 15/15. The section-2 claim now matches the code.

— second-pass reviewer subagent, round 2 (follow-up), 2026-09-27

### CI note (round 2)

`no-silent-fallbacks` counted renew()'s pre-existing `.catch(() => false)` once the
round-2 reformat put the new relinquish-guard `return false` inside its 20-line
scan window (496 > 495). A throwing broadcast is an unconfirmed renewal, which is
fail-closed, so the catch now carries an on-line `@silent-fallback-ok` tag. No
behavior change.
