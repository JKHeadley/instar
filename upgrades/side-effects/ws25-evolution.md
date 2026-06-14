# Side-Effects Review — WS2.5 (evolution action-queue replication)

## Summary

Adds the FIFTH concrete replicated-store consumer (`evolution-action-record`) and the FOURTH
memory-family kind on the HLC replicated-store foundation, mirroring the merged WS2.4 knowledge
PR exactly. Dark + additive: nothing changes at runtime unless
`multiMachine.stateSync.evolutionActions.enabled` is explicitly set true (default false).

## Files changed

- **NEW `src/core/EvolutionActionsReplicatedStore.ts`** — pure-logic consumer (schema, projection,
  recordKey fingerprint, tombstone, union-read, foreign render, own-origin materialization).
- **`src/core/CoherenceJournal.ts`** — `evolution-action-record` added to the `JournalKind` union +
  `JOURNAL_KINDS` const + DEFAULT_RETENTION + the five per-kind Record initializers (nextSeq,
  highWaterSeq, opKeys, retention, rateBuckets).
- **`src/core/EvolutionManager.ts`** — `EvolutionActionReplicationEmitter` interface +
  `setEvolutionActionReplicationEmitter()` seam + best-effort emit in `saveActions()` (a `put` per
  surviving action so a status change re-emits; an `op:delete` tombstone per action removed over
  maxActions — the resurrection guard; a terminal completed/cancelled action is RETAINED, not
  tombstoned).
- **`src/commands/server.ts`** — registers `EVOLUTION_ACTION_KIND_REGISTRATION`; builds the
  evolution-actions union reader through `ReplicatedStoreReader` over the existing EvolutionManager.
- **`src/config/ConfigDefaults.ts`** — `multiMachine.stateSync.evolutionActions: { enabled:false,
  dryRun:true }` dark default (add-missing migration via applyDefaults).
- **`src/core/devGatedFeatures.ts`** — DARK_GATE_EXCLUSIONS classifies the new path
  (optional-integration).
- **`src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts`** — One Memory awareness
  sub-line (template + idempotent migrator backfill, guarded by a unique marker).
- **`site/src/content/docs/architecture/under-the-hood.md`** — EvolutionActionsReplicatedStore doc.
- **Tests**: `tests/unit/EvolutionActionsReplicatedStore.test.ts`,
  `tests/unit/evolution-manager-action-replication.test.ts`,
  `tests/unit/ws25-evolution-actions-wiring.test.ts`,
  `tests/integration/ws25-evolution-actions-emit.test.ts`,
  `tests/e2e/ws25-evolution-actions-alive.test.ts`; plus updated golden maps in
  `tests/unit/lint-dev-agent-dark-gate.test.ts` and `tests/unit/CoherenceJournal.test.ts`.

## Signal vs. Authority

Every new surface is SIGNAL, never authority. The union read injects a peer's action as ADVISORY
quoted-untrusted-data and NEVER blocks on an open conflict (fork #3). The flag-coherence gate only
decides whether to forward a kind to a peer — it never gates a user action. The replication emit is
best-effort and can NEVER break a local action write (a throwing emitter is swallowed; the durable
on-disk action-queue is already persisted). A replicated record never clobbers a divergent local
record.

## Blast radius / risk

- **Dark by default.** With `stateSync.evolutionActions.enabled` false (the shipped default), the
  EvolutionManager emit seam is never injected (server.ts does not yet wire a journal-backed
  emitter — that is a later rollout stage, mirroring WS2.4/WS2.2), so `addAction()`/`updateAction()`
  are byte-identical to today. A single-machine install is a strict no-op.
- **The status field is the point.** A status change re-emits a put so a peer sees an action was
  already completed/in_progress and does not redo it. status/priority/completedAt are mutable
  (last-writer-witness; concurrent divergence rides append-both-and-flag — the single conflict
  path, NOT a CRDT special-case). The recordKey deliberately excludes status, so a status change
  updates the SAME record instead of forking a new one.
- **Terminal is not a delete.** A completed/cancelled action is retained (history); only an actual
  queue-removal (prune-over-maxActions) emits a tombstone — else a peer re-replicates a
  locally-removed action forever (resurrection).
- **No new HTTP routes.** The evolution-action-record kind rides the existing shared
  `/state/conflicts`, `/state/resolve-conflict`, `/state/quarantine` foundation routes.
- **CoherenceJournal kind addition is additive** — readers ignore unknown kinds; an old peer never
  pulls a kind absent from its own JOURNAL_KINDS (nothing requested ⇒ nothing dropped). The five
  exhaustive Record<JournalKind,…> initializers were all updated (a missing key is a tsc error,
  which passes).
- **Migration parity**: the config default is backfilled to existing agents via applyDefaults; the
  CLAUDE.md sub-line via an idempotent migrator branch guarded by the unique `Evolution action queue
  is the FOURTH memory-family store` marker; the dark-gate line-map recomputed via the attributor.

## Rollback

Set `multiMachine.stateSync.evolutionActions.enabled: false` (the default) — fully inert. To un-merge
a peer's contributed namespace, disable the flag for that origin (RollbackUnmerge quarantine-aside
drops the `evolution-action-record` namespace, zero dangling conflictId refs). No destructive
deletion. Reverting the PR removes the kind entirely (additive — no data migration needed since
nothing ships enabled).

## Tracked follow-ups

`<!-- tracked: CMT-1416 -->` — WS2.6 (playbook) is an ARCHITECTURAL MISMATCH (a Python-script-written
manifest, no TS emit-seam) and is deferred; see the tracker's WS2.6 decision note. The journal-backed
emitter injection in server.ts (turning the EvolutionManager seam live) is the next rollout stage,
mirroring where WS2.4/WS2.2 stand.
