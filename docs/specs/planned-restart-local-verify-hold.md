---
title: "Planned restart waits for an active local verification"
slug: "planned-restart-local-verify-hold"
author: "echo"
status: draft
date: 2026-11-01
parent-spec: "local-verify-merge-authority"
review-convergence: "2026-11-04T17:41:18.410Z"
review-iterations: 3
review-completed-at: "2026-11-04T17:41:18.410Z"
review-report: "docs/specs/reports/planned-restart-local-verify-hold-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli error (cause dropped by wrapper), 3 of 3 rounds"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 1
---

# Planned restart and local verification

## Observed failure

On 2026-11-01, two planned server restarts requested by Telegram repair work
interrupted the same PR #2525 verification at 04:48:26 and 04:57:57 UTC. The
local-verify audit records 302,324 and 480,567 milliseconds of discarded work.
The supervisor log names the requesters and says it initiated both restarts.
AutoUpdater's existing `LocalVerifyService.restartHolds()` protects update
restarts, but other writers of `state/restart-requested.json` do not consult it.
The foreground watcher also consumes that flag and can race the supervisor.

## Decision

Both restart consumers must defer a `plannedRestart: true` request while this
machine has a live local-verify child. The existing durable
`state/local-verify/inflight.json` is the cross-process signal. It is written
before the verifier child starts and cleared on completion. A positive child
PID must still exist; the short pre-spawn marker with a null PID is honored for
30 seconds. A marker or request older than three hours never defers. Unplanned or
emergency restarts are unchanged. The restart flag remains in place while
deferred, and the service starts no new verify while a planned restart waits.

The request's one-hour expiry must not silently lose a planned restart
that waited for verification. When a consumer actually defers the request,
it atomically records a marker keyed to that exact request. Only a matching
deferred request remains deliverable for four hours from `requestedAt`: at most
three hours of hold plus one hour for the supervisor to consume it. The verifier
continues to pause new starts while that exact deferred request is deliverable.
A request that was already expired when the first live verify was observed
cannot gain this proof retroactively. A request
that was never deferred keeps its original one-hour expiry. Older expired
requests retain the existing discard behavior. The foreground watcher already acts on expired requests. This
bound prevents an old file from restarting the server days later. The hold
never certifies a partially completed verification; if the three-hour bound
is reached, restart proceeds and the existing interruption
and retry accounting applies.
An explicit `forceRestart` request records `bypassHolds: true` on the flag;
the cross-process guard honors that existing operator override. The updater
also sets it when its own four-hour hold ceiling is reached, avoiding an
accidental second three-hour deferral. The verifier still pauses new starts
while that request waits to be consumed.

## Safety and verification

- Unit: active child, completed child, null-PID startup, stale/invalid marker,
  expired request, and unplanned request; supervisor and foreground consumers.
- Integration: an active service writes the marker, a planned request remains
  pending, the service pauses the next verify, then the request is consumed
  after the run ends.
- E2E: production wiring with an isolated server and a real child verifies the
  request is not consumed during the run and is consumed after completion.

No configuration or agent-installed file changes. The deferred-request proof
is a small machine-local sidecar file; its key is replaced by the next deferred
request and an unmatched key has no effect. The behavior reaches existing
agents through the package update. Rollback is a code revert.

## Amendment (2026-11-03): accepted peer verifications

### Observed failure

A planned restart of the coordinating machine discards every peer
verification it has handed out. On restart the coordinator re-acquires its
serving lease under a new epoch, and `pollPeers()` abandons each reservation
bound to the old epoch (`lease-changed`) and cancels it on the peer. The hold
above reads only `inflight.json`, which describes the local child, so it never
sees these runs. The local-verify audit for 2026-10-27 to 2026-11-02 shows 54
such abandons and 443 peer-minutes of discarded work, each within about 90
seconds of the coordinator's own lease re-acquire. Each abandon also spends one
of the entry's two remote attempts, so a PR hit twice falls back to the
congested local lane. On 2026-11-03 PR #2620 lost both remote attempts to two
restarts four minutes apart (00:14:55Z, 8.7 min of work; 00:18:28Z, 3.5 min).
From 2026-11-03T17:35Z to 2026-11-04T17:00Z, eight abandons (77.8
peer-minutes) followed a coordinator server start. Four more (31.4
peer-minutes) followed a `lease-lost` with no server start; that same-holder
lapse is a separate cause that this amendment does not address.

### Decision

**Signal written by the owner of the evidence.** Only the verifier process
knows whether a reservation is still worth waiting for: it holds the current
lease epoch and each peer's last poll result. The restart consumers run in
other processes and can read only files. So the verifier publishes a small
heartbeat, `state/local-verify/peer-hold.json`:

```json
{ "v": 1, "writtenAt": 1793813182276, "leaseEpoch": 23346,
  "attempts": [{ "attemptId": "...", "pr": 2736, "sentAt": 1793813182276, "lastPollOkAt": 1793813242276 }] }
```

The verifier rewrites it atomically (temporary file, then rename, as
`persistQueue()` does) on every `tick()` while at least one qualifying attempt
exists, whether or not a restart is pending, and removes it when none remains.
It is written at the start of every `tick()`, after
`notePause()` and before any other await (including `reapOrphan()`), so a
slow peer poll or reap cannot delay it. It is also written when a peer accepts
an attempt, so a restart requested before the next tick already sees it, and
when a record imports, so the held restart need not wait for the next tick. Ticks may overlap, since `tick()` has
no re-entrancy guard; the atomic rename makes back-to-back writes harmless. Writing it
before a restart is requested matters: the restart consumers check every 10
seconds, and a heartbeat that appeared only after a request would miss the
first check. An attempt qualifies only if all hold: this machine
holds the serving lease; the reservation's `leaseEpoch` equals the current
epoch; the marker is `accepted`; and the peer's last successful poll is within
`2 × PEER_LIMITS.pollMs` (two minutes). Successful contact is tracked by a new
per-attempt `lastPollOkAt`. It is seeded with the accept time when the peer's
accept response arrives (that is a successful round trip, and without it a
just-dispatched attempt would not qualify until its first poll), and refreshed
only by a poll that returns a non-null result whose state is not `unknown`.
The existing `remotePolledAt` records attempts, not successes. With
`pollMs` at 60 seconds on a 30-second tick, successes land 60–90 seconds
apart; one failed poll widens the gap to 150–180 seconds and intentionally
drops the hold (fail-open). With no accepted
reservation the file does not exist, so idle machines add no I/O; with peer
work in flight the cost is one small write per 30-second tick.

**Guard.** `plannedRestartVerifyState()` folds the peer hold into its existing
`hold` and `holdUntilMs`, so all three consumers inherit it unchanged: the
supervisor and foreground watcher (which defer), `markPlannedRestartDeferred()`
(which writes the deliverability sidecar), and the verifier's `notePause()`.
The peer hold counts only when the heartbeat's `writtenAt` is within 90 seconds
(three verifier ticks) of now and not in the future. That tolerates a late
tick while staying under the two-minute poll rule. Each qualifying attempt holds until
`sentAt + 21 minutes` (20 minutes plus one `pollMs` for the result to be
imported), and never past the request's three-hour ceiling. With a local child
also running, the later bound wins, still capped at three hours. A missing,
unreadable, stale or malformed heartbeat does not defer. `bypassHolds: true`
still bypasses, and the updater's four-hour ceiling still sets it.

The bound comes from the local-verify audit, 2026-10-28 to 2026-11-04: 414
imported peer attempts, dispatch to import median 13.0 minutes, 95th
percentile 14.5, maximum 22.1; 2 of 414 exceeded 21 minutes. Dispatch to
accept was median 0.7 s, maximum 29 s, so `sentAt` is a fair anchor.

**No chaining.** Peer dispatch already re-checks `notePause()` immediately
before a reservation is made (`LocalVerifyService.ts` ~1790), and each peer has
at most one outstanding reservation. A planned restart therefore waits only for
reservations accepted before it was requested.

The lease fence is unchanged. An attempt bound to an old epoch is still
abandoned after a restart; this amendment only makes the restart wait so that
the attempt can finish and be imported under the epoch it was dispatched in.
Unplanned and emergency restarts are unchanged.

**Audit.** The verifier records `restart-held-for-peer` (attempt id, PR,
bound) once per attempt per pending request, and `restart-peer-hold-ended`
with the reason (`imported`, `abandoned`, `bound-reached`, `bypass`,
`no-longer-qualifies`). The audit runs on verifier ticks, so a server that
restarts before its next tick records no end event: the residual is then read
from the `boundAt` on `restart-held-for-peer` and the abandon that followed. The
deferral sidecar's existing reason is unchanged; the audit names which hold
applied.

### Verify the state, not its symbol

- Symbol: a fresh heartbeat entry.
- State claimed: the peer is still running this attempt, or holds a result
  that can still be imported under the current lease.
- Corroboration: the heartbeat is written only by the live verifier on the
  lease holder, after it has compared the reservation's epoch with the live
  lease and seen a successful peer poll within two minutes. A dead server stops
  writing, so the heartbeat goes stale within 90 seconds; a lost lease or epoch
  change removes the attempt; a dead or unreachable peer drops out after two
  minutes without a successful poll.
- Unmeasurable: no heartbeat, or an unreadable or stale one, means no peer
  hold. The restart proceeds exactly as before the amendment. The residual
  cost is a peer that answers polls but never finishes: it can hold a restart
  for at most 21 minutes.

### Rollout

The supervisor is a separate long-lived process. Until it restarts on the new
code, it ignores the heartbeat and behaves exactly as before; the foreground
watcher and the verifier pick it up first. That is safe in both directions.
Rollback is a code revert; the heartbeat file is then ignored and can be left
in place.

### Measurement

Count `peer-attempt-abandoned` with reason `lease-changed` occurring within 120
seconds of an own (`foreignHolder: false`) `lease-acquired`, and their
peer-minutes, per planned restart. The exposure is a planned restart that
found an accepted attempt under the current epoch. Before deployment it is
reconstructed from `peer-dispatch-accepted` with no terminal event at the
restart time; after deployment it is the `restart-held-for-peer` event.
Compare seven days on each side. Report attempts abandoned after
`bound-reached` separately, as the residual this design accepts.

### Safety and verification

- Unit (guard): fresh heartbeat inside and past the 21-minute bound;
  heartbeat 31 s and 89 s old (held) and 91 s old (not held); future,
  missing, malformed heartbeat; bypass flag; combined local and peer
  holds (later bound wins, capped at three hours); request reaching its
  three-hour ceiling during a peer hold; `markPlannedRestartDeferred()` returns
  true for a peer-only hold.
- Unit (verifier): an accepted reservation qualifies before its first poll;
  a poll returning `unknown` does not refresh `lastPollOkAt`; heartbeat
  excludes an epoch mismatch, a lost lease, a
  `sending` marker and a peer without a successful poll in two minutes;
  import then persist removes the attempt; heartbeat present while an
  accepted reservation exists with no restart pending, and absent with none;
  a peer poll that hangs does not delay the heartbeat write; no new reservation while the hold is active.
- Integration: a coordinator with an accepted reservation keeps a planned
  request pending until the record imports, then the request is consumed
  within one `pollMs` plus one consumer check.
- E2E: production wiring, an isolated server and a fake peer: the restart
  request is not consumed while the peer attempt is accepted, and is consumed
  after import.

## Multi-machine posture

The amendment adds one machine-local file, `state/local-verify/peer-hold.json`,
inside the Local Verify state directory, whose posture `local-verify-merge-authority`
already declares (lease-holder-local, operator-ratified there). The decision it
gates is the restart of this machine's own server process, and the attempts it
lists are ones this machine dispatched under its own lease. A standby writes no
heartbeat, because it holds no lease; a stale file left after a lease loss
expires within 90 seconds.
machine-local-justification: operator-ratified-exception — inherits the lease-holder-only Local Verify posture ratified in `docs/specs/green-pr-automerge-enforcement.md` (`approved-by: Justin (uid:7812716706), Telegram topic 24662, 2026-06-12 18:50 PDT`; present at commit ab26b7ca36c1375d855f08c9a6a66e84e2b656e2) and restated in `docs/specs/local-verify-merge-authority.md` §Multi-machine posture; this amendment does not change it.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Defer a planned restart while a local verify child is live (base decision, shipped in #2547) | invariant | Typed marker plus PID liveness, bounded at three hours; unreadable input never defers; `bypassHolds` overrides. |
| Verifier lists an attempt in the heartbeat | invariant | Four typed conditions combined with AND (lease held, epoch equal, `accepted`, poll within two minutes). Each is a measured fact, not a weighed signal; any failure omits the attempt, which falls back to the pre-amendment behavior. |
| Guard defers a planned restart for a listed attempt | invariant | Arithmetic on a fresh heartbeat: bounded at `sentAt` + 21 minutes and the three-hour request ceiling. Unreadable or stale input never defers. `bypassHolds` is an explicit override, not a judgment. |
| Combine the local and peer holds | invariant | The later of the two bounds, capped at three hours. |

## Frontloaded Decisions

1. Peer-hold bound: `sentAt` + 21 minutes, a code constant changed only by PR,
   from the 414-attempt audit above. Not cheap to change after: it alters
   restart behavior.
2. No configuration switch. The hold ships on, like the base decision; rollback
   is a code revert. The worst case is a 21-minute delay to routine
   maintenance, and `forceRestart` still bypasses it.
3. A `sending` marker does not count. It flips to `accepted` within a second in
   the audit (maximum 29 s), so excluding it costs little.
4. The same-holder `lease-lost` cause (4 abandons, 31.4 peer-minutes in the
   observed day) is out of scope. It is tracked in the throughput ledger
   (`.instar/state/throughput-improvement/ledger.json`, open measurement gaps)
   for its own diagnosis.

## Maturation plan

- **test-agent-live:** a throwaway agent with an isolated server and a fake peer: a planned restart requested while the peer attempt is accepted stays pending until the import, then is consumed; the same request with the heartbeat removed is consumed at once.
- **dev-agent-live:** Echo's coordinator after the package update. The first planned restart that finds an accepted peer attempt is checked in the audit (`restart-held-for-peer`, then `restart-peer-hold-ended` with `imported`).
- **fleet:** the behavior has no switch and reaches every agent with the package update, like the base decision. Agents with no peer verifiers never write the heartbeat, so for them nothing changes.
- **graduation criterion:** on Echo, over seven days after deployment, at least three planned restarts that found an accepted attempt, each followed by `imported` (or `bound-reached` for a run past 21 minutes), and zero `lease-changed` abandons within 120 s of an own lease re-acquire for those restarts.
- **dark-window:** none. It ships live; the residual risk is a routine restart delayed by up to 21 minutes, and rollback is a code revert.
- **ladder:** not applicable: no flag; the hold ships live with the package update and graduates by the 7-day comparison above.

## Open questions

*(none)*
