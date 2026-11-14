# Side-effects review — the replicated context layer kind

**Version / slug:** `cb-layer-kind`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §14 row "Small layers A, G (per entry), C (open and current-phase), C2, H1–H3, U referent stubs, fold records and sidecars, backoff and breaker state, fold holds" ("a new replicated kind registered in both `JOURNAL_KINDS` and `ReplicatedKindRegistry`; the kind's bounds type gains `maxRecordBytes` and `liveSetBudget` … caps derived from the journal constants (default applier cap 8 KB, per-kind raise to 64 KB, 80 KB wire), enforced as refuse-never-truncate only on content records (a fold record is state and pointers and is never size-refusable …), a live-set budget sized in Phase 1 …, unique record keys per entry with status changes re-emitting the record (HLC-latest compaction), and the skew rule: a holder on a version without the kind refuses the fold (`fold-path-unavailable: layers-not-replicated`)"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 9, part b; stacked on 9a.
**Tier:** 2 (adds a replicated journal kind — a cross-machine wire surface). Size: ~4 source files touched + 1 new, ~330 LOC incl. ~250 test LOC.

## Summary of the change

1. **`src/monitoring/contextLayerKind.ts`** (new): `CONTEXT_LAYER_RECORD_KIND = 'context-layer-record'`, store `contextLayers`; record types `anchor | ledger-entry | chunk | c2 | h1 | h2 | h3 | u-stub | fold-record | fold-sidecar | fold-hold | fold-backoff | fold-breaker`; `CONTEXT_LAYER_KIND_BOUNDS` (`maxRecordBytes`: default = `DEFAULT_MAX_ENTRY_BYTES` (8 KB), 64 KB for `h3` and `fold-sidecar`, asserted at load to leave 8 KB of envelope room under `REPLICATED_RECORD_MAX_ENTRY_BYTES` (80 KB); a body is measured by its JSON-ESCAPED UTF-8 size, what the journal line carries; `liveSetBudget: null` until Phase 1); a `StoreFieldSchema` that validates every field (safe ids, entry key charset, fold state enum, non-negative safe-integer counters) and REFUSES an oversize content body, while state records (`fold-record`, `fold-hold`, `fold-backoff`, `fold-breaker`) are never size-refused (a stray body is dropped and counted); the record key is BOUND to the fields (`<topic>:<type>:<entryKey>` for every put and for a tombstone that names its entry); **forward compatible**: a well-formed record type or fold state from a later build is accepted on receive under the default cap, so adding one never stalls a peer still on this build, and readers must ignore what they do not know. `buildContextLayerPut` writes only known types and states, refuses an oversize body (`oversize`), refuses a field the schema would drop or the envelope would jail (`invalid`), and builds the record from the VALIDATED fields only; the journal's emit outcome stays the authority for the writer. `:` rather than `/` because the envelope jails path-shaped keys (the integration test caught this: the first draft's `/` keys were refused by the real journal).
2. **`src/core/CoherenceJournal.ts`**: the kind joins the union, `JOURNAL_KINDS`, and every per-kind map; retention `{ maxFileBytes: 8 MiB, rotateKeep: 8 }` — FINITE by design (spec §3: "the replicated journal has finite per-kind retention"). Rotation prunes by file age, not by key, so the Phase 1 layer store must re-emit every live record on rotation (comment at the retention entry). <!-- tracked: CMT-1536 (Phase 1: layer store re-emits every live context-layer record on rotation) -->
3. **`src/core/JournalSyncApplier.ts`**: the kind maps to `multiMachine.stateSync.contextLayers` (the evidence path for a switched-off sync feature).
4. **`src/core/ReplicatedStoreReconcilerWiring.ts`**: `contextLayers` allowlisted with its single-writer reason.
5. **`src/commands/server.ts`**: registers `CONTEXT_LAYER_KIND_REGISTRATION` beside the Chief of Staff kind, and the fold coordinator's `layerKindPresent` is now `replicatedKindRegistry.isReplicatedKind('context-layer-record')` (was absent ⇒ false). `foldCoordinatorBoot.ts` doc updated.

**Phase 0 posture:** registration is inert — nothing emits to the kind (a DARK test walks `src/` for any emit or builder call). The fold still cannot begin: the sentinel heartbeat precondition stays false until task 10.

## Decision-point inventory

- **Changed:** the fold coordinator's skew precondition (`layerKindPresent`) now reads true on this build. It is one of several AND-ed preconditions; `sentinelHeartbeatFresh` is still false in Phase 0, so no fold begins.
- **Added:** refuse-oversize at emit/receive for content records — a schema validity check on a new kind, no authority over any existing flow.

## 1. Over-block

- A content record over its cap is refused, by design (§14). The layer writer (Phase 1) must rebuild an oversize H3 under a tighter C2 selection with disclosure, and chunk a long G body into blobs (§14 "Ledger entry bodies"). Nothing writes yet.
- Entry keys are limited to `[A-Za-z0-9_.:-]{1,256}`; topic and fold ids to `[A-Za-z0-9_-]{1,128}`. Telegram topic keys and generated fold ids fit; a channel-neutral topic key with other characters (Phase 1) must be encoded.

## 2. Under-block

- The rate cap is the journal's shared per-kind token bucket; a fold that writes many chunks at once could hit it. Sizing it from measured fold bursts is part of the Phase 1 layer store, where the first writes happen. <!-- tracked: CMT-1536 (Phase 1: size the context-layer-record rate cap from measured fold bursts) -->
- `liveSetBudget` is `null` (no live-set cap) until Phase 1 measures G/C growth, as the spec says. <!-- tracked: CMT-1536 (Phase 1: size liveSetBudget from measured G/C growth) -->
- `status` is any safe name (`[a-z][a-z0-9_-]{0,63}`); statuses differ by record type and the layer store owns the per-type enum.
- Forward compatibility accepts unknown well-formed types and fold states on receive; a reader that does not ignore them would misread a later build's records. Every reader is Phase 1 code and the rule is in the module header. <!-- tracked: CMT-1536 (Phase 1: every context-layer reader ignores unknown record types and fold states) -->

## 3. Level-of-abstraction fit

Same shape as every other replicated kind (Chief of Staff, topic pins): a schema module plus the dual registry. The skew rule reads the registry, the single source of "this build has the kind".

## 4. Signal vs authority compliance

No new authority. The schema refuses invalid records of its own kind only.

## 5. Interactions

- **Older peers:** a peer on a build without the kind never registers it and never syncs it (additive kind; no unknown-field surface on any stream it consumes). On such a peer the fold is refused (`layers-not-replicated`) — the skew rule, tested in e2e.
- **Peers on this build meeting a later build:** every build with the kind pulls and validates its stream regardless of the `contextLayers` flag, and one refused entry stalls the stream. The schema therefore accepts later-build types and states (tested through the real applier); new fields were already tolerated.
- **Backups / file viewer:** the journal directory's existing handling applies; no new path.

## 6. External surfaces

A new replicated stream name on the mesh, inert until something emits.

## 7. Multi-machine posture

Replicated by design (this IS the replication path for the small layers, §14), through the CoherenceJournal + JournalSyncApplier, with HLC-latest per record key. Integration test: A emits every record type (incl. a 60 KB H3), B applies A's stream through the real applier (7 applied, 0 invalid) and reads them back through `ReplicatedPeerStreamReader`.

## 8. Rollback cost

Revert. A peer that already holds `context-layer-record` stream files from a newer build keeps inert files; nothing reads them on the older build.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: no self-triggered action; emission (Phase 1) is bounded by the journal's rate cap and per-record caps.

## Evidence

- `tests/unit/context-layer-kind.test.ts` (15): caps derived from journal constants; at-cap accepted / one byte over refused (and a 3-byte-character case); the ESCAPED-size rule (newlines, quotes, control characters); receive-side schema refuses oversize; state records never size-refused, stray body dropped and counted, backoff/breaker counters; unsafe ids, bad entry keys, bad counters, a stateless fold record and a bodiless content record refused; key binding (mismatched or missing entry key refused); forward compatibility (later type and state accepted on receive, never written by this build); the builder refuses jailed or dropped fields and builds only validated fields; tombstones; unique per-entry keys; dual-registry wiring; registry accept / idempotent / conflict; DARK (no emitter in `src/`).
- `tests/integration/context-layer-replication.test.ts` (7): real journal round-trip of all 7 record types incl. a 60 KB H3; cross-machine apply through the real `JournalSyncApplier` and read-back by store; oversize refused at emit and never appended; the REAL reader takes the HLC-latest record even when the older HLC arrives second; a forged oversize record is refused by the real applier; a tombstone round-trips (stray body dropped); a later build's new type and fold state apply without stalling the stream; a journal without the kind refuses to emit it.
- `tests/e2e/context-layer-kind-alive.test.ts` (5): server.ts's registration statement and `layerKindPresent` expression on a real `buildFoldCoordinator`: with the kind, `begin` succeeds; without it, `layers-not-replicated`; with production's own Phase 0 dependencies a fold is still refused (`no-sentinel`); a record emitted through a real journal lands; WIRED source order check.
- Every test that enumerates journal kinds or the allowlist (24 unit files, 581 tests; 2 integration files) green; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 03:14 PST): "Concern raised."** BLOCKING: (1) the record types omitted the spec's "backoff and breaker state", and because every build with the kind strictly validates the stream, a type or fold state added later would stall and suspect-flag the stream on every machine still on this build (probe through the real applier: `invalidEntries: 1`, stream suspect, the next seq also refused). MINOR: (2) the builder measured raw bytes while the journal caps the escaped line — newline/quote-heavy bodies built ok then failed at emit; (3) the retention comment claimed per-key compaction the journal does not do, and live records that are never re-emitted age out; (4) the record key was not bound to the fields (a record keyed `999:anchor:zzz` with chunk fields was accepted); (5) the builder passed a jailed `status`, kept unknown fold-hold states that the schema then dropped, and built from raw input; (6) test gaps: receive-side oversize only as a direct schema call, HLC-latest computed by the test, no tombstone through the journal, the e2e used non-production dependencies.

**Resolution:** (1) fixed — `fold-backoff` and `fold-breaker` added as state records with `count`/`untilMs` counters, and the receive side is forward compatible (well-formed unknown types and fold states accepted under the default cap; this build never writes them; readers must ignore them, tracked to Phase 1); tested through the real applier. (2) fixed — every cap is the JSON-escaped size, the per-kind raise leaves 8 KB of envelope room, and the builder's comment now names the emit outcome as the authority (tests for newlines, quotes, control characters). (3) fixed — the comment states file-age rotation; the Phase 1 re-emit of every live record is tracked. (4) fixed — puts and entry-naming tombstones must sit at `<topic>:<type>:<entryKey>` (tests). (5) fixed — the builder refuses jailed, dropped or unknown-state fields and builds from validated fields only (tests). (6) fixed — the four integration and e2e cases listed in Evidence.

**Re-check 1 (same reviewer, 2026-11-10 03:21 PST): "Concern raised"** on one narrow gap: forward compatibility covered only a later type that looked like a small content record; a later state-like type with no body, a body over 8 KB, a non-string body, or a new `status` value that is not lowercase still stalled the stream. Everything else (escaped cap, key binding, builder strictness, retention comment, tests) confirmed fixed by probe. Minor: a tombstone with no entry key was unbound.

**Resolution:** an unknown type now takes an optional body (a string capped at the 64 KB raise; a non-string body is dropped and counted, not refused), carries a well-formed state, and `status` is any jail-safe token (`[A-Za-z0-9_.:-]{1,64}`); the header states the real contract (later builds may add content or state types, fold states and statuses; they may not change the meaning of what this build knows). A tombstone without an entry key must sit under its own `<topic>:<type>:` prefix. Unit and integration tests cover each case through the real applier (6 later-build records applied, 0 invalid, 0 suspect).

**Re-check 2 (same reviewer, 2026-11-10 03:25 PST): "Concur with the review."** The four former stalls apply cleanly through the real applier; the limits hold (unknown type over the 64 KB raise, known chunk over 8 KB, bodiless known anchor, badly named type, slash or `..` status all refused); the unnamed tombstone is bound to its own `<topic>:<type>:` prefix (a string-prefix topic is refused); the builder cannot write what it only tolerates. One harmless leftover noted: a tombstone keyed with the bare prefix and no entry part deletes a key no put can occupy.
