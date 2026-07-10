# Side-Effects Review — Standby-write wedge fix (evolution/learning replication re-emits only changed records)

**Version / slug:** `standby-write-wedge-fix`
**Date:** `2026-07-09`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `Echo (independent read)`

## Summary of the change

On a multi-machine setup, `EvolutionManager.saveActions` and `saveLearnings` re-emitted the
cross-machine replication record for **every** surviving record on **every** write. Each emit's
witness lookup (`ReplicatedRecordEmitter.emit` → `ReplicatedPeerStreamReader.loadWitness` →
`materialize()`) re-reads and JSON-parses the entire replication journal for that store. That made
one write cost O(records × journalBytes) of synchronous fs on the event loop, and it fed a doom
loop: re-emitting unchanged records bloated the journal (measured on a live agent: the
`evolution-action-record` journal grew to ~53 MB / ~61k records for only 632 distinct keys, each
re-emitted ~112×), which slowed every subsequent scan. With ~1,200 local actions, one
`POST /evolution/actions` did tens of GB of synchronous reads and starved the event loop until the
supervisor killed and respawned the process; `POST /attention` (a slow request that overlaps the
frequent background-job-triggered freezes) timed out the same way. The fix changes the two emit
loops to re-emit **only records whose content changed** since their last emit, tracked by a small
per-record-id content fingerprint (`emitFingerprint`), seeded from on-disk state when the emitter is
attached. Files: `src/core/EvolutionManager.ts` (fix), `tests/unit/evolution-manager-emit-wedge.test.ts` (new tests).

## Decision-point inventory

- `EvolutionManager.saveActions` emit loop — **modify** — emits PUT only for actions whose content fingerprint changed (was: every survivor).
- `EvolutionManager.saveLearnings` emit loop — **modify** — same, for learnings.
- `EvolutionManager.setEvolutionActionReplicationEmitter` / `setLearningReplicationEmitter` — **modify** — seed the change-detector from on-disk state on attach (cold-start guard).
- Prune/tombstone diff (`emitDelete` for removed records) — **pass-through** — unchanged; also drops the removed id's fingerprint.
- Generic replication machinery (`ReplicatedRecordEmitter`, `ReplicatedPeerStreamReader`, `CoherenceJournal`) — **pass-through** — deliberately untouched (the fix is caller-side only).

---

## 1. Over-block

No block/allow surface — over-block not applicable. This is a replication-emit change, not a gate.
The one "suppression" is skipping a re-emit of an UNCHANGED record; a genuinely changed record (any
field differs, including status) still emits, so no legitimate state change is withheld.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The narrow correctness edge is a "false
unchanged": if a record's on-disk content ever diverged from what the journal actually holds (e.g. a
crash between `writeFile` and the emit in the OLD code), the seed would treat it as already-emitted
and skip re-emitting it. This is bounded by the existing peer-pull/sync backstop (peers reconcile
full streams), and it is strictly safer than the pre-fix behavior (a guaranteed event-loop wedge).
Documented in the code comment on `lastEmittedActionFp`.

---

## 3. Level-of-abstraction fit

Correct layer. The bug was in the manager's **caller-side** emit loop deciding WHICH records to hand
to the emitter — not in the generic replication substrate. The fix stays there: it changes only how
many records the manager emits, leaving the journal/emitter/reader contract identical. This
deliberately avoids touching the generic `loadWitness`/`materialize` path (the "risky replication
machinery"): making the witness lookup itself cheap (not scanning the whole store per key) is a
separate, deeper optimization tracked as follow-up (see Conclusion). Notably, the sibling replicated
stores (RelationshipManager, PreferencesManager) already emit only the single changed record — this
fix brings EvolutionManager into line with that existing, correct pattern.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change is a data-write/replication optimization with no blocking authority. The emit remains
best-effort and try/catch-guarded exactly as before (a replication fault never breaks the local
write); the fingerprint is recorded only after a successful emit, so a throw leaves the record to be
retried on the next save.

---

## 5. Interactions

- **Shadowing:** none. The emit loop runs after the local `writeFile` persists state (unchanged
  order); the fingerprint skip runs before `emitPut` and only decides whether to call it.
- **Double-fire:** the fix REDUCES emits (fewer journal records), never adds one. The journal's own
  op-key dedup is downstream and unaffected.
- **Races:** the fingerprint map is per-`EvolutionManager` instance, in-memory, and mutated only on
  the synchronous save path (single-threaded event loop) — no shared-state race. Two managers over
  the same dir (rare; e.g. a per-request instance) each keep their own map; the worst case is one
  extra cold re-emit, bounded by the seeding.
- **Feedback loops:** this BREAKS the existing doom loop (re-emit-all → journal bloat → slower scan →
  worse). It introduces no new feedback loop.

---

## 6. External surfaces

- **Other agents / peers:** peers receive strictly FEWER redundant `evolution-action-record` /
  `learning-record` journal entries. The union/materialize read on the receiving side folds to the
  latest per (origin, recordKey) regardless of how many redundant copies arrived, so a peer's
  resolved view is identical — it just stops accumulating duplicates. The load-bearing "a peer sees
  the latest status" property is preserved (a status change re-emits) and covered by
  `tests/e2e/ws2-evolution-actions-cross-instance.test.ts` (green).
- **Persistent state:** the replication journal stops bloating. Existing bloat (the ~53 MB
  `evolution-action-record` peer stream) is not deleted by this change — it stops growing and is
  trimmed over time by the existing archive-rotation / aggregate-budget machinery. No migration.
- **Operator surface (Mobile-Complete):** no operator-facing actions — not applicable.
- **External systems:** none (no Telegram/Slack/GitHub/Cloudflare surface).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or
grant/revoke/secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** — this IS a replication-path change. The state (evolution actions, learnings) follows
the agent across machines via the coherence-journal `evolution-action-record` / `learning-record`
kinds, gated by `multiMachine.stateSync.evolutionActions` / `.learnings`. The fix preserves that
replication (changed records still cross machines) while removing the redundant re-emits that caused
the wedge and the journal bloat. It emits no user-facing notices (no one-voice concern). It holds no
new durable state (the fingerprint map is in-memory, seeded from disk on attach). It generates no
URLs. On a single-machine agent the emitter is not attached (dark), so the change is a strict no-op
there.

---

## 8. Rollback cost

Pure code change — revert `src/core/EvolutionManager.ts` and ship a patch. No persistent state to
clean up (the in-memory fingerprint map simply stops existing on revert; reverting restores the old
re-emit-all behavior, i.e. the wedge returns but nothing is corrupted). No agent state repair. No
user-visible regression during the rollback window. The existing journal bloat is orthogonal to the
code change (rolling back does not re-inflate anything already trimmed).

---

## Conclusion

This review produced no design changes. The fix is contained to the manager's caller-side emit loop,
brings EvolutionManager into line with how the sibling replicated stores already emit (single changed
record), and is proven with a failing-first test that pins the emit COUNT (the wedge multiplier).
One follow-up is flagged, not blocking: even after this fix, a single emit still calls `loadWitness`
→ `materialize()`, which reads the whole (now non-growing) store journal — ~hundreds of ms on the
current ~53 MB bloat, a block but not a wedge. Making the witness lookup itself O(1)-ish (index the
per-key max HLC instead of re-materializing the whole store) is a deeper optimization in the generic
`ReplicatedPeerStreamReader` and is deliberately OUT of scope here to keep this fix off the risky
replication machinery; it should be tracked as a follow-up along with a one-time compaction of the
already-accumulated journal bloat. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** Echo (independent read)
**Independent read of the artifact: concur**

The fix targets the proven root cause (re-emit-all + per-emit whole-journal scan), stays off the
generic replication substrate, preserves the tested status-change-propagation guarantee, and is
backed by a failing-first test. The residual (per-emit materialize cost on the existing bloat) is
honestly scoped as a non-blocking follow-up.

---

## Evidence pointers

- `tests/unit/evolution-manager-emit-wedge.test.ts` — new; failing-first proof against pre-fix code
  produced exactly the O(N) counts (820 / 5 / 1 / 31 / 325), passes after the fix.
- Live forensics: `evolution-action-record` peer journal = 61,649 records over 632 distinct
  recordKeys (max re-emits of one key = 112), ~53 MB; local `action-queue.json` = 1,188 actions;
  `GET /write-admission` `eventLoop.starvedWindows24h = 13`.
- `tests/unit/evolution-manager-action-replication.test.ts`,
  `tests/unit/evolution-manager-learning-replication.test.ts`,
  `tests/integration/ws25-evolution-actions-emit.test.ts`,
  `tests/e2e/ws2-evolution-actions-cross-instance.test.ts` — unchanged, green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes a code performance/event-loop defect
in a data-write path (`EvolutionManager.saveActions`/`saveLearnings`), not an LLM prompt, hook,
config, skill, or standards text. It is not a self-triggered controller in the
`unbounded-self-action` class: the emit loop runs synchronously as part of a write the agent
explicitly performs (add/update an action or learning), not on its own timer/monitor/recovery
trigger.
