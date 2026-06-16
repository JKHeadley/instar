---
title: Live-User-Channel Proof
description: The gold-standard testing standard — a user-facing feature is not "done" until a user-role session has driven it through the real channels — and the durable multi-machine ownership fix that was the first feature held to it.
---

A user-facing feature should never be reported "done" while it is still broken in the
one place that matters: the real user channel. The **Live-User-Channel Proof** standard
makes that structural. A feature you touch through Telegram or Slack is not done until a
*user-role session* has driven it end-to-end through the real channel — across an
enumerated scenario matrix — before the operator is ever asked to test it. This page maps
the components that enforce it, all of which ship **dark** behind dev-gated flags.

## The completion gate

`LiveTestGate` is the brain. It reads a feature's recorded test result and decides
**allow / veto / nudge**: a user-facing feature with no verified result cannot resolve
"done". `LiveTestGate` is wired (dark, dry-run by default) into the autonomous
completion path, so an autonomous run can't declare a chat-facing feature finished
without proof. Signal-vs-Authority is preserved: a hard veto rests only on an explicit
`userFacing` declaration plus the objective absence of a verified artifact, never on a
brittle classifier guess.

The result the gate reads is a `LiveTestArtifactStore` record: a canonically-serialized,
content-hashed, Ed25519-signed scenario matrix written to a per-machine, hash-chained
ledger segment. Because `LiveTestArtifactStore` re-reads the artifact from disk and
recomputes the hash at gate time, an agent cannot hand-type an "I tested it" record to
buy the exit — a forged or edited artifact fails the hash check. The threat model is
honest drift-correction, not an adversarial-runner security boundary.

## The user-role harness

`LiveTestHarness` produces those artifacts. It runs a scenario matrix as the *user*,
through an injected channel driver (real Telegram / Slack / dashboard, or a fake in
tests), and records a deterministic PASS/FAIL from the captured protocol evidence — the
reply text and the machine that actually answered. `LiveTestHarness` refuses to run a
volatile or permission-changing scenario on anything but an isolated demo channel, so a
dangerous test can never touch the live operator channel.

## First feature held to the bar: durable multi-machine ownership

The standard's first application was the cross-machine transfer fix. The bug: moving a
conversation between machines reported success but never actually moved the seat, because
ownership lived in an in-memory store that never crossed machines. `SessionOwnershipRegistry`
is store-agnostic, so the fix swaps in a `LocalSessionOwnershipStore` — a durable,
per-session substrate that survives a restart — behind a dev-gated flag.

`OwnershipApplier` is the cross-machine half: on each machine it reads the replicated
placement entries (via `CoherenceJournalReader`) that the transfer emits, and materializes
durable local ownership on the machine a topic moved *to*, so the next message resolves the
right owner. `OwnershipApplier` adopts only strictly-newer placements, so a stale replicated
entry can never clobber a fresher local decision — and a crash mid-move converges to exactly
one owner, working alongside the existing `OwnershipReconciler`. `SessionOwnershipRegistry`
and `CoherenceJournalReader` are the existing seams the fix reuses, and `OwnershipReconciler`
remains the background convergence path; together with `LocalSessionOwnershipStore` they make
a transferred seat genuinely move between machines.

## Related internals

The durable store follows the same atomic-write discipline as the lease stores: where a
single-machine lease uses `LocalLeaseStore` and a git-backed pool uses `GitLeaseStore`,
per-session ownership uses `LocalSessionOwnershipStore` with the identical fast-forward CAS.
The store that the fix replaces, `InMemorySessionOwnershipStore`, stays the default until a
machine opts in, and `SessionRouter` is the inbound path that resolves which machine serves
a topic — the reader `CoherenceJournalReader` feeds `OwnershipApplier`, and `SessionRouter`
reads the materialized ownership so the conversation lands on the right machine. The lease
stores `LocalLeaseStore` and `GitLeaseStore`, the router `SessionRouter`, and the legacy
`InMemorySessionOwnershipStore` are the surrounding pieces a reader will meet here.


## Pool-consistent activation

The durable store's activation is decided by `durableOwnershipActivation` — specifically
`shouldActivateDurableOwnership`, which activates the store on every machine where placement
replication is explicitly on, not only on a dev-flagged machine. This closed a live-test
finding where the Mini's store stayed dark and a transferred seat died on arrival;
`durableOwnershipActivation` makes a replication-enabled pool activate consistently.

## OwnershipApplier wiring (the second finding)

The first live re-run of the transfer caught a deeper bug than the activation gap: the
`OwnershipApplier` — the component that materializes durable ownership on the machine a topic
moved *to* — was never wired at runtime, because its construction guard read a mesh-id
variable hundreds of lines before the boot sequence assigned it. The fix extracts the
construction condition into a testable `wireOwnershipApplier` factory that gates on the
durable store alone and late-binds the machine id. `wireOwnershipApplier` returns a live
applier whenever the durable store is active — even before the mesh id resolves — so a
reordering of the boot sequence can never again silently disable it; the durable destination
record (not a log line) is the authoritative proof the seat actually moved.
