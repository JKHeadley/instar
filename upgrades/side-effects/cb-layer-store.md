# Side-Effects Review — Context Budget layer store and transcript archive (Phase 1 S1)

**Version / slug:** `cb-layer-store`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2 (independent review of the diff; see below)`

## Summary of the change

Phase 1, slice S1 of `docs/specs/context-budget-layered-summaries.md` (§9.7, §6 author/as-of, §12 archive retention, §14 small-layers row). It adds the storage that every later Phase 1 layer writer uses.

New files:

- `src/monitoring/contextLayers/LayerStore.ts` is the per-topic store under `state/context-layers/<topic>/<type>/<entry>.json`.
  - Derived projections (H1–H3, chunk, C2, u-stub, probe) are scrubbed per string field: `scrubForStore`, then a live-value pass.
  - Protected records (anchor, ledger-entry, u) are row references only, as `(messageId, sha256, length)`. A text-shaped field is refused.
  - Every record carries `author` and `asOf`. It is offered to the replicated `context-layer-record` kind through a seam.
- `src/monitoring/contextLayers/TranscriptArchive.ts` writes gzipped span files under `state/context-archive/<topic>/spans/`, plus an index by entry id and message id.
  - Spans are deduplicated by entry id and written once.
  - Scrubbing is per entry per field on write and again on every read.
  - Eviction planning goes superseded-first, then oldest, never touching protected spans. An evicted span keeps its index row and reads `raw-evicted`.
- `src/monitoring/contextLayers/liveSecrets.ts` is the agent's live secret values. It is extracted from the PostCompact route, which now uses it.
- `src/monitoring/contextLayers/contextLayersBoot.ts` handles the gate, the construction (both roots created 0700 at boot), the replication adapter onto `ReplicatedRecordEmitter`, status, and feature evidence.
- `src/monitoring/diskSteward/pruneContextArchive.ts` is the Disk Steward category `context-archive`.

Modified files:

- `BackupManager.ts`:
  - `state/context-layers/` and `topic-memory.db*` join the defaults. They are gated at snapshot time by `contextBudget.enabled`, read from the agent's config through the dev-agent gate.
  - New never-backup segments: `fold-hold.json`, `_fold-markers`, `_clear-seed`, `_seeded`.
- `pruneCategories.ts`: the `CategoryId` union.
- `diskStewardMain.ts`: runs the new category.
- `DiskStewardPoster.ts`: label.
- `devGatedFeatures.ts`: `contextBudget.enabled`.
- `feature-ladders.json`: `contextBudget.layers`.
- `server.ts`: construction.
- `AgentServer.ts` and `routes.ts`: `contextLayers` in the route context and `GET /context-budget/layers`.
- `CapabilityIndex.ts`: endpoint listing.

## Decision-point inventory

- **Disk Steward `context-archive` eviction** (add). It deletes archived transcript spans when the archive exceeds its limit.
  - Deterministic: a size threshold plus an ordering.
  - The floor is "never a span the current phase points at", read again right before each removal.
  - This is the spec's §12 "Archive retention" judgment-candidate at its floor. The forecast-driven judgment is not built here (see 4b).
- **Backup inclusion gate** (add). The layer store and `topic-memory.db*` are included only while `contextBudget.enabled` resolves true.
- **Never-backup segments** (modify). Four more unconditional exclusions.
- **Protected-record text refusal** (add). A write-side invariant check on this module's own API, not a gate on any message or session.
- No message, session, egress or inbound decision is touched.

---

## 1. Over-block

- **Archive eviction.** It can remove a span that a later lookup (`/topic/:id/transcript`, a later slice) would have wanted. That is the designed retention trade under disk pressure. The chunk keeps its summary and reads `raw-evicted`, so nothing is silently lost. The limit (2 GiB default) is per agent and only applies when exceeded.
- **Protected-text refusal.** It refuses a protected record whose `data` has a key named `text`, `body`, `quote`, `content` or `message`. A later writer that wants to store, say, a derived `message` label on a ledger entry must name it differently. This is deliberate: the operator's words are never copied into the store (§9.7).
- **Backup gate.** An agent with the layers off does not get `topic-memory.db` in its backups, which is today's behaviour. No regression.

## 2. Under-block

- **Live-value pass.** It only catches secrets the agent knows about: auth token, PIN, lifeline secret and secret-store values of 12 characters or more. A third-party secret in tool output that matches no shape pattern still lands, scrubbed only by shape. The spec accepts this (§9.7). The archive is never served, backed up or replicated, which bounds the exposure.
- **PIN-sized values.** These are below the 12-character minimum, so a 6-digit PIN is not substring-scrubbed. Scrubbing every 6-digit run would destroy ordinary text.
- **`currentPhaseSpans`.** It reads H2 `spanIds` and open chunks. Until S8 and S9 write those fields, no span is protected by phase. Nothing writes archive spans until S8 either, so the gap is empty in practice.

## 3. Level-of-abstraction fit

This is storage plus one retention executor. Correct layering:

- It reuses the existing primitives (`scrubForStore`, `redactLiveValues`, `contextLayersRoot` and `contextArchiveRoot` from Phase 0, `buildContextLayerPut`, `ReplicatedRecordEmitter`, Disk Steward's prune child) rather than re-implementing them.
- Eviction runs inside the Disk Steward prune child, never on the server's event loop, alongside the existing two categories.

## 4. Signal vs authority compliance

- The store holds no authority over agent behaviour. It records.
- The only authority added is the retention eviction, which deletes only derived, reconstructable-or-lost archive bytes the spec declares evictable, under a deterministic floor. It does not decide anything about a message, a session or a user.
- Not a brittle check with blocking authority.

## 4b. Judgment-point check

- **Archive retention** is listed in §12 as a judgment-candidate ("floor: never evict a span a chunk points at while the phase is current"; owner Disk Steward).
- This slice builds the floor and a deterministic size trigger. The competing signals (forecast, topic activity) are not yet available: no chunks exist before S8.
- The executor is shaped so a judgment can replace the size trigger without moving the floor.
- No static heuristic is placed at a point where competing live signals exist today.

## 5. Interactions

- **PostCompact route.** It now calls the shared `collectAgentLiveSecrets`. Behaviour is identical: same sources, same order, same best-effort catches.
- **Backup.** The new never-backup segments apply to every snapshot. `_seeded`, `_clear-seed` and `_fold-markers` are transient carriers whose resurrection would mislabel or re-seed a session. `fold-hold.json` would mute a conversation for a fold that ended. Restores are re-filtered by the same deny list.
- **Disk Steward.** The new category runs after the caches lock is released and does not take it, because the archive is this agent's own state. The poster labels it. Earlier result files without the category remain readable.
- **Replication.** The emitter is the same one every other store uses, gated by `multiMachine.stateSync.contextLayers` (dark). The replication outcome is returned to the writer and counted. The local write never waits on or fails with replication.
- **Fold coordinator.** `layerKindPresent` is unaffected. Nothing here begins a fold.

## 6. External surfaces

- **New route `GET /context-budget/layers`.** Bearer-authenticated like every other route. It is read-only and returns local filesystem paths, which is the same exposure as `/context-budget/sentinel` and other state routes. 503 when off.
- **Capability index.** The `contextBudget` row lists the endpoint.
- **Backups.** With the layers on, backups grow by `topic-memory.db*` (the conversation history, which already existed on disk) and the small layer files.
- **Disk Steward.** Posts may name "old conversation transcripts".
- **Timing.** Nothing depends on conversation timing.

## 6b. Operator-surface quality

Not applicable. No dashboard renderer, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Small layers: unified.** Replicated through the `context-layer-record` kind via the existing `ReplicatedRecordEmitter`, gated by `multiMachine.stateSync.contextLayers`. Each machine writes only its own stream (single origin). U bodies and probe records never replicate: U bodies re-derive from rows (§14), and probes are local.
- **Transcript archive: machine-local by design.** `machine-local-justification: proxied-on-read` (§14 "Transcript archive (raw spans)"): spans stay on the machine whose session produced them. The proxied read route is a later slice.
- **Status surfaces.** `GET /context-budget/layers` is per machine and reports this machine's roots. A pool view is not added here; the dashboard card slice aggregates.
- **Durable state on topic transfer.** Layer records travel by replication when on. Archive spans stay where they were written and are reached by the proxied read.
- **URLs.** No generated URLs.

## 8. Rollback cost

- Set `contextBudget.enabled: false` (or leave it omitted on a fleet agent). Nothing is constructed at the next restart, the route returns 503, backups stop carrying the store, and the stored files are inert.
- A release revert removes the modules. The files on disk are under gitignored `.instar/state/` and harm nothing.
- The never-backup additions are safe to keep either way.
- No data migration is needed.

## Conclusion

S1 lands the store, archive, retention executor and backup posture with the spec's permissions and scrub rules, behind a dev-gated switch, with no message or session decision touched. Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

**Independent read of the artifact:** concur.

The review found no blocking defect, since nothing writes yet. It listed six should-fix items and several nits, and every should-fix item is fixed in this commit:

1. **Eviction floor.** The floor now reads each record's own `status` and its `spanIds`. Span ids live outside the scrubbed data and are validated to the span-id shape. A topic with no readable H2 or chunk record has an unknown floor and is skipped, not treated as unprotected.
2. **Archive index races.** Every index read-modify-write now takes a cross-process `index.lock`: an O_EXCL file, broken when older than 30 s, waited on for at most 2 s. An unreadable index is never replaced (`index-unreadable`). A span file already on disk is never overwritten (`exists`). Eviction marks the index before removing the bytes.
3. **Free text in protected records.** Protected-record data is allowlisted to scalars and identifier-shaped strings at every depth and under every key. Free text is refused wherever it appears.
4. **Deep nesting.** A derived subtree nested past the depth bound becomes `[REDACTED:too-deep]` rather than being stored unscrubbed.
5. **Read-time scrub.** Archive metadata is scrubbed again on read. A corrupt span reads as null.
6. **Secret-store reads.** Live secrets are cached for 60 s. An unreadable secret store writes a feature-evidence error row.

Nits taken:
- Topic keys may not start with `_`, so they cannot collide with the carrier directories.
- `unconfirmed` gets its own counter.
- `ensureDir` refuses a symlinked directory.

Nits recorded rather than built:
- The archive limit is a fixed default of 2 GiB with no config plumbing or forecast row. The forecast-driven judgment arrives with the chunks that give it signal. <!-- tracked: CMT-1536 -->
- `checkpoints/` under the archive root keeps its own sentinel grace pass, which is unchanged.
- A restore of `topic-memory.db*` with a stale `-wal` beside it is a backup-manager behaviour for every SQLite glob, not one this slice introduces. <!-- tracked: CMT-1536 -->

## Evidence pointers

- Unit: `tests/unit/context-layer-store.test.ts`, 23 tests: modes, per-field scrub and live value, oversize pointer, protected refusal, row-ref identity, replication seam (emitted, oversize, not-replicated, throw), archive dedupe, re-scrub on read, eviction order and floor, prune category, backup gate and segments, dev gate.
- Integration: `tests/integration/context-layer-store.test.ts`, 5 tests: real emitter, journal, applier and peer reader across two machines; dark flag; route 503/200; File Viewer refusal.
- E2E: `tests/e2e/context-layer-store-alive.test.ts`, 6 tests: dev live and fleet dark on the production gate, explicit false, prune child category, backup, and WIRED source checks.

## Class-Closure Declaration (display-only mirror)

Not a defect fix. Class `n/a`, closure `n/a`.

## Addendum: CI follow-up
- `tests/unit/context-layer-kind.test.ts` (Phase 0's DARK check) now names the layer store as the one sanctioned emitter. That emitter only emits through the stateSync-gated `ReplicatedRecordEmitter`.
- Documented `GET /context-budget/layers` and `GET /context-budget/sentinel` in `site/src/content/docs/features/memory.md` (docs-coverage route floor).
