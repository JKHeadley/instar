# Side-Effects Review — WS2.4 (knowledge-base replication)

## Summary

Adds the FOURTH concrete replicated-store consumer (`knowledge-record`) and the THIRD
memory-family kind on the HLC replicated-store foundation, mirroring the merged WS2.2
learnings PR exactly. Dark + additive: nothing changes at runtime unless
`multiMachine.stateSync.knowledge.enabled` is explicitly set true (default false).

## Files changed

- **NEW `src/core/KnowledgeReplicatedStore.ts`** — pure-logic consumer (schema, projection,
  recordKey fingerprint, tombstone, union-read, foreign render, own-origin materialization).
- **`src/core/CoherenceJournal.ts`** — `knowledge-record` added to the `JournalKind` union +
  `JOURNAL_KINDS` const + DEFAULT_RETENTION + the four per-kind Record initializers
  (nextSeq, highWaterSeq, opKeys, retention, rateBuckets).
- **`src/knowledge/KnowledgeManager.ts`** — `KnowledgeReplicationEmitter` interface +
  `setKnowledgeReplicationEmitter()` seam + best-effort emit in `ingest()` (put) and
  `remove()` (op:delete tombstone — the resurrection guard).
- **`src/commands/server.ts`** — registers `KNOWLEDGE_KIND_REGISTRATION`; constructs a
  KnowledgeManager + builds the knowledge union reader through `ReplicatedStoreReader`.
- **`src/config/ConfigDefaults.ts`** — `multiMachine.stateSync.knowledge: { enabled:false,
  dryRun:true }` dark default (add-missing migration via applyDefaults).
- **`src/core/devGatedFeatures.ts`** — DARK_GATE_EXCLUSIONS classifies the new path
  (optional-integration).
- **`src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts`** — One Memory awareness
  sub-line (template + idempotent migrator backfill, guarded by a unique marker).
- **`site/src/content/docs/architecture/under-the-hood.md`** — KnowledgeReplicatedStore doc.
- **Tests**: `tests/unit/KnowledgeReplicatedStore.test.ts`,
  `tests/unit/knowledge-manager-replication.test.ts`,
  `tests/unit/ws24-knowledge-wiring.test.ts`,
  `tests/integration/ws24-knowledge-emit.test.ts`,
  `tests/e2e/ws24-knowledge-alive.test.ts`; plus updated golden maps in
  `tests/unit/lint-dev-agent-dark-gate.test.ts` and `tests/unit/CoherenceJournal.test.ts`.

## Signal vs. Authority

Every new surface is SIGNAL, never authority. The union read injects a peer's knowledge
source as ADVISORY quoted-untrusted-data and NEVER blocks on an open conflict (fork #3). The
flag-coherence gate only decides whether to forward a kind to a peer — it never gates a
user action. The replication emit is best-effort and can NEVER break a local knowledge write
(a throwing emitter is swallowed; the durable on-disk catalog is already persisted). A
replicated record never clobbers a divergent local record.

## Blast radius / risk

- **Dark by default.** With `stateSync.knowledge.enabled` false (the shipped default), the
  KnowledgeManager emit seam is never injected (server.ts does not yet wire a journal-backed
  emitter — that is a later rollout stage, mirroring WS2.2/WS2.3), so `ingest()`/`remove()`
  are byte-identical to today. A single-machine install is a strict no-op.
- **Metadata-only scope.** Only the catalog metadata crosses the wire — never the markdown
  file body, never the local id, never the local filePath. Full-content-body sync is a
  tracked follow-up (CMT-1416), the same boundary pattern WS2.3 used for user-registry.
- **No new HTTP routes.** The knowledge-record kind rides the existing shared
  `/state/conflicts`, `/state/resolve-conflict`, `/state/quarantine` foundation routes.
- **CoherenceJournal kind addition is additive** — readers ignore unknown kinds; an old
  peer never pulls a kind absent from its own JOURNAL_KINDS (nothing requested ⇒ nothing
  dropped). The four exhaustive Record<JournalKind,…> initializers were all updated (a
  missing key is a tsc error, which passes).
- **Migration parity**: the config default is backfilled to existing agents via
  applyDefaults; the CLAUDE.md sub-line via an idempotent migrator branch guarded by the
  unique `Knowledge base is the THIRD memory-family store` marker.

## Rollback

Set `multiMachine.stateSync.knowledge.enabled: false` (the default) — fully inert. To
un-merge a peer's contributed namespace, disable the flag for that origin (RollbackUnmerge
quarantine-aside drops the `knowledge-record` namespace, zero dangling conflictId refs). No
destructive deletion. Reverting the PR removes the kind entirely (additive — no data
migration needed since nothing ships enabled).

## Tracked follow-ups

`<!-- tracked: CMT-1416 -->` — WS2.4 full-content-body sync (beyond catalog metadata), plus
WS2.5 (evolution) / WS2.6 (playbook), reduce to schema+projection+flag on this same proven
machinery. The journal-backed emitter injection in server.ts (turning the KnowledgeManager
seam live) is the next rollout stage, mirroring where WS2.2/WS2.3 stand.
