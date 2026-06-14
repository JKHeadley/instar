# Side-Effects Review — WS2.2 (learnings replication)

## Summary

Adds the THIRD concrete replicated-store consumer (`learning-record`) and the SECOND
memory-family kind on the HLC replicated-store foundation, mirroring the merged WS2.3
relationships PR exactly. Dark + additive: nothing changes at runtime unless
`multiMachine.stateSync.learnings.enabled` is explicitly set true (default false).

## Files changed

- **NEW `src/core/LearningsReplicatedStore.ts`** — pure-logic consumer (schema, projection,
  recordKey fingerprint, tombstone, union-read, foreign render, own-origin materialization).
- **`src/core/CoherenceJournal.ts`** — `learning-record` added to the `JournalKind` union +
  `JOURNAL_KINDS` const + DEFAULT_RETENTION + the four per-kind Record initializers
  (nextSeq, highWaterSeq, opKeys, retention, rateBuckets).
- **`src/core/EvolutionManager.ts`** — `LearningReplicationEmitter` interface +
  `setLearningReplicationEmitter()` seam + best-effort emit in `saveLearnings()` (put per
  surviving learning; op:delete tombstone per PRUNED learning — the resurrection guard).
- **`src/commands/server.ts`** — registers `LEARNING_KIND_REGISTRATION`; builds the
  learnings union reader through `ReplicatedStoreReader`.
- **`src/config/ConfigDefaults.ts`** — `multiMachine.stateSync.learnings: { enabled:false,
  dryRun:true }` dark default (add-missing migration via applyDefaults).
- **`src/core/devGatedFeatures.ts`** — DARK_GATE_EXCLUSIONS classifies the new path
  (optional-integration).
- **`src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts`** — One Memory awareness
  sub-line (template + idempotent migrator backfill, guarded by a unique marker).
- **`site/src/content/docs/architecture/under-the-hood.md`** — LearningsReplicatedStore doc.
- **Tests**: `tests/unit/LearningsReplicatedStore.test.ts` (42),
  `tests/unit/evolution-manager-learning-replication.test.ts` (5),
  `tests/unit/ws22-learnings-wiring.test.ts` (11),
  `tests/integration/ws22-learnings-emit.test.ts` (3),
  `tests/e2e/ws22-learnings-alive.test.ts` (3); plus updated golden maps in
  `tests/unit/lint-dev-agent-dark-gate.test.ts` and `tests/unit/CoherenceJournal.test.ts`.

## Signal vs. Authority

Every new surface is SIGNAL, never authority. The union read injects a peer's learning as
ADVISORY quoted-untrusted-data and NEVER blocks on an open conflict (fork #2). The
flag-coherence gate only decides whether to forward a kind to a peer — it never gates a
user action. The replication emit is best-effort and can NEVER break a local learning write
(a throwing emitter is swallowed; the durable on-disk state is already persisted). A
replicated record never clobbers a divergent local record.

## Blast radius / risk

- **Dark by default.** With `stateSync.learnings.enabled` false (the shipped default), the
  EvolutionManager emit seam is never injected (server.ts does not yet wire a journal-backed
  emitter — that is a later rollout stage, mirroring WS2.3), so `saveLearnings()` is
  byte-identical to today. A single-machine install is a strict no-op.
- **No new HTTP routes.** The learning-record kind rides the existing shared
  `/state/conflicts`, `/state/resolve-conflict`, `/state/quarantine` foundation routes.
- **CoherenceJournal kind addition is additive** — readers ignore unknown kinds; an old
  peer never pulls a kind absent from its own JOURNAL_KINDS (nothing requested ⇒ nothing
  dropped). The four exhaustive Record<JournalKind,…> initializers were all updated (a
  missing key is a tsc error, which passes).
- **Migration parity**: the config default is backfilled to existing agents via
  applyDefaults; the CLAUDE.md sub-line via an idempotent migrator branch guarded by the
  unique `Learnings are the SECOND memory-family store` marker.

## Rollback

Set `multiMachine.stateSync.learnings.enabled: false` (the default) — fully inert. To
un-merge a peer's contributed namespace, disable the flag for that origin (RollbackUnmerge
quarantine-aside drops the `learning-record` namespace, zero dangling conflictId refs). No
destructive deletion. Reverting the PR removes the kind entirely (additive — no data
migration needed since nothing ships enabled).

## Tracked follow-ups

`<!-- tracked: CMT-1416 -->` — WS2.4 (KB) / WS2.5 (evolution) / WS2.6 (playbook) reduce to
schema+projection+flag on this same proven machinery. The journal-backed emitter injection
in server.ts (turning the EvolutionManager seam live) is the next rollout stage, mirroring
where WS2.3 stands.
