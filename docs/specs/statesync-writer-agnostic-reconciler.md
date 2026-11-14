---
title: "Fix: stateSync memory stores never replicate — writer-agnostic reconciler"
slug: "statesync-writer-agnostic-reconciler"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "statesync-writer-agnostic-reconciler.eli16.md"
status: "draft"
approved: true
approved-by: "CMT-1005 (feature maturation review 2026-10-25, topic 128732) authorizes this fix end-to-end via /instar-dev; standing operator direction (2026-10-22): only constitution changes need Justin's review. Operator may revoke."
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (§4 send-side emitter); docs/specs/STATESYNC-PEER-ADVERT-PROPAGATION-FIX-SPEC.md (receive adverts, verified healthy 2026-10-25); docs/specs/ws23-relationships-userregistry-security.md (PII clamps reused unchanged)"
supervision: "tier0 — a deterministic data transform with no policy decision; the only authorities it touches are the existing emitter dark gate and journal schema validation."
lessons-engaged:
  - "Fix the class, not the instance: the class is 'a file-backed replicated store with a writer that is not the server's wired manager instance' (CLI processes, per-request managers). Six stores are covered by one disk-reading reconciler; every other registered store must be listed in an allow-list with its reason (a ratchet test enforces it)."
  - "A repair implies an unfound producer: several UserManager instances save the whole users.json last-writer-wins, and EvolutionManager files are rewritten whole by more than one instance. That producer defect is tracked separately (feedback fb-9ac43374-07b); the reconciler does not AMPLIFY it — it never infers a deletion from a missing row; tombstones come only from explicit intents written by the store's own delete methods."
  - "An instrument that cannot fail has not measured anything: an emit counts as replicated only when the journal reports it accepted; the counters can disagree with reality."
  - "No Unbounded Loops / Capacity Safety: per-tick caps, per-store breaker with doubling backoff and a 24 h give-up, a post-emit fingerprint check and a duplicate-key skip for the two re-emit loops, single-flight on a chained timer; registered in SELF_ACTION_CONTROLLERS."
  - "Verify the State, Not Its Symbol: a key absent from a snapshot is NOT evidence of deletion (a lost update looks identical); a deletion is the delete method's own durable intent plus a complete read without the row."
  - "Justin warns against over-engineering (2026-09-23): the 2026-10-25 draft of this spec was 65 KB with rotation-repair byte budgets, three churn classifiers and a self-clearing config knob. This version keeps the safety core and drops machinery that guarded hypothetical cases."
dependency-gate:
  blocks: "Reuses with small additive changes: CoherenceJournal.emitReplicatedRecord (returns an outcome), ReplicatedRecordEmitter.emit (returns outcome + hlc; explicit-witness option; emit observers), ReplicatedPeerStreamReader (gains loadOwnOriginRecordsAsync), UnionReader.classifyOriginSet (identical concurrent versions collapse), KnowledgeManager.remove / RelationshipManager.delete + mergeRelationships (append a deletion intent), new buildKnowledgeTombstoneFromKey / buildRelationshipTombstoneFromKey, ConflictStore.autoResolveIdenticalContent, the six stores' build*/derive* functions, validateReplicatedEnvelope, LiveConfig.get."
  status: "SATISFIED — verified 2026-10-28 on JKHeadley/main @ v1.3.1497: CoherenceJournal.ts:881 (emitReplicatedRecord returns void; private emit :918 drops silently on locked-out / rate-limited / schema / dedupe / oversize), ReplicatedRecordEmitter.ts:140 (emit returns void), ReplicatedPeerStreamReader.ts:497 (private chunked async reader), :546 ownStreamFiles."
  enforcement: "The e2e test writes the knowledge catalog FILE directly (no manager hook) on instance A and asserts the record lands in instance B's replica stream — the reconciler, not a hook, carried it."
related-feedback: "Producer-side clobber (several UserManager instances write one users.json; EvolutionManager files rewritten whole) (feedback fb-9ac43374-07b); deletes for userRegistry / learnings / evolutionActions stay server-only until it closes (feedback fb-9ac43374-07b)."
review-convergence: "2026-10-28T19:11:24.027Z"
review-iterations: 6
review-completed-at: "2026-10-28T19:11:24.027Z"
review-report: "docs/specs/reports/statesync-writer-agnostic-reconciler-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Fix: stateSync memory stores never replicate — writer-agnostic reconciler

## Problem statement

The feature maturation review of 2026-10-25 (CMT-1005) found that
`multiMachine.stateSync.preferences`, `relationships`, `knowledge` and `userRegistry` are enabled
(`dryRun:false`) on Echo's four machines, yet the coherence journal holds zero `pref-record`,
`relationship-record`, `knowledge-record` or `user-record` entries, while `learning-record`,
`evolution-action-record` and `topic-operator-record` flow on the same machinery.

**Live trace (2026-10-25, all four machines):** receive adverts are healthy (`GET /pool` →
`seamlessnessFlags.stateSyncReceive` true for all four stores); the in-process emitters are
wired; and all four stores are **empty on every machine** (`GET /relationships` → `[]`,
`GET /permissions/users` → `[]`, preferences count 0, empty knowledge catalogs). "Never
replicated" is true because nothing was ever written.

**The real defect** is what happens once something IS written. Replication is bound to one
manager INSTANCE inside the server, and most writers live elsewhere:

| store | writers WITH an emitter | writers WITHOUT one |
|---|---|---|
| knowledge | none in practice (no HTTP ingest route) | `instar knowledge ingest` / `remove` (a separate process, `src/commands/knowledge.ts`) |
| relationships | `POST /relationships/import`, the interaction route | `instar relationship …` (`src/commands/relationship.ts`) |
| userRegistry | the long-lived Telegram/Slack `UserManager`s | `instar user add/remove`; the dashboard registration route's per-request `UserManager` |
| preferences | the correction loop (sole writer) | — |
| evolutionActions | the server's `EvolutionManager` | `instar reflect` (`ReflectionConsolidator` builds its own `EvolutionManager`) |
| learnings | the server's `EvolutionManager` | the same `ReflectionConsolidator` instance |

Knowledge can structurally never replicate today: its only ingest path is the CLI. The
server's in-memory `RelationshipManager` also never sees a CLI-written record (it loads at
construction). Every store that gains an out-of-process or per-request writer silently leaves
replication — the class this spec closes.

## Goals

- **G1.** A record that persists on disk in a covered store, whoever wrote it, appears in this
  machine's own journal stream within one reconcile interval (plus drain time under the
  per-tick cap), and so reaches every peer's replica stream. A record created and removed
  between two snapshots is not observed: this mirrors disk state; it is not a change log.
- **G2.** For relationships and knowledge, a record removed through the store's own delete
  method — in ANY process, CLI included — produces a tombstone. The delete method writes a
  **deletion intent** (§4 step 4); the reconciler never infers a deletion from absence alone,
  so a lost update, a torn read or a stale whole-file save can never become a fleet-wide
  removal. The other four stores are puts-only (§5.3).
- **G3.** No replication behaviour change where a store is dark (fleet default) or in its own `dryRun`
  (the reconciler honours a store's `dryRun`, which the emitter ignores), for any store not in
  the covered six, or for a store whose file rides git on this machine (§5.5). The one change
  every agent sees is a small deletion-intent line under `state/reconcile/intents/` when a
  relationship or knowledge source is deleted (§4 step 4).
- **G4.** No re-emission churn: an unchanged record is not re-emitted, including after an
  in-process hook emit and across a restart (the cache is seeded from the own stream).
- **G5.** No conflict for byte-identical content: concurrent versions whose store fields are
  byte-identical collapse to one value in the union (§2.1, limits in §5.10), without any emit
  claiming to have seen a peer.
- **G6.** Observable: `GET /state/reconcile` reports what the reconciler did, with counters that
  can disagree with reality (a refused emit is never counted as sent).

## Non-goals

- Making CLI processes append to the journal: the journal is single-writer per machine (a
  process lock), so a second process cannot own the own stream. Routing every CLI write
  through the server over HTTP fails when the server is down, leaves per-request managers
  unwired, and fixes writers one at a time.
- An fs-watch trigger: the stores are small and a 10-minute poll is cheap.
- Replicating knowledge file BODIES (metadata only, unchanged from WS2.4).
- **Peer READS of replicated records.** Today only the learnings union reader reads peer
  replica streams; the knowledge, evolutionActions, userRegistry and relationships union
  readers read only the local file, and preferences use the separate WS2.1 pool path. So
  for those stores a record reaches a peer's replica stream but is not yet shown by that
  peer's reads. That read-side surface is `migrating-to-unified` (feedback fb-007f5082-161), and its userRegistry part must not ship before
  userRegistry tombstones do (feedback fb-9ac43374-07b), or a CLI-removed user would
  stay visible on every peer. This spec delivers records INTO every peer's replica stream,
  which is the CMT-1005 deliverable; the awareness text (§7) says exactly that.
- Credential scrubbing of free-text fields in the builders (knowledge `url`/`summary`,
  relationship notes, learning and action text). It is a pre-existing gap of every WS2 store
  that already replicates learnings and actions today, and it is a builder-level change for
  all stores at once (feedback fb-c06f0a53-0fb). The reconciler uses the
  builders unchanged, so it neither widens nor narrows it. The one exception, preferences,
  is fixed here because the hook already contradicts its own contract (§5.7).
- Changing merge or witness semantics beyond one narrowing: byte-identical concurrent versions are
  no longer a conflict (§2). Erasing journal history or store files.

## Design

### §1 One component: `ReplicatedStoreReconciler` (`src/core/ReplicatedStoreReconciler.ts`)

Store-agnostic. It is handed, per store, a **seam**:

```ts
interface ReconcileRow {
  recordKey: string;                    // derive*RecordKey(row); a null key is counted (nullKey) and dropped by the seam
  sourceFp: string;                     // sha256(stableJson(the raw disk row)) — independent of building
  build: BuildRecordData;               // the SAME builder + options the in-process hook uses
}
interface ReconcileSnapshot {
  rows: ReconcileRow[];
  skipped: number;                      // rows seen but unparseable / rejected (malformed, filename≠id, fixture)
  present: boolean;                     // false ⇔ the store file/dir does not exist
}
interface DeletionIntent { recordKey: string; deletedAt: string; hlcFloor: HlcTimestamp | null; phase: 'pending' | 'done' } // no identity
interface ReconcileStoreSeam {
  store: string;                        // registry store key
  paths: string[];                      // the store's on-disk file(s)/dir, for the git check (§5.5)
  snapshot(): ReconcileSnapshot;        // fresh READ-ONLY disk read; corrupt/unreadable ⇒ THROW
  deletionIntents?(): DeletionIntent[]; // stores with deletes; absent ⇒ puts-only
}
```

Constructor deps (validated non-null): `emitter` (`emit`, `addEmitObserver`, `clock`),
`reader` (`loadOwnOriginRecordsAsync`), `registry`, `stores`
(the emitter's resolved `stateSync` getter), `seams`, `gitCarried: (seam) => Promise<boolean>`
(§5.5), `config: () => ReconcileConfig` (read every tick through `LiveConfig`), `attention`
(optional; raise/clear one item by `conditionKey`), `degradation` (optional), `log`, `now`,
`setTimer` (injectable for tests).

### §2 Additive substrate changes (backward compatible)

- `CoherenceJournal.emitReplicatedRecord(kind, data): JournalEmitOutcome` where
  `JournalEmitOutcome = 'accepted' | 'locked-out' | 'rate-limited' | 'schema-rejected' |
  'deduped' | 'oversize' | 'not-replicated-kind' | 'error'`. The private `emit` already has a
  branch for each; it now returns which one ran. `accepted` means enqueued for the flusher, not
  yet fsynced: a put lost at flush is re-detected at the next boot seed.
- `ReplicatedRecordEmitter.emit(store, key, build, opts?)` returns `{ outcome, hlc? }`,
  `outcome = 'emitted' | 'disabled' | 'skipped' | 'dropped:<JournalEmitOutcome>' | 'error'`
  (`emitted` ⇔ journal `accepted`). A journal seam that returns nothing (a test fake predating
  this) yields `unconfirmed`, which legacy stats count as emitted but the reconciler treats as
  transient — acceptance is never assumed without the journal saying so. New
  `opts.observed: HlcTimestamp | null` — when present it REPLACES the witness read (`null` ⇒ no
  witness, and no witness read). New `addEmitObserver(fn)`:
  `fn({ store, recordKey, op, hlc, data })` runs synchronously after every `emitted` record,
  from any caller; observer throws are caught and counted. New read-only `clock` getter (the
  reconciler fences against the SAME HLC instance). Existing callers ignore the return value.
- `ReplicatedPeerStreamReader.loadOwnOriginRecordsAsync(store)` → `Map<recordKey, { op, hlc,
  storeFields, lastPutFields? }>`: the newest record per key over ONLY this machine's own
  stream files (current + archives), through the existing chunked async reader, validating
  each entry as `materialize` does; `lastPutFields` is the newest put's fields when the newest
  record is a delete.
- `UnionReader.classifyOriginSet`: when the origin set is concurrent but every version has the
  same `op` and byte-identical store fields (`stableJson`), it is not a conflict — the HLC-max
  version is the value. Two machines holding identical content have nothing for an operator to
  resolve; a set with ANY differing version is a conflict exactly as before. This applies to
  every replicated store (strictly fewer, never more, conflicts). An identical-content conflict
  already OPEN in the ledger (recorded before this change) is resolved by the read path the next
  time the key is read: `ReplicatedStoreReader.read` calls a new
  `conflictStore.autoResolveIdenticalContent(id)` (modelled on `autoResolveForDroppedOrigin`),
  which re-checks inside the store that every recorded version has the same op and identical
  `stableJson` content (the ledger keeps only origin + HLC per version, so the caller passes the
  identical set it verified and the entry closes only when that set equals the ledger's) and then
  records `resolution: 'identical-content'` with no winner — never an `operator-*` resolution,
  because no human decided it. It returns whether it closed the entry and opens nothing; conflict
  attention items are not wired in `server.ts` today, so there is none to clear. `GET
  /state/conflicts` shows the new resolution kind.

#### §2.1 The witness a reconciler emit claims: none

`observed` claims what the author had seen when WRITING (foundation §7.2). A reconciler emit is
a write discovered after the fact by a process that never saw peer records (they live only in
the journal replica streams). The normal emit-time witness (the max HLC of every record held for
the key) could make a stale local write look sequential-after a newer peer version or a peer
tombstone, and silently win; and ANY non-empty scalar witness can do so against a differing
version from a third origin that has not arrived yet (a delayed origin below the witness). So a
reconciler emit claims nothing: `observed: null`. Every peer version is then concurrent with it.
For byte-identical content the union collapses the pair (§2 `classifyOriginSet`), so identical
copies on two machines stay one record (independent ingests usually differ in a timestamp and
still conflict, §5.10); for differing content, or a peer
tombstone, the union keeps every version and flags the conflict: this record supplies no evidence
that would let it supersede a peer version. Stated limit inherited from the foundation's scalar witness (§7.2): a peer B that
later writes with a witness covering a newer third origin can still be judged sequential-after a
reconciler record it never saw (B.observed ≥ that record's HLC); this is true of every emitter
today and is not changed here. Counted:
`emittedPuts` only (the route cannot see peer content; conflicts show on `/state/conflicts`).
It also removes the witness read, which costs a full synchronous stream scan while the witness
index is untrusted.

### §3 Fingerprint — one normaliser on both sides

`fp(data) = sha256(stableJson(validateReplicatedEnvelope(data, schema, NOOP_COUNTERS).storeFields))`.
`storeFields` excludes every reserved envelope field (`recordKey`, `hlc`, `op`, `origin`,
`observed`), so the fingerprint cannot see which HLC or witness a record carried. A no-op
counters bag is used so fingerprinting never inflates the journal's reject counters.
`stableJson` (`src/core/stableJson.ts`) is recursive key-sorted JSON. Disk side:
`fp(row.build(ZERO_HLC, origin, undefined))`; cache side: `fp` of the seed's fields or of the
observer's `data`. A row whose build
throws or whose validation fails is `invalid`, keyed by its `sourceFp` (a hash of the raw disk row,
computed by the seam without building), and re-tried only when the disk row changes.

Unit tests pin, per store: fp equal across two HLCs and `observed` values, and
`fp(data) === fp(validated data)` (validation idempotent).

### §4 The tick

One map per store, `latest: Map<key, Entry>`, `Entry = { op: 'put'|'delete', hlc, fp?,
fpAtDelete? }` — the newest own record per key, puts AND tombstones. **One
install rule for every source** (seed, observer): a candidate replaces the entry only if
`HybridLogicalClock.compare(candidate.hlc, entry.hlc) > 0`; a delete keeps the prior put's fp as
`fpAtDelete` (from the observer's previous entry, or the seed's `lastPutFields`). Other state:
`seeded`, `invalid: Map<key, sourceFp>`, `suppressed: Set<key>`, `failures`, `breakerUntil`,
`parked`, `breakerCapSince`. Memory: one small entry per key.

Scheduling: a chained `setTimeout` (never `setInterval`) — the next tick is scheduled only
after the current one settles; first tick 90 s after start; then `intervalMs` (default
600 000, minimum 60 000), or 60 s while a store has puts or tombstones left over from the cap.
A tick running longer than 5 minutes writes one degradation row and keeps its lock until it
settles. Stores are processed one at a time with a `setImmediate` yield between stores and
every 200 rows; per-store snapshot duration is reported, and one degradation row is written if
a single snapshot call exceeds 250 ms (the stores are expected to hold hundreds of rows, not
tens of thousands).

Per store, in order:

0. **Gates.** `multiMachine.reconcile.enabled === false` ⇒ skip all. Store dark
   (`stores()[s].enabled !== true`) ⇒ skip without reading. `await gitCarried(seam)` ⇒ skip,
   `skippedGitCarried` (§5.5; re-evaluated every tick). Breaker open or `parked` ⇒ skip. A store
   whose `stateSync` entry has `dryRun: true` runs every step but emits nothing and counts
   `wouldEmit` / `wouldTombstone`.
1. **Seed** (until it succeeds once per process): `scan = await
   reader.loadOwnOriginRecordsAsync(store)`; install each record under the install rule, so an
   observer event that landed during the scan (newer) is kept — puts and deletes alike. A throw
   ⇒ unseeded, failure counted, nothing else runs for the store. There is no periodic re-seed;
   after boot the observer keeps the cache coherent.
2. **Snapshot.** `t0 = clock.tick()` (every HLC issued before compares lower, every one after
   higher), `intents = seam.deletionIntents?.()` (read BEFORE the snapshot), then
   `snap = seam.snapshot()`. A throw ⇒ `snapshotFailed++`, failure, nothing emitted. Rows that
   share a recordKey with DIFFERENT fingerprints are not emitted this tick (`duplicateKey`) —
   emitting both would alternate forever — but the key still counts as present.
3. **Puts.** For each row, skip when:
   - `entry.op === 'put' && fp === entry.fp` (`unchanged`);
   - `compare(entry.hlc, t0) > 0` — an own emit landed after the snapshot began (possible because
     of the yields), so the row may be stale; it is re-read next tick (`staleRowSkipped`);
   - `invalid.get(key) === row.sourceFp`, or `suppressed.has(key)`;
   - **resurrection guard:** the entry is a delete and either `fp === entry.fpAtDelete` (the disk
     holds, or a stale writer restored, exactly the content that was deleted) or `fpAtDelete` is
     unknown (compacted or rotated out). `resurrectionHeld++`. A row whose content differs from a
     KNOWN deleted version is a real re-add and emits. Stated cost: a deliberate re-add with
     identical content, or any re-add after the pre-delete put left the stream, stays local
     until its content changes (counted, visible on the route).
   Otherwise emit with `observed: null` (§2.1), up to `maxEmitsPerTick` (default 40) per store.
   Outcomes:
   - `emitted` ⇒ `emittedPuts++` (the observer installed it). **Post-emit check:** the fp the
     observer installed must equal the row fp; if not, the two normalisers disagree and the key
     would re-emit every tick ⇒ `suppressed.add(key)` (the self-heal: the loop stops), `fpMismatch++`,
     and one deduped DegradationReporter row, which feeds the feedback pipeline that fixes code
     defects. The key stops replicating edits until a restart after the fix; the count is on the
     route.
   - `dropped:schema-rejected` / `dropped:oversize` / `skipped` / `error` (a builder throw, e.g.
     a record over its per-entry cap) ⇒ content failure: `invalid.set(key, row.sourceFp)`, `rejected++`,
     one deduped degradation row per store.
   - `unconfirmed` / `dropped:rate-limited` / `dropped:locked-out` / `dropped:deduped` / `dropped:error` ⇒
     transient: nothing cached; re-derived next tick (`transient++`). (`deduped` is defensive:
     every emit ticks a fresh HLC, so the op-key `recordKey:hlc` cannot repeat.) A tick in which
     every attempted emit for the store was transient is a failure. Note: the journal's per-kind
     rate bucket (100 tokens, 50/s) is shared with the in-process hooks; a hook emit dropped by
     the reconciler's burst is recovered by the next tick, because its record is on disk.
   - `disabled` / `dropped:not-replicated-kind` ⇒ the store went dark; stop it for this tick.
4. **Deletes** (seams with `deletionIntents`). A delete method of the store's manager
   (`KnowledgeManager.remove`, `RelationshipManager.delete`, `mergeRelationships`) appends two
   lines to the store's intent log, in EVERY process whether or not a replication emitter is
   attached: `{ recordKey, deletedAt, phase: 'pending' }` BEFORE it removes the row and
   `{ recordKey, deletedAt, hlcFloor, phase: 'done' }` AFTER the removal is durable. `deletedAt` is
   the wall instant it also passes to its own `emitDelete` hook; `hlcFloor` is this machine's
   replication HLC as persisted at the moment the `done` line is written, i.e. AFTER the removal.
   The server's clock writes its file atomically on EVERY advance (foundation spec §3.5), so every
   put issued before that read — including a reconciler put of the row emitted between `pending`
   and the removal — compares ≤ it, and every put issued after compares strictly greater. Which
   file: at boot the server writes `<stateDir>/state/reconcile/clock-file.json` naming the exact
   clock file it uses (a machine whose identity changed keeps an abandoned clock file beside the
   live one, as Echo's Studio does today); the deleting process reads that pointer and then that
   one file. `null` when the pointer or the file is missing or unreadable (journal dark ⇒ nothing
   was replicated; or corrupt) — counted, never thrown. Only a `done` line can fire. A crash,
   or a delete method that throws, between the two leaves a `pending` line that never fires — that
   deletion does not replicate, the safe direction, and the reconciler counts such orphans
   (`intentPendingOrphan`, a pending line older than one interval with no matching done). If an
   append fails, the delete proceeds (a local delete must never fail on replication) and that one
   deletion does not replicate — today's behaviour for every CLI deletion — logged in the deleting
   process. The line holds no identity: `recordKey`
   is the same value the tombstone itself replicates. The log lives at
   `<stateDir>/state/reconcile/intents/<store>.jsonl` — under `state/`, which the default
   `.gitignore` already ignores and git-sync never carries (`RelationshipManager` gets the path as
   a new optional config field, `deletionIntentLog`, which the server and the `instar relationship`
   CLI fill from the state dir; absent ⇒ no intent is written). It is append-only and read with
   the chunked reader: about 100 bytes per deletion, written on every agent including dark ones
   (relationship and knowledge deletions are rare), so the file grows only with deliberate
   deletions; `intentLogBytes` is reported and one degradation row is written past 5 MB (≈ 50 000
   deletions; no action needed).
   Processing is **idempotent by state** — there is no acknowledgement file. For each key, take
   its newest intent; with `entry = latest.get(recordKey)`, a tombstone is emitted only when ALL
   hold:
   (a) the newest line for the key is `done`, `entry.op === 'put'`, and
   `HybridLogicalClock.compare(entry.hlc, intent.hlcFloor) <= 0` — the own stream's newest put was
   issued before the deletion, by the same clock, with no wall-clock comparison (backward clock
   jumps and an HLC running ahead of the wall cannot mis-order it). A CLI edit emitted just before
   the delete passes; any put issued after the deletion (a re-add) makes the old intent inert. An
   intent with `hlcFloor: null` never fires (`intentNoClock`). **Retirement:** a `done` intent that
   was read BEFORE a complete snapshot which still shows the key present belongs to a deletion that
   finished before that snapshot, so the row was re-added; that intent is retired for the life of
   the process (in memory), so a later intent-less loss of the re-added row cannot use it. A
   `pending`-only intent is never retired by a sighting: its row is legitimately still present
   until the removal completes. Once a tombstone lands, the entry is a delete and the intent is inert. A
   tombstone lost before the journal flushed leaves the entry a put after the next boot seed, so
   the intent fires again (crash-safe);
   (b) the key is absent from `snap.rows` (duplicates included) and `snap.present &&
   snap.skipped === 0` — a complete read agrees it is gone;
   (c) `compare(entry.hlc, t0) < 0` — no own emit for the key landed after the snapshot began (a
   re-add during the tick's yields defers the intent to the next tick, like the put fence).
   The tombstone is built by the store's new key-only builder
   (`buildKnowledgeTombstoneFromKey` / `buildRelationshipTombstoneFromKey`, `{ recordKey,
   deletedAt }`, which the existing identity-taking builders now delegate to, so both produce the
   same record), emitted with `observed: null`, up to `maxTombstonesPerTick` (default 20);
   outcomes map as in step 3.
   A row that vanished WITHOUT an intent (a lost update from two concurrent writers, a stale
   whole-file save, a hand edit, a restore) is never tombstoned; it stays in the peers' streams,
   the safe direction (`absentNoIntent`). Stated gaps, counted: an intent whose key is not in the
   own stream at all (never replicated, or rotated out; `intentNoEntry`) produces no tombstone; and
   a record deleted, re-added by a CLI and then lost WITHOUT an intent — all before the reconciler
   emitted the re-add and across a restart that lost the in-memory retirement — is tombstoned by the
   old intent, which matches the disk (it is gone).
   Because the tombstone carries no witness, a peer that ALSO authored its own version of the same
   key sees a flagged conflict instead of a clean delete; a record only this machine authored
   (the common case: peers hold it in this machine's origin stream) is removed cleanly, because
   within one origin the newest record wins. There is no mass-delete hold: every tombstone mirrors
   an explicit deletion made by the store's own delete method.
5. **Bookkeeping.** `invalid` is pruned of keys absent from a complete snapshot; a clean tick
   resets `failures`.

### §4.5 Brakes (No Unbounded Loops / Capacity Safety)

- **Caps:** 40 puts and 20 tombstones per store per tick; leftovers run on the 60 s cadence.
- **Breaker:** 3 consecutive failed ticks ⇒ the store retries every `intervalMs × 2ⁿ`, capped at
  60 min, with one deduped degradation row; a clean tick resets.
- **Give-up:** a store whose breaker has stayed at the 60-minute cap for 24 h is **parked**: no
  further attempts until a restart or a change to `multiMachine.reconcile`. Parking raises ONE
  attention item (`conditionKey: reconcile-parked:<store>`) — the self-heal (backoff) is
  exhausted by then (Self-Heal Before Notify). The item says the agent will retry on the
  operator's word; on a yes from the topic's VERIFIED operator the agent restarts the server
  (or edits the config file through the same atomic read-modify-write `LiveConfig` uses).
  Total attempts per store under sustained failure are bounded (≈ 3 + backoff steps + 24).
- **Per-key brakes:** the post-emit fp check and the duplicate-key skip (step 2–3) — the two ways
  an unchanged disk state could re-emit every tick.
- **Registered** in `SELF_ACTION_CONTROLLERS` (`src/testing/selfActionRegistry.ts`); the source
  carries the `@self-action-controller` marker, so the convergence ratchet drives it.
- **Test:** a seam that throws every tick emits nothing, opens the breaker at tick 3, backs off
  to 60 min, parks after 24 h at the cap, and writes exactly one degradation row and one
  attention item.

### §5 Safety

- **5.1 Dark gate unchanged, and dry-run honoured.** The reconciler reads nothing for a dark
  store; the emitter re-checks. A store in `dryRun` emits nothing.
- **5.2 PII posture unchanged.** The seams call the SAME `build*RecordData` projections with the
  SAME options as the in-process hooks (local ids never cross; channel-keyed identity; schema
  validation). Fixture refusal: users apply `UserManager`'s rule (`refusedTestIdentityFor`);
  relationships run `matchTestIdentity` over each record's channels; a refused row counts as
  `skipped` and is never emitted. The intent logs are a new local file holding no identity: only
  the record key — pseudonymous (relationship keys are unsalted hashes of channel ids), exactly as
  in every journal tombstone already on every machine — and a timestamp.
- **5.3 Puts-only for three stores.** `users.json`, `state/evolution/action-queue.json` and
  `state/evolution/learning-registry.json` get no intent log in this change: their delete paths
  are spread across several in-memory instances (feedback fb-9ac43374-07b), and the
  in-process ones already emit tombstones through their hooks. Stated gap: a user, learning or
  action removed through a CLI or a per-request manager is NOT tombstoned and stays in every
  peer's replica stream until fb-9ac43374-07b closes (feedback fb-9ac43374-07b); before
  this change such a record never left its machine, after it a CLI-added user replicates but a
  CLI removal does not. Extending the intent log to those delete methods is the planned close.
  Preferences has no delete path. The server's `RelationshipManager` loads once and can re-save
  a record the CLI deleted; the resurrection guard holds an identical re-appearance, and a
  CHANGED re-save is a real put (that producer is part of fb-9ac43374-07b).
- **5.4 Readers are read-only and quiet.** No snapshot writes, backs up, or logs per row:
  `RelationshipManager.readAllFromDisk(dir)` and `KnowledgeManager.readCatalogStrict(stateDir)`
  (missing ⇒ `present:false`; corrupt catalog or unreadable dir ⇒ throw; corrupt/misnamed record
  file ⇒ `skipped`); `UserManager.readProfilesFromDisk(stateDir, testIdentityKey)` parses
  `users.json` itself (non-array ⇒ throw) and never constructs a manager (no high-water write, no
  `.corrupt` backup copy, no per-row log); preferences use `PreferencesManager.read()`; learnings
  and actions use the server's `EvolutionManager.listLearnings()` / `listActions()`, which re-read
  disk on each call. Intent logs are read tolerantly (an unparseable line is skipped: a missing
  intent can only withhold a tombstone). The reconciler writes no file at all.
- **5.5 Local writes only — measured each tick.** Re-emitting disk state as own-origin is correct
  only when the store file holds this machine's writes. That is false where git carries the
  store: `GitSyncManager` (mesh git backup) and the hourly `git-sync` job (`instar init` installs
  it; plain git, no manager) both commit and pull every non-ignored file under the state dir, and
  `GitSync` field-merges relationship files. So `gitCarried(seam)` is true when ANY of the seam's
  paths is tracked by git (`git ls-files` — peer content may already be in it), OR git-sync is
  active (a constructed `GitSyncManager`, or an enabled `git-sync` job) AND a path is not ignored
  (`git check-ignore`). A state dir that is not inside a git work tree
  (`git rev-parse --is-inside-work-tree` fails) is NOT carried — nothing can be carrying it. Any
  other git failure ⇒ carried (skip, the safe side) and counted separately (`gitProbeFailed`), so
  a broken probe never reads as a quiet success. Evaluated every tick for enabled stores only
  (two async `git` spawns per store: at most 12 a minute while a backlog drains). A carried store is skipped entirely
  and reported: git already replicates it there, and re-owning git-delivered rows would duplicate
  origins. Echo's home runs no `git-sync` job and refuses `GitSyncManager` (source tree), and its
  store paths are untracked, so its stores are local.
- **5.6 Never breaks a write.** Own timer; every seam call and emit is wrapped. The intent append
  in a delete method is best-effort and wrapped like the existing `emitDelete` call: a failed
  append never fails the local delete (it only withholds the tombstone, the safe side).
- **5.7 Preference scrub alignment.** The in-process preference hook (`routes.ts`, correction
  loop) passes no credential scrubber although `buildPrefRecordData`'s contract says the
  in-process default passes the real one. Both the hook and the seam now pass
  `redactForLiveTail`, so both paths build identical records. Effect: a credential-shaped
  learning already in a stream re-emits once, redacted.
- **5.8 Observability carries no identities.** `GET /state/reconcile`, degradation rows and
  attention items carry counts, timestamps and fixed reason codes only — never a record key
  (relationship and user keys are unsalted hashes of channel ids), identity, channel, or an
  exception message. `lastError` is a fixed code (`snapshot-unreadable`, `seed-unreadable`,
  `emit-transient`, `git-check-failed`, …).
- **5.9 Two servers on one stateDir** (tests): the second is journal-locked-out; every emit is
  `dropped:locked-out`; nothing is cached as sent.
- **5.10 Rotation at boot (stated limit).** A key whose own record rotated out of the journal
  window is re-emitted at the next boot (it is not in the seed), and a deletion intent for such a
  key finds no entry (`intentNoEntry`). Likewise a key whose own TOMBSTONE rotated out loses the
  resurrection guard: a stale row restored after that is re-emitted as new — exactly what an
  in-process hook re-save of that row already does today. An identical peer copy stays one record (§2 collapse);
  only a genuinely divergent peer version opens a conflict. Collapse needs byte-identical store
  fields, so the same knowledge URL ingested independently on two machines (different
  `ingestedAt`) is still a conflict, as it already is for in-process ingests.
  Rotation needs an own stream past `maxFileBytes × (rotateKeep + 1)` (≈ 20 MB for these kinds),
  far beyond these stores' size; `emittedAtBootNotInSeed` is reported so growth is visible.

### §6 Wiring (`src/commands/server.ts`)

Constructed after the five in-server emit hooks are attached (users ~:5553, learnings/actions
~:13280/:13546, relationships ~:13309, knowledge ~:13390; the preference hook is per-request in
`routes.ts`) and before `new AgentServer(...)`, only when `replicatedRecordEmitter &&
replicatedPeerStreamReader`. Passed to `AgentServer` as `replicatedStoreReconciler` →
`RouteContext.replicatedStoreReconciler`; `stop()` on shutdown. Seams:

| store | snapshot | key / build | deletion intents |
|---|---|---|---|
| preferences | `new PreferencesManager(stateDir).read()` | `dedupeKey` / `buildPrefRecordData({ entry, op:'put', scrub: redactForLiveTail })` | — |
| relationships | `RelationshipManager.readAllFromDisk(dir)` | `deriveRelationshipRecordKey` / `buildRelationshipRecordData` | `state/reconcile/intents/relationships.jsonl` → relationship tombstone `{recordKey, deletedAt}` |
| knowledge | `KnowledgeManager.readCatalogStrict(stateDir)` | `deriveKnowledgeRecordKey` / `buildKnowledgeRecordData` | `state/reconcile/intents/knowledge.jsonl` → knowledge tombstone `{recordKey, deletedAt}` |
| userRegistry | `UserManager.readProfilesFromDisk(stateDir, testIdentityKey)` | `deriveUserRecordKey` / `buildUserRecordData` | — (§5.3) |
| learnings | `evolution.listLearnings()` | `deriveLearningRecordKey` / `buildLearningRecordData` | — (§5.3) |
| evolutionActions | `evolution.listActions()` | `deriveEvolutionActionRecordKey` / `buildEvolutionActionRecordData` | — (§5.3) |

(`hlc`, `origin` and `observed` reach the builders through the `BuildRecordData` closure, as
for the hooks; `deletedAt` is the intent's.) Where the replication HLC is constructed, the server
also writes `state/reconcile/clock-file.json` (`{ "path": "<absolute clock file>" }`, atomic) so
a deleting process can find the live clock (§4 step 4).

**Ratchet test:** every store in the replicated-kind registry is either seamed or listed in
`RECONCILER_ALLOWLIST` with its reason (e.g. `topicOperator`: single server-constructed writer,
no CLI path). A new store must pick one.

### §7 Config, observability, awareness

- Config `multiMachine.reconcile = { enabled?: boolean (default true), intervalMs?: number,
  maxEmitsPerTick?: number, maxTombstonesPerTick?: number }`, read every tick via
  `liveConfig.get` (an edit is seen next tick, no restart). Not under `stateSync`, which is
  dev-gate-resolved per object. Absent ⇒ enabled, so no `migrateConfig` entry. On the fleet every
  store is dark, so nothing changes; on a development agent the reconciler backfills CLI-written
  records of live, non-dry-run stores on the first tick after the update.
- `GET /state/reconcile` (Bearer) → `{ enabled, intervalMs, lastTickAt, stores: { <store>: {
  putsOnly, gitCarried, dryRun, seeded, parked, ticks, unchanged, emittedPuts, wouldEmit,
  emittedTombstones, wouldTombstone, intentNoEntry, intentNoClock, intentPendingOrphan,
  intentLogBytes, gitProbeFailed,
  rejected, transient, staleRowSkipped, fpMismatch, suppressedKeys, duplicateKey,
  resurrectionHeld, absentNoIntent, emittedAtBootNotInSeed,
  snapshotFailed, skippedRows, present, backlog, lastSnapshotMs, breakerOpenUntil, lastError } } }`.
  503 `{ error: 'reconciler-not-constructed' }` when the journal is dark. API-only.
- CLAUDE.md template (`generateClaudeMd()`, One Memory section) + a `migrateClaudeMd` arm
  (content-sniff `writer-agnostic`): "Replication is writer-agnostic: a record written by a CLI
  (`instar knowledge ingest`, `instar relationship`, `instar user add`, `instar reflect`) or any
  other process reaches your other machines' replication log within about 10 minutes (today only
  learnings are also shown in peers' reads; the other stores follow). Removing a relationship or
  knowledge source replicates from any process; removals of users, learnings and action items
  replicate only when made through the server. Status: `GET /state/reconcile`."

### §8 Proof (CMT-1005)

Only real records (Test Identity Never Enters Production State). First, on each machine,
record `gitCarried` per store from `GET /state/reconcile` (expected false on Echo's machines:
no git-sync job, source-tree home, untracked store paths); a carried store is reported as such,
not counted as a failure.

- **knowledge:** ingest this spec's ELI16 overview on the Studio with `instar knowledge ingest`;
  `GET /state/reconcile` shows `knowledge.emittedPuts ≥ 1`; on each peer the replica stream
  `state/coherence-journal/peers/<studio-id>.knowledge-record.jsonl` holds that recordKey within
  one sync pull.
- **relationships:** the operator's own relationship record (name + the Telegram channel that
  already binds him as verified operator), created with `instar relationship`; same observables
  on `relationship-record`.
- **userRegistry / preferences:** no real record exists and none may be invented (registering
  the operator as a user would arm sender re-validation; preferences come only from the
  correction loop). Proven by the e2e test plus live counters showing both stores ticked and
  readable (`snapshotFailed: 0`). Stated in the report.
- **learnings / evolutionActions:** real records exist; `unchanged` equals the store size on the
  first tick after seeding, and a peer's learnings union read shows them.

## Authority posture

Gates nothing, blocks nothing, filters nothing. It produces records into an existing stream
whose consumers already treat every record as advisory data. Its emits claim no witness, so they
supply no evidence that would itself justify superseding a peer's version (another writer's
scalar witness can still order around them — the foundation's stated §7.2 limit), and its
tombstones mirror explicit deletions made by the store's own delete method — the authority the
in-process hooks already exercise.
Signal-vs-authority: a signal producer feeding an existing merge.

## Decision points touched

| decision point | class | justification |
|---|---|---|
| emit-or-skip per record (fingerprint) | `invariant` | exact equality of one normaliser's output on both sides |
| witness = none (§2.1) | `invariant` | a constant; identical-content collapse is exact `stableJson` equality of every version |
| outcome → content-failure vs transient (§4 step 3) | `invariant` | a closed mapping over the journal's outcome enum |
| resurrection guard (§4 step 3) | `invariant` | exact fp equality with the last known put before the own delete; unknown ⇒ hold |
| duplicate-key skip (§4 step 2) | `invariant` | two different fps for one key in one snapshot |
| tombstone-or-not (§4 step 4) | `invariant` | a committed (`done`) intent from the store's own delete method whose persisted-HLC floor is ≥ the own stream's put, a complete snapshot without the row, and no own emit after the fence; never inferred from absence |
| gitCarried skip (§5.5) | `invariant` | `git ls-files` / `git check-ignore` + git-sync presence; error ⇒ carried |

## Verify the State, Not Its Symbol (P20 declarations)

| symbol read | state claimed | corroboration | when unmeasurable |
|---|---|---|---|
| `emittedPuts` / `emittedTombstones` | a record was accepted into the own journal stream | incremented only on the journal's `accepted`; the e2e test reads it back from the peer's replica | reconciler not constructed ⇒ route 503, never zeros |
| `wouldEmit` / `wouldTombstone` | the store is in `dryRun` and the record would have been emitted | the same path up to the emit call | — |
| `unchanged` | the disk record equals the own stream's newest put | same normaliser both sides; post-emit check on every emit | unseeded ⇒ no comparison, `seeded:false` |
| deletion intent + absence | the record was deliberately deleted | a `done` line written after removal, HLC-ordered after the own stream's put, plus a complete snapshot without the row | missing / `pending`-only / clockless intent ⇒ no tombstone (counted); row present or incomplete read ⇒ waits |
| `resurrectionHeld` | the disk holds content already deleted in the own stream, or the deleted version is unknown | fp equality with the pre-delete put | unknown fp ⇒ held (safe side) |
| `rejected` / `transient` / `fpMismatch` / `duplicateKey` / `staleRowSkipped` / `intentNoClock` / `intentPendingOrphan` | the named condition occurred | emitter outcome / post-emit fp / snapshot rows / fence compare | — |
| `snapshotFailed` / `skippedRows` / `seeded` / `parked` | read failed / partial / seeded / given up | reader threw / counted rows / seed resolved / give-up rule | — |
| `gitCarried` | git carries the store file here | `git ls-files` / `git check-ignore` + git-sync presence, each tick | git error ⇒ carried (skip) |

## Multi-machine posture

- Output (own-stream journal records): **unified** — replicated by the existing journal sync.
- Peer reads of those records: `migrating-to-unified` (learnings unified today; the others are
  fb-007f5082-161, since 2026-10-28; expires when that item closes).
- The reconciler's caches: in-memory, re-derived from the own stream at boot, kept coherent by
  the emit observer. The intent logs are per-machine on purpose: each records deletions made on
  that machine, which become tombstones in that machine's own stream — the replicated form.
  Nothing else is machine-local.
- A git-carried store is skipped on that machine because git already replicates it there.
- User-facing notices: one attention item only (a parked store), via `conditionKey`. Generated
  URLs: none.

## Frontloaded Decisions

1. Interval 10 min, first tick +90 s, 60 s while work remains — cheap-to-change-after (live knob).
2. Fingerprint = sha256(stableJson(validated storeFields)) with no-op counters.
3. Reconciler emits claim no witness; the union collapses byte-identical concurrent versions
   (§2.1).
4. Tombstones only from explicit two-phase deletion intents written by the store's own delete
   methods, ordered against the own put by the persisted replication HLC and processed
   idempotently by state; never inferred from absence; the log holds no identity and is never
   trimmed. Ships live: it is the same deletion authority the in-process
   hooks exercise today, extended to the CLI process that calls the same methods (without a
   witness, so a key a peer also authored conflicts instead of deleting cleanly; §4 step 4).
5. Scope: the six stores; tombstones for relationships + knowledge; every other registered store
   allow-listed with a reason by ratchet.
6. No periodic re-seed; boot seed plus the observer keep the cache coherent.
7. Status route is a new `GET /state/reconcile` (the legacy `GET /state/sync` is untouched).
8. Supervision tier 0: no LLM in the path; puts are a deterministic copy, tombstones mirror
   explicit deletions.
9. Preference hook scrub (§5.7): both paths pass `redactForLiveTail`; credential-shaped
   learnings already replicated re-emit once, redacted. Not cheap-to-change-after (replicated
   text) — chosen because it only ever removes credential text.
10. Git-carried stores are skipped, evaluated per tick.
11. Proof uses only real records.

## Rollback

`multiMachine.reconcile.enabled: false` (read next tick, no restart) stops it; reverting the
release removes it. Puts it emitted are ordinary own-stream records, identical to what an
in-process write emits. A tombstone already emitted is a removal on every peer that turning the
reconciler off does not undo; each one mirrors a deletion the operator or agent explicitly made
through the store's delete method, as the in-process hook already does. The intent-log append
reverts with the release (an orphaned log is inert and holds no identity). The preference scrub (§5.7) reverts in one
line.

## Testing

- **Unit** `tests/unit/replicated-store-reconciler.test.ts` (fake emitter/reader/clock/timer):
  absent key emits with `observed: null`; unchanged skips after seed, across ticks and after an
  observer-reported hook emit; changed emits; `unconfirmed` is transient; transient outcome
  caches nothing and retries; content failure (incl. builder throw → `error`) not retried until
  the disk row changes, and retried at once when an oversized row is corrected (no restart); post-emit fp mismatch suppresses and writes one degradation row; duplicate key
  with different fps is not emitted and still counts as present; row whose entry is newer than
  `t0` is skipped; resurrection guard holds an identical re-appearance and an unknown-fpAtDelete
  case, lets a changed one through; observer delete during a seed survives the seed; a row that
  vanishes without an intent is never tombstoned; an intent whose `hlcFloor` is older than the own put is
  inert; an edit emitted just before a delete still lets the delete fire;
  an intent whose row is still on disk does nothing (crash between append and removal);
  a `pending`-only intent never fires; an intent retired by a later sighting of the row does not
  fire after the row is lost; a `pending` intent seen with its row still present is NOT retired
  and fires after `done`; a reconciler put of the row between `pending` and the removal does not
  invalidate the deletion (floor read after removal); a put newer than `hlcFloor` makes the intent
  inert even with the wall clock moved backwards; `hlcFloor: null` (missing pointer, missing or
  corrupt clock file) never fires and is counted; a stale abandoned clock file beside the live
  one is ignored;
  `done` intent + older put + complete absence ⇒ tombstone `{recordKey, deletedAt}` with
  `observed:null`, after which the intent is inert; a tombstone dropped before flush re-fires
  after a restart (entry is a put again); a re-add during the yields (entry newer than `t0`)
  defers the intent; an incomplete snapshot defers it; a deletion burst larger than the
  per-tick cap drains over later ticks with no intent lost; store
  `dryRun` counts `wouldEmit`/`wouldTombstone` and emits nothing; puts-only stores never
  tombstone; gitCarried and dark stores read nothing; caps with carry-over on the 60 s cadence;
  a tick past 5 minutes keeps its lock; sustained-failure breaker, park after 24 h at the cap,
  one degradation row and one attention item; observability carries no keys or messages.
- **Unit (substrate):** journal returns each outcome; emitter returns `emitted` only on
  `accepted` with the ticked hlc (a void journal ⇒ `unconfirmed`), fires observers only then,
  honours `opts.observed` (incl. `null`) without reading the witness; `loadOwnOriginRecordsAsync`
  equals the own half of `materialize` (incl. `lastPutFields`); `classifyOriginSet` collapses a
  concurrent set of identical puts (and identical tombstones) and still flags a set with one
  differing version, across 2 and 3 origins including a delayed third origin, for a HIGH and a
  LOW tier store; an identical-content conflict already open in the ledger is resolved on the
  next read. The existing union/conflict suites (`tests/unit/UnionReader.test.ts` and the WS2
  store union tests) are re-run unchanged; any case that used identical data to demonstrate a
  conflict is updated to differing data, and listed in the side-effects review.
- **Unit (managers):** `KnowledgeManager.remove`, `RelationshipManager.delete` and
  `mergeRelationships` append a `pending` line before removing the row and a `done` line after (an
  ordering test; a throw between leaves only `pending`, which never fires),
  with and without an emitter attached, pass the same `deletedAt` to the hook, hold no identity
  field, and never fail the delete when the append fails. `build*TombstoneFromKey` output equals
  the identity-taking builder's for the same record and passes the delete branch of each store's
  schema.
- **Unit (fingerprints, per store):** fp equal across HLC/`observed`; validation idempotent.
- **Unit (readers):** strict readers throw on corrupt, report `present:false` on missing, count
  malformed/misnamed/fixture rows as skipped, write nothing, log nothing per row.
- **Unit (git check):** tracked path ⇒ carried; untracked + not ignored + an enabled `git-sync`
  job ⇒ carried; untracked + no git-sync ⇒ local; not a work tree ⇒ local; other git error ⇒
  carried + `gitProbeFailed`.
- **Self-action convergence:** the registry entry drives the real class under a permanently
  failing seam; the ratchet asserts the bound.
- **Integration** `tests/integration/state-reconcile-route.test.ts`: `GET /state/reconcile`
  returns the counters and no identity fields (a corrupt PII file yields only a fixed
  `lastError` code); 503 when not constructed.
- **E2E (cross-instance)** `tests/e2e/ws2-reconciler-cross-instance.test.ts` on the existing WS2
  harness (two stateDirs, real journal with an explicit flush, `buildServeBatch`/`apply`): A
  writes the knowledge catalog FILE directly, ticks, flushes, B applies ⇒ B's replica stream
  holds the record with origin A and no `observed`; the same record already present on B with
  identical content produces no conflict in B's union, and a differing one does; A removes one of two rows with `KnowledgeManager.remove`
  in a separate manager instance (CLI-style, no emitter) ⇒ next tick B holds the tombstone; a row
  deleted from the catalog file by hand is NOT tombstoned; another tick adds nothing to A's
  stream (G4). A user row written to `users.json` lands on B; a fixture-marked row never does.
- **E2E (alive)** `tests/e2e/ws2-reconciler-alive.test.ts` (modelled on
  `ws24-knowledge-alive.test.ts`): production-like init ⇒ `GET /state/reconcile` 200 with
  `seeded:true` after a forced tick; 503 when the journal is dark.
- **Wiring ratchet** `tests/unit/replicated-store-reconciler-wiring.test.ts`: seamed ∪ allow-list
  == registry stores; deletion intents only on relationships + knowledge; the reconciler's clock
  is the emitter's; the preference builders in the hook and the seam both pass the scrubber.

## Maturation plan

- **test-agent-live:** the cross-instance e2e is the throwaway pair: two real state dirs with real
  journals, a knowledge catalog written directly to disk on one, the record and a CLI-style
  deletion observed in the other's replica stream.
- **dev-agent-live:** live on Echo's four machines from the release that carries it (the six stores
  are already enabled there; `multiMachine.reconcile` defaults on). Watch `GET /state/reconcile` on
  each machine: `snapshotFailed`, `fpMismatch`, `rejected`, `transient`, `gitCarried`.
- **fleet:** nothing to flip for the reconciler itself — it rides each store's existing
  `multiMachine.stateSync.<store>` flag, which is dark on the fleet; it goes live per store when that
  store's flag does.
- **graduation criterion:** the CMT-1005 proof (§8): one real knowledge record and one real
  relationship record created by the CLI on the Studio appear in the replica stream on each of the
  Mini, the Laptop and the Mama PC, `fpMismatch: 0` and `snapshotFailed: 0` on all four machines, and
  `unchanged` equal to the store size for learnings/evolutionActions after seeding. A zero count of
  `emittedPuts` for knowledge is not a pass.
- **dark-window:** none on the development agent — live on release. If the criterion is not met
  within 7 days of the release, the reason and a new date are recorded on CMT-1005.

## Open questions

*(none)*
