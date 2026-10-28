# Side-Effects Review — writer-agnostic replication reconciler

**Version / slug:** `statesync-writer-agnostic-reconciler`
**Date:** `2026-10-28`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/statesync-writer-agnostic-reconciler.md` (converged, 6/6 rounds, Codex
GPT-6 Astra every round). Adds `ReplicatedStoreReconciler` (`src/core/ReplicatedStoreReconciler.ts`)
plus its wiring module (`src/core/ReplicatedStoreReconcilerWiring.ts`) and a deletion-intent log
(`src/core/DeletionIntentLog.ts`). Every 10 minutes the server reads the six file-backed WS2 stores
from disk and emits, through the existing `ReplicatedRecordEmitter`, every record its own journal
stream does not yet hold; deletions replicate only from explicit two-phase intents written by
`KnowledgeManager.remove` and `RelationshipManager.delete`/`mergeRelationships`. Substrate changes
are additive: `CoherenceJournal.emitReplicatedRecord` and `ReplicatedRecordEmitter.emit` now return
outcomes, the emitter gains an explicit-`observed` option and emit observers,
`ReplicatedPeerStreamReader.loadOwnOriginRecordsAsync`, `UnionReader.classifyOriginSet` collapses
byte-identical concurrent versions, `ConflictStore.autoResolveIdenticalContent`, key-only tombstone
builders, read-only static store readers, a server-written clock pointer, `GET /state/reconcile`,
the preference hook's credential scrub, the CLAUDE.md template line + `migrateClaudeMd` arm, and a
`SELF_ACTION_CONTROLLERS` entry. Size: ~1 400 added source lines across ~20 files plus tests. Effort:
6 spec review rounds (at the Tier-2 cap; three deletion designs before one survived
counterexamples).

## Decision-point inventory

- emit-or-skip per record (fingerprint) — add — invariant: exact equality of one normaliser.
- tombstone-or-not — add — invariant: a `done` intent from the store's own delete method, ordered
  by the persisted HLC, plus a complete snapshot without the row.
- union classification of concurrent versions — modify — byte-identical versions are no longer a
  conflict (strictly fewer conflicts).
- breaker / park — add — fixed-count brakes.
- gitCarried skip — add — deterministic `git ls-files` probe.

---

## 1. Over-block

No block/allow surface on messages, sessions or user actions. The only things it withholds are its
own emits: a store that is dark or carried by git is not read, and a store in dry-run is read but
only counted (`wouldEmit`/`wouldTombstone`); a record that fails
validation is not re-tried until it changes; an identical re-appearance of a deleted record is held
(`resurrectionHeld`). Legitimate cost: a deliberate re-add with byte-identical content after a
deletion stays local until its content changes (counted, stated in the spec).

## 2. Under-block

- A row removed by hand, by a lost update, or by a stale whole-file save is never replicated as a
  deletion (by design — absence is not evidence); peers keep it.
- User, learning and action removals made by a CLI or a per-request manager still do not
  replicate (puts-only until fb-9ac43374-07b).
- A deletion whose intent has no clock floor (journal dark, missing pointer) does not replicate
  (`intentNoClock`).
- Peers' union reads still show only learnings from replica streams (fb-007f5082-161).
- Free-text fields are not credential-scrubbed in the builders (fb-c06f0a53-0fb); unchanged by this.

## 3. Level-of-abstraction fit

Right layer: it is a producer feeding the existing emitter/journal/union stack, not a new
replication path. It reuses the emitter (dark gate, HLC, journal), the store builders and the
envelope validator. The one cross-cutting change is in the union classifier, where identical
versions are a non-conflict for every store — the correct owner of that rule.

## 4. Signal vs authority compliance

No blocking authority. It produces advisory records; it never gates a message, a write or a
session. Its emits claim no witness, so they supply no evidence that could let them supersede a
peer version. Complies with docs/signal-vs-authority.md.

## 4b. Judgment-point check

No competing-signals decision point: every decision is an exact-equality or ordering invariant
(spec "Decision points touched"). No heuristic stands in for judgment.

## 5. Interactions

- In-process emit hooks: unchanged; the emitter's observer keeps the reconciler's cache coherent
  with them, so a server-written record is not re-emitted.
- Journal rate bucket: shared per kind; the reconciler's 40-emit burst can rate-limit a concurrent
  hook emit, which the next tick recovers because the record is on disk.
- ConflictStore: identical-content conflicts already open are closed on the next union read with
  resolution `identical-content`.
- EvolutionManager's own fingerprint map may re-emit a CLI-written learning once more on its next
  save; harmless (same origin, newest wins).
- Git-sync: stores whose files git carries are skipped on that machine.
- SafeGitExecutor: read-only `ls-files` / `rev-parse` with `sourceTreeReadOk`, cached until the git
  index, an ignore file or git-sync state changes.

## 6. External surfaces

- New route `GET /state/reconcile` (Bearer; counters only, no record keys or error text).
- New local files: `state/reconcile/intents/<store>.jsonl` (record key + time + clock, no identity)
  and `state/reconcile/clock-file.json` (pointer to the live HLC file).
- Journal own streams gain records written by CLIs on agents whose stores are enabled (Echo's
  machines). Fleet stores are dark, so the fleet sees no new records.
- CLAUDE.md template line and migration.
- Timing dependence: 10-minute cadence, first tick 90 s after boot.

## 6b. Operator-surface quality

No operator surface (no dashboard file, approval page or form) touched. The single attention item
(store parked after 24 h of failures) is plain language and asks for one conversational yes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Output: **unified** — own-stream journal records replicated by the existing journal sync. Peer
reads: `migrating-to-unified` (learnings unified today; others fb-007f5082-161). Reconciler caches:
in-memory, re-derived from the own stream at boot. Intent logs are per-machine by design (each
records deletions made on that machine, which become tombstones in that machine's own stream — the
replicated form). Git-carried stores are skipped where git already replicates them. No user-facing
notice except one per-condition attention item; no generated URLs.

## 8. Rollback cost

`multiMachine.reconcile.enabled: false` (read next tick, no restart) or revert the release. Puts
are ordinary own-stream records; nothing to repair. An emitted tombstone is a removal on every peer
that turning the reconciler off does not undo; each mirrors an explicit deletion made through the
store's delete method. The intent logs and pointer are inert after a revert. The preference scrub
reverts in one line.

## Conclusion

Ship. The change is additive, dark on the fleet, read-only on the stores, and its only irreversible
output (tombstones) comes from explicit, clock-ordered deletion intents.

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose)
**Independent read of the artifact:** concur — The code matches the spec's §1–§7 and the artifact's safety claims. (1) A tombstone needs all of these: a `done` line that is the newest intent for its key, an own-stream `put` entry at or below `hlcFloor` (the floor is read from the clock file, which is saved on every advance, so a failed or stale read can only lower the floor and withhold a tombstone), a complete snapshot without the key, and an entry older than `t0` (ReplicatedStoreReconciler.ts:585-602). The one residual case is the gap the spec itself states (§4 step 4): a CLI deletes a record, re-adds it, and the re-add is then lost without an intent, with a restart dropping the in-memory retirement in between. Note that for a byte-identical CLI re-add the reconciler never emits a new put (`unchanged`, :521), so that window stays open until the next complete tick after a restart, not just until "the reconciler emitted the re-add" as the spec words it. (2) No re-emit loop. Op-keys include the HLC, so the journal never returns `deduped`. An emitted put is installed by the observer under the same validator fingerprint, and a fingerprint mismatch suppresses the key (:548-553). Transient outcomes are bounded by the breaker and park. (3) Local writes cannot fail: intent writes swallow errors (DeletionIntentLog.ts:87-107). Boot cannot fail: construction and the clock pointer are wrapped in try/catch in server.ts, the first tick waits 90 s, and timers are unref'd. One nit: `deps.config()` is called outside the per-store try in `tick()`/`nextDelay()` (:391, :323), so a throwing config getter would become an unhandled rejection and stop rescheduling (liveConfig.get does not throw today). (4) `getStatus` returns only counters, ISO times and fixed reason codes, with no keys, identities or error text. Error messages reach only the server console log. (5) Dark stores return before git, seed or snapshot (:415). No seam writes a store file: the readers are new static read-only methods, plus `EvolutionManager.list*` and `PreferencesManager.read`, neither of which writes. Artifact correction: §1 says a store "in dry-run … is not read", but the code (as the spec §5.1/§4 intend) DOES seed and read dry-run stores and only withholds the emit (`wouldEmit`/`wouldTombstone`). (6) The union collapse applies only when every version has the same op and `stableJson`-identical data, and any differing version still yields a conflict. `autoResolveIdenticalContent` closes an entry only when its version set matches exactly, and it is a no-op (no persist) otherwise. (7) Signal vs authority holds. The output is replicated records, and the only destructive effect, a tombstone on peers, mirrors an explicit delete-method intent. Cosmetic: in routes.ts the original `/state/conflicts` doc comment now sits above the new `/state/reconcile` block.

## Evidence pointers

- Spec + convergence report: `docs/specs/statesync-writer-agnostic-reconciler.md`,
  `docs/specs/reports/statesync-writer-agnostic-reconciler-convergence.md`.
- Tests: `tests/unit/replicated-store-reconciler*.test.ts`,
  `tests/integration/state-reconcile-route.test.ts`, `tests/e2e/ws2-reconciler-*.test.ts`,
  `tests/unit/self-action-convergence.test.ts` (registry entry `replicated-store-reconciler`).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this adds a self-triggered controller: the
  reconciler's retry loop).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts
  (SELF_ACTION_CONTROLLERS entry replicated-store-reconciler), howCaught: the entry drives the real
  nextBreakerState under a permanently failing store read; attempts settle at a fixed bound (three
  failures, doubling backoff capped at 60 min, park after 24 h at the cap) instead of growing with
  uptime }`.
