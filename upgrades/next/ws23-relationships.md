# WS2.3 — relationships become the FIRST PII replicated store on the HLC foundation

<!-- bump: patch -->

<!--
  NOTE: internal substrate, dark by default (multiMachine.stateSync.relationships,
  enabled:false + dryRun:true). The change touches runtime src/ (a new core module,
  dual-registry wiring, the RelationshipManager emit/peer-read seams, server wiring,
  migration + awareness), so the tests/docs-only lane does not apply. The user-facing
  sections honestly state the capability — and its at-rest PII honesty — and that it
  only becomes real once an operator flips the flag.
-->

## What Changed

The **relationship registry is now the SECOND concrete consumer of the HLC replicated-store foundation and the FIRST PII kind** — `relationship-record` rides the foundation primitives (envelope / union-reader / conflict-store / rollback-unmerge / bounds) so a person the agent knows on one machine is known on the others. Per `docs/specs/ws23-relationships-userregistry-security.md` (§5 merge semantics, §4.2 tombstones, §4.3 right-to-erasure, §7 tests).

- **The `relationship-record` replicated kind** (`src/core/RelationshipsReplicatedStore.ts`) — a STRICT typed schema that is a **discriminated union on `op`** (a value schema AND a delete-tombstone schema coexist under one kind, REQ-D6) and **type-clamps every known field on receive** (`firstInteraction`/`lastInteraction` are ISO-8601-only, `interactionCount`/`significance` are finite numbers, free text is length-clamped — so a foreign, attacker-controlled record can't smuggle markup through a render slot that bypasses `sanitize()`, REQ-M3 gap #4/#8). The **disclosure-minimized projection** (REQ-M4) emits ONLY the enumerated resolution + merge-relevant fields — never the raw on-disk blob and never the local UUID `id`. The cross-machine `recordKey` is the **channel-set identity surface** (REQ-D17), derived deterministically from a person's sorted channel-uids, so the same human reaches the same record across machines even though each mints its own UUID. The per-entry cap is **raised to 64KB** for this PII kind (REQ-M3 gap #10) so a fat relationship replicates instead of wedging the stream; a record still over-cap after projection is a NAMED rejection, never a silent truncate. HIGH impact tier (append-both-and-flag, never a silent clobber of two divergent people).
- **DUAL REGISTRY** — `relationship-record` is registered in BOTH `JOURNAL_KINDS` (`CoherenceJournal.ts` — the static serve/apply/advert half, with a `DEFAULT_RETENTION` entry that is never `rotateKeep:0` for compliance) AND `ReplicatedKindRegistry` (the dynamic half). A kind in only one silently replicates nothing; the CI ratchet asserts the coupling.
- **Emit-on-mutation funnel + tombstones** — `RelationshipManager` routes every persistence mutation through its single `save()` funnel and every deletion through `delete()`/`mergeRelationships()`; an injected (dark-by-default) replication emitter emits a `put` on save and a channel-keyed `op:'delete'` **tombstone** on delete (so an erased person stays erased even on a machine that was offline at delete time, REQ-D4/§4.3). `mergeRelationships` emits a coherent put(survivor)+delete(merged) pair whose recordKeys are DISTINCT — no dangling tombstone, no replication loop.
- **Read-only neutralized union** — the peer-read surface ("what do my OTHER machines know about this person") resolves THROUGH the bypass-proof `ReplicatedStoreReader` and renders each foreign record inside a `<replicated-untrusted-data origin="…">` envelope (quoted data, never an instruction). It is DISTINCT from the local-authoritative `resolveByChannel`/`getContextForPerson` — identity RESOLUTION of an inbound principal stays local-only (REQ-M14).
- **Config + advert + awareness + migration** — `multiMachine.stateSync.relationships { enabled:false, dryRun:true }` added to ConfigDefaults (classified in `DARK_GATE_EXCLUSIONS`; the dark-gate line-map recomputed by hand; `applyDefaults` backfills existing agents); the `stateSyncReceive` advert self-reports `relationships` from the registry; the "One Memory" CLAUDE.md section gains a WS2.3 PII line (with the at-rest honesty note) in both `generateClaudeMd` and an idempotent `migrateClaudeMd` splicer (framework shadow markers already cover the section).
- **Slice** — this PR builds `relationship-record` ONLY. `user-registry` + `topic-operator` (the spec's other two PII kinds) reduce to "add schema + projection + flag" on this proven machinery and are a tracked follow-up (CMT-1416).

Pure MECHANISM, dark by default. A single-machine / flag-off agent is a strict no-op (no PII ever crosses a machine boundary while dark).

## What to Tell Your User

None while dark — internal substrate. The user-visible capability — a person I know on one machine is known on your others — becomes real only when an operator turns on cross-machine relationship replication, and it carries an **honest at-rest trade**: while on, every machine in the pool (including any cloud VM the operator rents but doesn't physically control) keeps a plaintext copy of everyone the agent knows under that machine's filesystem permissions, NOT the encrypted vault (the connection between machines IS encrypted, so nobody reads it in transit). That honesty ships in the CLAUDE.md "One Memory" section so the agent surfaces it the moment a user asks "is my contact data shared / encrypted on the other machine?".

## Summary of New Capabilities

None user-facing while dark. New internal module `RelationshipsReplicatedStore.ts`; `RelationshipManager` gains injected (dark) replication-emit + union-read seams. No new routes (the foundation `/state/conflicts` · `/state/resolve-conflict` · `/state/quarantine` surface is reused).

## Evidence

- `tests/unit/RelationshipsReplicatedStore.test.ts` (35) — dual-registry coupling; recordKey identity derivation (no split identity, no stranger-collision, not the UUID); disclosure-minimization (no local id, no extra field); `fat-record-replicates` + `fat-record-does-not-wedge-stream`; `foreign-record-type-clamped` (ISO-8601 / finite-number clamps reject smuggled markup; unknown field dropped; freetext clamped); `tombstone-coexists-with-value` (the op:'delete' schema branch); the HIGH-impact append-both union merge; foreign-record render safety. Green.
- `tests/unit/relationship-replication-emit.test.ts` (6) — emit-on-every-mutation; DARK no-op; delete emits a channel-keyed tombstone; `mergeRelationships` put+delete coherence (distinct recordKeys); a throwing emitter never breaks the local write. Green.
- `tests/unit/relationship-union-read.test.ts` (5) — through the REAL `ReplicatedStoreReader`: union-reader-cannot-be-bypassed (disabled = no-op); append-both; `erasure-reaches-offline-peer` (tombstone wins over a stale value); post-unmerge zero-dangling. Green.
- `tests/unit/ws23-relationships-wiring.test.ts` (9) — dual-registry + server.ts registration/union-reader/peer-read-seam wiring + ConfigDefaults dark default + the awareness section. Green.
- `tests/integration/ws23-relationships-routes.test.ts` (3) — the relationship routes still work with the replication funnel attached; a route-driven DELETE fires the channel-keyed tombstone through the funnel. Green.
- `tests/e2e/ws23-relationships-alive.test.ts` (3, Phase 1) — the WS2.3 path is ALIVE on the real AgentServer boot path with the REAL relationship-record schema registered: an enabled relationship-record conflict is open + readable + resolvable over HTTP (200), disabled returns 503, Bearer auth required. Green.
