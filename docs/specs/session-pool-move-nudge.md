---
title: "A moved conversation's new owner hears about it in seconds"
slug: "session-pool-move-nudge"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
review-convergence: "2026-11-05T12:58:57.000Z"
review-iterations: 2
review-completed-at: "2026-11-05T12:58:57.000Z"
review-report: "docs/specs/reports/session-pool-move-nudge-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; no constitution change; follows Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first)"
eli16-overview: "docs/specs/session-pool-move-nudge.eli16.md"
---

# A moved conversation's new owner hears about it in seconds

## Problem statement

After a move, the source machine lands `claim(T)` in its own ownership store and journal. The target and
the lease holder learn of it only by pulling, and a message in that gap waits. Measured on Echo's ring,
2026-11-04/05, all Mama PC as source except where noted: 33 s, 28 s and 3 min 14 s (fb-aea2fff6-337).

Reading the path (`PeerPresencePuller.pullOnce`, `commands/server.ts`, timer at the 30 s presence tick):

- Replication is pull only, every 30 s, with no way to ask for it sooner.
- One pass polls all peers in parallel and coalesces onto a pass in flight, so it waits for the slowest
  peer. Each peer's stale kinds are requested one at a time with a 5 s timeout each. An unresponsive peer
  can hold a pass for over two minutes (read, not measured: 23 kinds plus sync pages at 5 s each).
- `OwnershipApplier` then materializes on its own 15 s timer, and a queued message waits a further drain
  tick of up to 15 s.

Two user-visible effects. A message right after a move waits, safely, up to minutes. A second move soon
after can be refused `refused-ledger-transfer`/`release-unauthorized`, because the next target still names
the old owner. Both are safe failures; neither loses anything. Step 3 of
`docs/specs/session-pool-default-on.md` puts moves in front of new agents' users, so the wait matters
before that step, not after.

## Proposed design

One new signed mesh verb, `ownership-nudge`, carrying no authority: `{ type, sessionKey, epoch, landedAt }`. The
epoch and time say which claim to look for and when it landed. Nothing writes them to any store.

**Sender.** In the drain runner's `cas` wrapper, after a `claim` CAS that landed, the source flushes the
journal, then sends the nudge to every other active machine in the mesh registry. That is at most 4 sends
on Echo's fleet. All of them, not just the target and the holder, because a second move needs the next
target to know too: it refuses a release from a machine it does not yet see as owner (`MeshRpc.ts:463`).
Fire and forget: 3 s timeout, one attempt, no retry. A refusal from an older peer (`claim-unauthorized`,
since an unlisted verb is refused) or any failure is ignored, with a `@silent-fallback-ok` note naming the
30 s pull as the fallback; the receiver's evidence below is what shows it working. The move's outcome never
depends on it. The wrapper is shared by the shed path and the drain arm of `POST /pool/transfer`. The flush
comes first because only flushed sequence numbers are advertised; `flush()` is synchronous, so its
re-entrancy guard cannot bite across an await.

**Receiver.** The handler sits beside `journal-sync` and joins the registered-peer RBAC class in
`MeshRpc.ts`: `verifyEnvelope` has already proved a signed, recipient-bound active sibling. It answers
`{ ok: true }` immediately, then:

1. pulls `topic-placement` only, only from `env.sender`, using the sender's registry URL and never one from
   the payload. A new single-peer method on `PeerPresencePuller` reuses the capacity fetch and
   `driveJournalDelta`, repeating up to 3 pages until it reaches the advertised head, because one page is
   256 KB and a peer with no cursor would not reach the claim. It records no heartbeat or peer presence;
2. runs one `ownershipApplier.tick()`;
3. for each pending key whose local epoch has reached the nudge's, calls the existing
   `onOwnershipTransition(key)`. A key that has not reached it is not woken. The wake clears a queued message's backoff, and waking one against a
   still-stale view would retry it early against the old owner and spend its attempts;
4. records `featureEvidence` under `multiMachine.sessionPool.moveNudge`: sender, key, epoch, reached or not,
   time from `landedAt` to reaching it, and separately this machine's own processing time.

Overlap with the 30 s pull is safe, read in the code: `apply` is synchronous and drops entries at or below the
held sequence, and `tick` is synchronous. Whichever pull lands first, the other's entries are duplicates.

A receiver with a backlog past 3 pages does not reach the claim on this pass. The evidence says not reached, and
the 30 s pull finishes the catch-up. So the seconds-level result is for a receiver with at most 3 pages behind
(768 KB of placements), which a running peer is. A machine just back after a long absence is not, and is not
promised it.

It is a strict no-op, with evidence reason, when `coherenceJournal.replication.enabled` is not true or the
puller or applier is not bound. The puller and mesh client are built later in boot than the wrapper and the
handler, so each is reached through a late-bound module variable, the `_identityPresencePull` pattern.

**Limits.** Per sender: one pull in flight, and a set of pending keys capped at 100 (past the cap, the oldest
are dropped and those messages wait for the normal timers). A nudge during a pull adds its key; when the pull
ends, if keys are pending, one further pass runs, no sooner than 1 s after the last began. So load is at most
one placement pull per second per sender while nudges keep coming, and two brakes stop that repeating: at most 60
passes per sender per hour, and after 5 passes in a row that failed or did not reach their epoch, nudges from
that sender are ignored for 5 minutes, with an evidence row for each stop. A stopped sender loses nothing: the
normal timers carry on, and no pass ever starts except from a nudge, so with no moves there is no work. The key is used only to look up an
epoch and wake a queue; a junk key has no epoch to rise and wakes nothing.

**Why this cannot change who owns anything.** The verb has no owner field. The applier stays fast-forward
only, and it sees the same signed journal entries the 30 s pull would have delivered, just sooner. The
30 s and 15 s timers stay as they are and remain the fallback.

## Decision points touched

None that gate. The nudge is a hint; nothing reads it to allow or refuse anything. Router, RBAC for
existing verbs, and the applier's rules are unchanged.

## Non-goals

- Pulling the slowest-peer stall out of `pullOnce`. The nudge goes around it for moves; the stall remains
  for everything else and is filed separately if it proves to matter.
- Pushing ownership data. A signed journal entry stays the only way ownership crosses.
- Failover. A dead source sends no nudge; failover keeps its own path and timers.
- The reconciler's 45 s backstop claim, written on T. T already knows; the holder learns by the normal pull.

## Failure modes

| Case | Result |
|---|---|
| Nudge lost, peer down, or older peer | today's behaviour: the 30 s pull |
| Move through the pin arm of `POST /pool/transfer` (drain not available) | no nudge; today's behaviour |
| Nudges stop working altogether | moves still work, as slowly as today; the live measure and the evidence row show it |
| Peer flooded by a misbehaving sibling | stopped by the hourly budget and the failure brake above; the normal timers carry on |
| Single machine | never sent: no peer, no target |
| Journal replication off | receiver no-ops; message waits as today |
| Flush fails, or pull fails | epoch not reached, nothing is woken, evidence says so; the normal pull delivers it |
| Receiver over 3 pages behind | not reached on this pass; the normal pull finishes |
| Mixed versions | old receiver refuses the verb, old sender sends none; either way today's behaviour |

## Testing

- **Unit:** the sender fires only on a landed `claim`, not on `transfer`, `abort` or a lost CAS; it reaches
  every active peer and not itself; a thrown or refused send leaves the outcome untouched. The receiver pulls
  only from the sender and only the one kind, and walks pages to the head; overlapping nudges for different
  keys all wake after their covering pass; a key at the nudge's epoch wakes and one below it does not, on both
  sides of that boundary; a claim past page 3 reads not reached and is not woken; the 1 s spacing, the key cap, the hourly budget and the failure brake hold, both sides of each limit; a no-op with replication off or an unbound puller. `MeshRpc` accepts the verb from a registered peer and refuses it from an unknown one.
- **Integration:** two real coordinators over a real mesh transport with a long pull timer: a landed claim
  is visible in the target's ownership view within seconds with no presence tick running.
- **E2E:** production wiring: the verb's handler is registered and not a no-op, and `claim` reaches it.
- **Live, what decides it:** the ring on Echo's real machines. Read
  `claim landed` to first `active(T)` in `GET /pool/ownership-view` on the target and on the holder. Pass:
  under 10 s on every leg, including the Mama PC source that measured 3 min 14 s, compared with those same
  legs before. A second move to a third machine straight after the first no longer refuses for lag. The time
  comes from `landedAt` to reached in the `multiMachine.sessionPool.moveNudge` row on each receiver, for that
  exact key and epoch. It crosses two clocks, so read it beside each machine's skew from `GET /pool`, and check it
  by hand against the ownership view.

## Rollout and rollback

No switch. It sends only after a real move, which takes a peer, and it does nothing on a receiver without
`coherenceJournal.replication.enabled`, which is absent by default. So a single-machine agent never sends and
an agent that has not turned on replication never pulls. The only agent-installed change is the awareness line below. Rollback is reverting the release; a mixed fleet behaves as today.

## Agent awareness

One line in the session-pool paragraph of the CLAUDE.md template, with a content-sniffed migration so existing agents get it: when someone asks why a message waited after a move, read the `multiMachine.sessionPool.moveNudge` evidence. The verb is listed with the others in `MeshRpc.ts`.

## Maturation plan

- **test-agent-live:** none of its own: the nimbus pair has no replication on, so nothing fires there. Unit and integration tests cover the receiver's no-op on that case.
- **dev-agent-live:** Echo's ring, four machines with replication on, with the live pass line under Testing. The Laptop is out of the ring and only ever receives a nudge.
- **fleet:** the release that carries it, ungated. Only agents with replication on can act on it, and they are the ones with moves.
- **graduation criterion:** under 10 s from a landed claim to known on every ring leg, with no refusal for lag on a following move; read from the `multiMachine.sessionPool.moveNudge` evidence rows and the ring's run records, not from a count of nudges sent.
- **ladder:** multiMachine.sessionPool.stage; no rung of its own, it rides the existing ladder and reports to the same review job.
- **dark-window:** none: a hint with no authority, inert until a real move happens with replication on.

## Open questions

None.
