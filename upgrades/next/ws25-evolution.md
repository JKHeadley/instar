# WS2.5 — the evolution action queue becomes the FOURTH memory-family replicated store on the HLC foundation

<!-- bump: patch -->

<!--
  NOTE: internal substrate, dark by default (multiMachine.stateSync.evolutionActions,
  enabled:false + dryRun:true). The change touches runtime src/ (a new core module,
  dual-registry wiring, the EvolutionManager emit seam, server wiring, migration +
  awareness), so the tests/docs-only lane does not apply. The user-facing sections
  honestly state the capability and that it only becomes real once an operator flips
  the switch.
-->

## What Changed

The **evolution action queue is now the FIFTH concrete consumer of the HLC replicated-store foundation and the FOURTH memory-family kind** (after WS2.4 knowledge, WS2.2 learnings, and WS2.3 relationships) — `evolution-action-record` rides the foundation primitives (envelope / union-reader / conflict-store / rollback-unmerge / bounds) so a self-improvement action the agent raised on one machine is known on the others. It REUSES the WS2.4 machinery rather than reinventing it. Per `docs/specs/multi-machine-replicated-store-foundation.md`.

- **The `evolution-action-record` replicated kind** (`src/core/EvolutionActionsReplicatedStore.ts`) — a STRICT typed schema that is a **discriminated union on `op`** (a value schema AND a delete-tombstone schema coexist under one kind) and **type-clamps every known field on receive** (`createdAt`/`dueBy`/`completedAt` are ISO-8601-or-absent, `priority` is one of {critical, high, medium, low}, `status` is one of {pending, in_progress, completed, cancelled}, `tags[]`/free text are length-clamped, a path-shaped `source` sub-field is jailed out — so a foreign, attacker-controlled record can't smuggle markup through a render slot). The **disclosure-minimized projection** strips the local `ACT-NNN` id (the cross-machine-unstable id). The cross-machine `recordKey` is a **content fingerprint** — `sha256(normalize(title) + normalize(commitTo) + createdAt)` — so the SAME committed action on two machines collapses to ONE record instead of duplicating. **`status` is the load-bearing field**: `status`/`priority`/`completedAt` are mutable (last-writer-witness wins; a concurrent divergence rides the SAME append-both-and-flag path, no CRDT special-case), and a status change RE-EMITS so a peer SEES an action was already completed/in_progress elsewhere and does not redo the work. A `completed`/`cancelled` action is a TERMINAL state whose record is RETAINED (history), NOT tombstoned — only an actual queue-REMOVAL tombstones. The per-entry cap is **raised to 64KB** so a fat description replicates instead of wedging the stream; a record still over-cap after projection is a NAMED rejection, never a silent truncate. HIGH impact tier at the **replication** layer (append-both-and-flag, never a silent clobber) but **advisory** at the **read** layer (both variants of an open conflict surface as guidance hints — an action is a work item to surface, not authority — the read never blocks).
- **DUAL REGISTRY** — `evolution-action-record` is registered in BOTH `JOURNAL_KINDS` (`CoherenceJournal.ts` — the static serve/apply/advert half, with a `DEFAULT_RETENTION` entry that is never `rotateKeep:0` for compliance) AND `ReplicatedKindRegistry` (the dynamic half). A kind in only one silently replicates nothing; the coupling test asserts it.
- **Emit-on-write funnel + tombstones** — `EvolutionManager` gains an injected (dark-by-default) `EvolutionActionReplicationEmitter` seam; `saveActions()` (the single funnel both `addAction` and `updateAction` route through) re-emits a `put` per surviving action so a STATUS CHANGE re-emits, and emits an `op:'delete'` **tombstone** per action actually REMOVED over `maxActions` (else a peer re-replicates a locally-removed action forever — resurrection). The emit is best-effort: a throwing emitter never breaks the local write.
- **Read-only neutralized union** — the merged read resolves THROUGH the bypass-proof `ReplicatedStoreReader` and renders each foreign action inside a `<replicated-untrusted-data origin="…">` envelope (quoted advisory work-item, never an instruction). A replicated record never clobbers a divergent local one.
- **Config + advert + awareness + migration** — `multiMachine.stateSync.evolutionActions { enabled:false, dryRun:true }` added to ConfigDefaults (classified in `DARK_GATE_EXCLUSIONS`; the dark-gate line-map recomputed; `applyDefaults` backfills existing agents); the `stateSyncReceive` advert self-reports `evolutionActions` from the registry; the "One Memory" CLAUDE.md section gains a WS2.5 line in both `generateClaudeMd` and an idempotent `migrateClaudeMd` splicer.
- **Slice** — this PR builds `evolution-action-record` ONLY. The playbook memory-family kind (WS2.6) is an architectural mismatch (a Python-script-written manifest with no TS emit-seam) and is a tracked follow-up.

Pure MECHANISM, dark by default. A single-machine / flag-off agent is a strict no-op (no action ever crosses a machine boundary while dark).

## What to Tell Your User

None while dark — internal substrate. The user-visible capability — an action I committed to on one machine follows you to your others, collapsing the same action by its content instead of duplicating it, and crucially letting a peer machine see that an action was already finished so it does not redo the work — becomes real only when an operator turns on cross-machine action-queue replication. That awareness ships in the One Memory section of my project notes so I can honestly answer whether your action items and commitments follow you across machines.

## Summary of New Capabilities

None user-facing while dark. New internal module `EvolutionActionsReplicatedStore.ts`; `EvolutionManager` gains an injected (dark) action-replication emit seam. No new routes (the foundation `/state/conflicts` · `/state/resolve-conflict` · `/state/quarantine` surface is reused).

## Evidence

- `tests/unit/EvolutionActionsReplicatedStore.test.ts` — dual-registry coupling; recordKey identity derivation (content fingerprint over title + commitTo + createdAt, NEVER the local ACT id; same action collapses across machines/formatting; status/priority deliberately excluded so a status change keeps the SAME key; collision-resistant + a `\x1f` field-straddle guard); disclosure-minimized projection (no local id, no extra field); `fat-record-replicates` + `fat-record-does-not-wedge-stream`; `foreign-record-type-clamped` (ISO-8601 / enum / array clamps + source-jail reject smuggled markup); `tombstone-coexists-with-value` + `TERMINAL-IS-NOT-A-DELETE` + delete-resurrection guard; the advisory append-both union merge (completed vs in_progress); foreign-record render safety. Green.
- `tests/unit/evolution-manager-action-replication.test.ts` — dark no-op; emit-on-add; **STATUS-CHANGE RE-EMITS**; **TERMINAL-IS-NOT-A-DELETE**; **PRUNE EMITS TOMBSTONE** (no resurrection); a throwing emitter never breaks the local write; detach returns to no-op. Green.
- `tests/unit/ws25-evolution-actions-wiring.test.ts` — dual-registry + server.ts registration/union-reader wiring + EvolutionManager emit seam + ConfigDefaults dark default + dev-gate exclusion + the awareness section + §12 union-reader-cannot-be-bypassed. Green.
- `tests/integration/ws25-evolution-actions-emit.test.ts` — the emit-on-mutation contract with a real AgentServer (addAction fires the put funnel keyed on the fingerprint; updateAction re-fires the put with the new status; the shared /state/conflicts substrate is alive). Green.
- `tests/e2e/ws25-evolution-actions-alive.test.ts` — the Phase-1 "feature is alive" E2E: enabled = an action-record conflict (completed vs in_progress) is open + readable + resolvable over HTTP (200); disabled = 503; routes require Bearer auth. Green.
