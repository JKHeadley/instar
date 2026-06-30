---
title: Cross-Machine Reconciler Convergence
description: How a conversation "move" between an agent's machines converges — the ownership reconciler, the replicated pin (move-intent), and the transferring-state handoff that complete a cross-machine transfer.
---

When an agent runs on more than one machine (e.g. a Laptop and a Mac Mini), a conversation
("topic") can be **moved** from the machine that currently owns it to another. The move must
converge: the old machine releases the topic and the new machine claims it, with both machines
agreeing on the result. This page describes the subsystem that makes that convergence reliable —
the fix for the cross-machine "stuck move" bug, where a pinned move silently never completed.

## The machines keep separate notebooks, synced by a journal

Each machine keeps its own ownership record (`LocalSessionOwnershipStore`, fronted by the
`SessionOwnershipRegistry` CAS authority) describing which topics it owns. The machines do not
share memory — they synchronize by appending to an at-least-once, eventually-consistent replicated
log (`CoherenceJournal`), which each machine reads to learn what its peers have asserted. Records
are ordered by a skew-proof `HybridLogicalClock` (HLC), never raw wall-clock time, so a machine
with a slightly-wrong clock cannot reorder another machine's events.

## The reconciler converges pin and owner

`OwnershipReconciler` runs a bounded reconcile tick on each machine. It compares the desired state
(the user's **pin** — "this topic should live on machine T") against the actual owner, and drives a
cooperative finite-state-machine transition: `active(S) → transferring(S→T) → active(T)`, with the
source machine tearing down once the target has claimed. While the owning machine is alive the
transfer is **cooperative** (the owner releases its own topic); a force-claim is only ever taken with
independent owner-death evidence plus quorum from machine liveness — never from the pin itself. A
stuck transfer (a dead or unreachable target past a deadline) self-heals via an abort-transfer back
to `active`.

## Root cause 1 — the clock-skew false quarantine

`MachinePoolRegistry` tracks peer liveness and a clock-skew quarantine FSM. The bug: the coarse,
git-synced file heartbeat's timestamp was being fed into the live skew FSM, permanently quarantining
a peer whose clock was actually fine — so the reconciler saw only one machine and no-oped. The fix is
a `coarseHeartbeat` flag: a coarse beat refreshes liveness but **abstains** from the skew FSM, which
only ever runs on a genuine live heartbeat.

## Root cause 2 — the pin never reached the owner

The pin was written only on the lease-holder (`TopicPlacementPinStore`), so the **owning** machine —
the one that has to let go — never learned it was pinned away. The fix replicates the pin as
move-intent via a new replicated-record kind, `topic-pin-record`, carried on the same replicated-record
machinery the memory/PII stores use: `ReplicatedRecordEmitter` (the send side — HLC stamp, tombstone,
quarantine) and `ReplicatedStoreReader` for the read side, registered through the
`ReplicatedKindRegistry`. The lean consumer `TopicPinReplicatedStore` validates and HLC-merges those
records into an **advisory** pin (highest HLC wins; a tombstone clears it). The reconciler reads the
advisory pin with HLC-precedence against its own local pin and acts only when the target machine is a
known, online peer — so a stale advisory pointing at a departed machine never triggers a move.

## Root cause 3 — the transferring handoff never replicated

Even once a machine set `transferring`, that signal stayed local, so the target never knew to claim.
The fix extends the placement record (`PlacementExecutor`'s `TopicPlacement` / the journal's
`PlacementData`) with `status` / `transferTo` / `timestamp` / `drainInFlight`, threaded through the
shared placement-emit helper so every CAS site emits coherently. `OwnershipApplier` (wired by
`ownershipApplierWiring`) then materializes the replicated transferring state on the target —
validating `transferTo` (an unknown/offline/self target downgrades to `active(owner)`), fencing the
epoch (fast-forward only), and clamping a corrupt future/past `timestamp` — so the target machine
claims and the handoff completes.

## Observability

`GET /pool/reconciler` returns the reconciler's last-tick status, and with `?topic=N` a read-only
per-topic decision explanation (why a given topic would transfer, force-claim, abort, or no-op). It
returns `503` when the reconciler is not active (single-machine or the feature dark). This makes a
stuck cross-machine move inspectable rather than a black box.

## Safety & rollout

The whole subsystem ships dark behind `multiMachine.seamlessness.ws13Reconcile` / `ws13DryRun` and an
independent `ws13PinReplicate` sub-flag (dev-agent live, fleet dark). A single-machine agent is a strict
no-op — no peers, so the reconciler never engages and no advisory pins are read. A replicated pin is
**advisory** and can only trigger the owner's own cooperative transfer; it can never manufacture the
death evidence a force-claim requires. Related replicated-store consumers built on the same machinery
include `LearningsReplicatedStore`, `KnowledgeReplicatedStore`, `EvolutionActionsReplicatedStore`,
`RelationshipsReplicatedStore`, and `PreferencesReplicatedStore`.
