# Commitments read replication (P1.5a) — promises visible from every machine

## What Changed

First build slice of the Commitments Coherence spec (P1.5 of multi-machine
coherence): every machine can now SEE every machine's promises. Dark
everywhere except explicitly replication-enabled pairs.

- Every commitment is stamped with its home machine at creation; the
  cross-machine identity is (machine, id) together — because the plain ids
  are per-machine counters that collide by construction (the review
  round's headline catch: an id-keyed merge would have silently hidden
  real obligations).
- Each machine's store replicates to peers as small seq-windowed delta
  pages on the existing 30s presence cadence — one field change ships one
  record, not the whole store; a restored-from-backup store re-mints its
  incarnation so peers re-pull wholesale instead of stranding.
- Free-text fields are credential-shape-scanned at serve time; a flagged
  field ships redacted while the record itself still replicates.
- `GET /commitments?scope=mesh` merges own + replica rows with honest
  labels (replica + how stale) and flags possible cross-machine duplicate
  promises. The default scope is byte-identical to before.

NOT yet (P1.5b): closing a promise from the non-home machine (owner-routed
mutation + the durable offline queue).

## What to Tell Your User

On machine pairs with sync enabled: ask ANY machine "what are your open
commitments?" and you get the complete picture — promises made on the
other machine show up, honestly labeled with where they live and how
fresh the copy is. Closing one from the "wrong" machine arrives in the
next slice.

## Summary of New Capabilities

- `commitments-sync` MeshCommand — paged, incarnation-fenced delta
  replication of commitment records between same-operator machines.
- `src/core/CommitmentsSync.ts` — serve/receive/merge engine
  (CommitmentReplicaStore, mergeCommitmentViews, resolveBareId).
- `GET /commitments?scope=mesh` — the merged cross-machine view.
- CommitmentTracker: originMachineId stamping + replicationSeq /
  storeIncarnation / lastMutatedSeq bookkeeping (additive, legacy-safe).

## Evidence

- 15 unit (CommitmentsSync) + 2 integration (real signed transport
  round-trip w/ delta-only convergence; mixed-version 501) + 77
  CommitmentTracker tests unchanged; typecheck/lint/docs-coverage clean.
