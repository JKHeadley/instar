# Side-Effects Review — Commitments Coherence read replication (P1.5a)

**Version / slug:** `commitments-sync-p15a`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (implements §3.1–§3.3 of the 3-round-converged spec; read-only replication, dark behind the explicit replication gate; owner-routed mutation is P1.5b)`

## Summary of the change

P1.5a of COMMITMENTS-COHERENCE-SPEC — promises become VISIBLE from every
machine:

1. CommitmentTracker bookkeeping (§3.1/§3.2): `originMachineId` stamped at
   creation (the composite (originMachineId, id) is THE cross-machine
   identity — ids are per-machine sequential counters and collide by
   construction); `replicationSeq` + `storeIncarnation` + per-record
   `lastMutatedSeq` as ADDITIVE store fields (schema `version: 2` literal
   untouched; loadStore guard unchanged; legacy stores seed
   replicationSeq=1 + fresh incarnation → full first pull; fresh stores
   seed at birth). The replication stamp lives at the THREE write funnels
   (CAS apply, mutateSync, insertNew) as a prev/next diff EXCLUDING beacon
   bookkeeping (consecutiveUnchanged/lastHeartbeatAt/heartbeatCount) — a
   quiet agent's heartbeats never re-ship snapshots. Rewind fence: the
   meta sidecar's high-water re-mints the incarnation on a restored
   backup.
2. `src/core/CommitmentsSync.ts`: paged delta serve (lastMutatedSeq >
   sinceSeq, exclusive cursor, 256KB pages with at-least-one-record,
   incarnation fencing), serve-time legacy stamping + per-field
   credential-shape redaction (the record still replicates — closeability
   never depends on the scan), CommitmentReplicaStore (single-writer
   receive path, first-hop WITH TEETH: rows claiming another machine's
   originMachineId rejected + counted; corrupt → quarantine + full
   re-pull), mergeCommitmentViews (composite key; viewSource + staleness;
   computed pendingMutation join; heuristic possibleDuplicateOf) +
   resolveBareId (409-ambiguous semantics).
3. Three lockstep verb edits (`commitments-sync`: union + RBAC
   read/observe + dispatcher handler answering 'disabled' while dark);
   session-status advert (`commitmentsAdvert`, answered from MEMORY);
   PeerPresencePuller `driveCommitmentsSync` seam riding the existing 30s
   cadence (bounded pages per tick); GET /commitments?scope=mesh (default
   scope byte-identical; mesh scope degrades to own-rows, 200 never 503).
4. Config (`coherenceJournal.commitments` block) + State-Coherence
   Registry (`commitment-replicas` category; `commitments` description
   updated per §3.6).

NOT in this slice (P1.5b): owner-routed mutation, verdict wrappers,
commitment-mutate verb, opKey window, pending-mutations ledger.

## Decision-point inventory

- **State-meaningful vs bookkeeping diff** at the funnels — the spec's
  write-amplification guard; tested both directions.
- **Incarnation fence**: stale requester → re-pull from 0; receiver
  replaces the replica WHOLESALE on incarnation change (never a
  sinceSeq short-circuit against a restored store).
- **First-hop teeth**: replica identity = authenticated env.sender;
  forged rows counted, never applied.
- **Merged-view honesty**: collision rows NEVER collapse (the round-1
  headline); bare-id ambiguity is surfaced, not guessed.

## 1. Over-block / 2. Under-block

Over: a record whose only change is beacon bookkeeping never replicates
until its next real mutation (deliberate). Under: the credential-shape
scan is leak-reduction, not a boundary (spec §3.2 honesty — boundary =
same-operator posture); cross-machine deliver (closeability) lands in
P1.5b — until then the merged view names the owner and the close happens
there.

## 3. Fit / 4. Blast radius

Engine in core (seam-injected, like JournalSyncApplier); tracker gains
bookkeeping ONLY (no behavior change — 77 existing tests pass
unchanged); routes' default scope byte-identical. Dark everywhere except
explicit replication.enabled pairs; single-machine agents: advert
omitted, mesh scope = own rows, zero overhead.

## Evidence

- tests/unit/CommitmentsSync.test.ts — 15 passing (paged deltas +
  multi-page convergence, incarnation fence, serve-time stamping +
  redaction-with-record-intact, first-hop teeth, wholesale replacement,
  corrupt quarantine, collision-two-rows + 409-ambiguous + ?origin,
  staleness + computed pendingMutation + possibleDuplicateOf, tracker
  bookkeeping incl. beacon-write guard + legacy backfill + rewind
  re-mint).
- tests/integration/commitments-sync-roundtrip.test.ts — 2 passing: full
  paged round-trip over the REAL signed MeshRpc + express path with
  delta-only convergence after a mutation, and mixed-version 501.
- tests/unit/CommitmentTracker.test.ts — 77 passing unchanged.
  peer-presence-wiring + session-pool-activation-wiring +
  feature-delivery-completeness all green. Typecheck + lint chain (70
  registry categories) + docs-coverage clean.
