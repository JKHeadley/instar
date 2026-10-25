# Side-Effects Review — a released topic replicates as released (OwnershipApplier + journal)

**Version / slug:** `applier-released-replication`
**Date:** `2026-10-21`
**Author:** Echo (autonomous run, topic 127648)
**Second-pass reviewer:** reviewer subagent (session lifecycle / cross-machine ownership — Phase 5 required). Round 1 raised four concerns (recorded below, verbatim); all four are resolved in round 2 — see "Round-2 resolutions".

## Summary of the change

A `release` CAS on a topic's ownership record was journaled as `{owner, epoch, reason: 'released'}` with NO `status` field (the journal only carried `status` for `transferring`). Every peer's `OwnershipApplier` materialized that row as `active(owner = the releasing machine)` at the HIGHER epoch — so a topic a machine let go of looked, everywhere else, like that machine still owned it. Live consequence (2026-10-21, topic 127648): the Mini's local record was `released@3`, the Studio's was `active(mini)@3` (nonce `applier:m_4cbc…:3` — the applier's own write); the pin → Studio could never adopt (`deferred-no-evidence: owner alive`), the standby Mini kept spawning sessions it could not send from, and the operator's conversation went silent repeatedly.

Files touched:
- `src/core/CoherenceJournal.ts` — `PlacementData.status` union + source-side validator accept `'released'`.
- `src/core/JournalSyncApplier.ts` — receive-side validator accepts `status: 'released'` (mirrors the source validator, as its comment demands).
- `src/core/OwnershipApplier.ts` — (a) a row with `status === 'released'` OR `reason === 'released'` materializes a `released` local record; (b) **same-epoch status correction**: a released row whose local record is the applier's OWN earlier materialization of that exact (owner, epoch) — currently `active` — is rewritten to `released` (the fast-forward CAS can never repair an equal-epoch record, and a released topic produces no fresh higher-epoch row). Reported as `statusCorrected` in the tick result.
- `src/core/SessionOwnershipRegistry.ts` / `src/core/LocalSessionOwnershipStore.ts` — optional `correctMaterializedStatus(candidate)` on the store interface, implemented by BOTH shipped stores through ONE shared predicate (`isApplierStatusCorrection`): lands only when current and candidate share the applier nonce `applier:<owner>:<epoch>`, the owner, and the epoch, current is `active`, candidate is `released`. Fires the store's `onCommit` hook like every other persist.
- `src/commands/server.ts` — the `emitPlacement` funnel carries `status: 'released'` and normalizes `reason` to `'released'` whenever the CAS result record is released; the OwnershipReconciler's emit wrapper (server.ts ~23421) gets the same `released` arm (no reconciler CAS yields `released` today — SessionOwnership.ts:141-176 — so this closes a silent future regression, not a live one).
- `src/server/routes.ts` — the `POST /pool/transfer` release half, which emits DIRECTLY to the journal (not through the funnel), now carries `reason: 'released'` + `status: 'released'`. Release emit sites enumerated: server.ts funnel (release-on-complete, mesh `release` command, dashboard-topic-profile release, drain runner — all via `emitPlacement`), the reconciler wrapper, and the `/pool/transfer` direct emit. All three writers now carry the status.
- Tests: `tests/unit/OwnershipApplier-released.test.ts` (new, 9 — including the exact live precondition `active@3` with the applier nonce), `tests/unit/JournalSyncApplier.test.ts` (+1), `tests/unit/CoherenceJournal.test.ts` (+1).

## Decision-point inventory

- `OwnershipApplier.tick()` materialization — **modify** — which local `status` a replicated placement produces, plus the bounded same-epoch correction. Not a block/allow gate; it writes the routing substrate the reconciler and router read.
- `SessionOwnershipStore.correctMaterializedStatus` — **add** — a same-epoch write that is admissible ONLY for the applier's own prior write (nonce-checked on both sides). A local CAS decision (any non-applier nonce) is never touched.
- `CoherenceJournal.validate()` / `JournalSyncApplier.validateData()` topic-placement — **modify** — the allowed `status` values (widened by one).
- `emitPlacement` (server.ts), the reconciler emit wrapper, the `/pool/transfer` direct emit — **modify** — what a release writes to the journal. Pass-through for every non-released record.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The only "rejection" surface is the journal validator, which now accepts strictly MORE (`released`) than before; nothing previously accepted is now rejected.

---

## 2. Under-block

- **Rolling-update window — stated plainly.** An OLD peer (pre-fix) receiving a `status: 'released'` row schema-rejects it; in `JournalSyncApplier` (~479-487) an invalid entry marks that machine's `topic-placement` stream `suspect` AND stops the batch at the last valid line without advancing `lastHeldSeq` — so EVERY later placement from that machine (all topics) stops replicating to the old peer until the old peer updates; `topic-placement` retention is `rotateKeep: 0`, so the gap sentinel never skips the row. This is the same shape Fix #3 (`transferring`, 2026-06-30) accepted. Why the explicit status anyway, when the applier already honors the bare `reason: 'released'` that old peers accept: the reason-only form would leave the schema dishonest forever (a release that is only inferable from a string the reader must know about), and the reconciler/dashboard emit wrappers hard-code their own `reason`, so a reason-only contract would have silently excluded them. The window is bounded by the auto-updater (minutes); an old peer's stream resumes at the first pull after it updates (the row then validates). Accepted on the Fix #3 precedent, said out loud.
- Rows written by OLD peers after this ships still carry no `status` — the `reason === 'released'` branch materializes them correctly, so an un-updated releaser is handled.
- `placing` records (the first half of place→claim) are still journaled without a status and materialize as `active`. Unchanged; the claim lands moments later at epoch+1 and overwrites it. Out of scope, noted.
- `stale-owner-release`: `OwnershipReconciler.ts:652` passes that reason to the server.ts wrapper, which hard-codes `reason: 'reconcile'` and ignores the passed value — so the row is NOT schema-rejected today and there is no gap here (the round-1 artifact claimed one; corrected).
- The same-epoch correction only repairs records the applier itself wrote (nonce-matched). A wrong `active` record produced any OTHER way at an equal epoch is not touched — by design (never rewrite a local decision); none is known to exist.

---

## 3. Level-of-abstraction fit

Right layer. The journal is the replication substrate; `status` is the field the applier reads; the emit funnel plus the two non-funnel writers are the complete set of release writers. Fixing it at the reason-string level only would have left the schema dishonest; carrying an explicit status is how `transferring` already travels. The same-epoch correction lives in the store (the ONE place that owns the fast-forward rule) behind a shared predicate, not as an applier-side bypass of the CAS.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It changes the fidelity of a replicated state record. The authorities that act on it (OwnershipReconciler adopt/transfer, the router's place) are unchanged and already existed; they now receive a truthful input. The same-epoch correction introduces no authority: it rewrites the applier's own earlier write from the same journal row, never a record a local CAS produced.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Was this CAS a release?" and "is this local record the applier's own write of this row?" are both enumerable from the records themselves — invariants, not judgments.

---

## 5. Interactions

- **Shadowing:** the `released` branch in the applier is checked BEFORE the `transferring` branch. A row cannot be both: the FSM yields `released` only from a `release` on an `active` record (SessionOwnership.ts:165-176), and the funnel returns early on `!r.ok`, so `reason: 'released'` always pairs with a released record. Unit test "transferring is still materialized as transferring".
- **Double-fire:** none. The releasing machine already holds the released record locally (CAS); peers now hold the same. The reconciler on the pin target then runs its EXISTING `no live record + pin names me → adopt` branch — one place→claim, journaled, replicated. That is the designed handoff, not an extra fire. The same-epoch correction is idempotent (test: a second tick is a no-op).
- **Races:** the fast-forward-only CAS is untouched for every write except the nonce-bound correction. A release at epoch N vs a concurrent claim at N+1 resolves exactly as today (higher epoch wins; test "a released row at a LOWER epoch never clobbers a fresher local active claim"). A correction can never regress a record that a local CAS has since advanced (the epoch would differ) or rewritten (the nonce would differ).
- **Feedback loops:** none added. Fewer, in fact: the standby's respawn-for-a-topic-it-cannot-answer loop was fed by the false `active` record.
- **WriteAdmission ownership index** consumes `onCommit` for every persisted record (both stores fire it from the correction too); `WriteAdmission.ts:343` already treats `released` as absent-owner, so peers now reach the SAME verdict as the releaser. `DuplicateSessionReconciler` / `StrandedTopicSentinel` consume injected ownership views and read no `reason`/`status` from the journal.
- **`reason` consumers:** grep of `src/` shows the applier is the only reader of a placement row's `reason`; normalizing `user-move` → `released` for released records breaks nothing, and the `(topic, epoch)` journal op-key is untouched.

---

## 6. External surfaces

- Other agents on the machine: none (per-agent state dir).
- Install base: every multi-machine agent gets correct cross-machine release semantics; single-machine agents have no journal peers — no-op.
- External systems: none. No Telegram/Slack/GitHub calls.
- Persistent state: the per-topic ownership JSON files and the journal — one additional legal field value, and the one-time same-epoch correction of already-wrong applier-written records (nonce-bound). No migration; old rows are read correctly via the reason branch.
- Timing: converges on the next applier tick after the row replicates (or, for an already-wrong record, on the first tick after update).
- Operator surface: no operator-facing actions — not applicable.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** — this IS the replication path (coherence-journal `topic-placement` → `OwnershipApplier`). The defect was precisely a multi-machine incoherence: the releaser and its peers disagreed about a record's status. No user-facing notices emitted; durable state is the ownership record, which now agrees across machines after a transfer/release; no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the source files; ship a patch. Pure code.
- **Data migration:** none forward. On ROLLBACK, a reverted peer schema-rejects the first `status: 'released'` row already in a stream and — per §2 — halts that machine's whole `topic-placement` stream on the reverted peer until it is updated again (the row never rotates out). Nothing corrupts, but a rollback is NOT a clean return to the old state: it re-creates the stuck-pin symptom AND a stream halt. A rollback that must stay rolled back would need a forward patch that drops the `status` field from the emitters (keeping the applier's reason branch), not a bare revert.
- **Agent state repair:** none required forward; records corrected active→released stay released (true state).
- **User visibility:** the stuck-pin symptom would return on rollback; no new regression beyond the halt above.

---

## Conclusion

A fidelity fix on the ownership replication path plus a bounded, nonce-bound same-epoch correction so the records this bug ALREADY wrote are repaired without a re-emit — verified against the exact live precondition that stranded topic 127648 (`tests/unit/OwnershipApplier-released.test.ts`: `active(mini)@3` with nonce `applier:<mini>:3` + the `released@3` row → `released@3`, idempotent). No new authority, no new gate. The round-1 second pass found four real problems: the same-epoch skip (now the correction branch), the un-funneled `/pool/transfer` release emit (now carries the status), a wrong claim about `stale-owner-release` (corrected), and an understated rolling-update/rollback cost (now stated plainly in §2 and §8). Live proof after release: `GET /pool/placement?topic=127648` on the Studio shows `pinState: actuated`, owner = Studio, after the Studio's applier tick corrects its record and its reconciler adopts.

---

## Second-pass review (if required)

**Reviewer:** reviewer subagent (Claude)

**Round 1 — independent read of the artifact: concern** (verbatim):

- **The fix does NOT repair the live incident it cites (equal-epoch records are never re-materialized).** `src/core/OwnershipApplier.ts:296` skips any row whose `epoch <= localEpoch` (fast-forward only), and `src/core/LocalSessionOwnershipStore.ts:123` `casWrite` requires a strictly greater epoch. The Studio's wrong record is `active(mini)@3` (nonce `applier:m_4cbc…:3`) and the journal row is `released@3` — same epoch — so after this ships the Studio still holds `active(mini)@3` … Resolution: (a) add a bounded same-epoch status-correction branch — when the local record carries the applier's own nonce, `status === 'active'`, and the row now reads released, rewrite the status, with a test that starts from `active@3`; or (b) remove the convergence claim.
- **"Every release site funnels here" is false — `src/server/routes.ts:22818` (`POST /pool/transfer`'s release half) emits directly to the journal with `reason: 'user-move'` and NO `status`.** … Resolution: carry `status: 'released'` on that emit. The OwnershipReconciler's emit wrapper at `src/commands/server.ts:23421` likewise carries no `released` arm; safe today, a one-line arm closes a silent future regression.
- **The `stale-owner-release` bullet in §2 is factually wrong (no code change needed).** The server.ts wrapper hard-codes `reason: 'reconcile'`, so that row is NOT schema-rejected today.
- **Rolling-update back-compat is understated — an old peer's view of the releasing machine's ENTIRE `topic-placement` stream halts.** `JournalSyncApplier.ts:479-487` … `rotateKeep: 0` … state the halt plainly and why schema honesty was chosen over the reason-only form.
- Affirmed on the remaining checks: the `released` branch precedes `transferring` and cannot swallow it; no consumer keys on `reason` other than the applier; the `(topic, epoch)` op-key is untouched; `WriteAdmission.ts:343` already treats `released` as absent-owner; the duplicate reconciler / stranded sentinel read no journal `reason`/`status`.

**Round-2 resolutions (author):**
1. Same-epoch correction implemented as resolution (a): `SessionOwnershipStore.correctMaterializedStatus` (both stores, one shared predicate `isApplierStatusCorrection` — nonce on BOTH sides, owner, epoch, active→released) + the applier branch; `statusCorrected` reported; tests from the live `active@3` precondition, a local-CAS-nonce negative, a different-owner negative, idempotency, and the in-memory store with `onCommit`.
2. `/pool/transfer` release half carries `reason: 'released'` + `status: 'released'`; the reconciler wrapper gained the `released` arm. Summary rewritten to enumerate the three writers.
3. `stale-owner-release` bullet corrected (no gap).
4. §2 and §8 now state the stream halt, the retention reason, why the explicit status was chosen over reason-only, and that a bare revert is not a clean rollback.

**Round 2 — independent read of the artifact: concur**

- Concern 1 resolved: the applier branch (`OwnershipApplier.ts:307-324`) fires only on `best.epoch === localEpoch && best.status === 'released' && local.status === 'active'`, and `isApplierStatusCorrection` (`SessionOwnershipRegistry.ts:91-104`) additionally requires the nonce `applier:<owner>:<epoch>` on BOTH current and candidate plus owner + epoch equality — so a local-CAS record (nonce `<self>:rel|claim|…`) can never be rewritten, a `transferring` record is excluded by the `active` check, and a non-release row cannot reach it because `best.status === 'released'` requires `status: 'released'` or `reason: 'released'`, and every `'released'` reason in `src/` pairs with a `release` CAS whose FSM result is always `status: 'released'` (`SessionOwnership.ts:165-176`; the funnel returns early on `!r.ok`). The `continue` after the attempt masks nothing: `bestByTopic` holds only the max-epoch row per topic, so an equal epoch means no newer row exists, and the fast-forward path would `continue` on `epoch <= localEpoch` anyway. The in-memory store fires `onCommit` (`SessionOwnershipRegistry.ts:75-85`); the Local store routes through `persist()` (cache + `onCommit` + atomic tmp→rename to disk, `LocalSessionOwnershipStore.ts:85-105`). Verified by the live-precondition test (`active@3`, applier nonce → `released@3`, idempotent) — 9/9 pass.
- Concern 2 resolved: `grep emitPlacement(` across `src/` shows exactly three direct journal writers — the funnel (`server.ts:23657`), the reconciler wrapper (`server.ts:23421`), and `/pool/transfer`'s release half (`routes.ts:22818`) — and all three now carry `status: 'released'` + `reason: 'released'` for a released record; `routes.ts:22872` is the place/claim half (never released); every other callsite (release-on-complete 23773, mesh `release` 23848, drain runner 24174, dashboard-topic-profile 25795, dmc 25824, nickname-relocation release half 27433) goes through the funnel.
- Concern 3 resolved: `OwnershipReconciler.ts:652` passes `'stale-owner-release'` to `d.emitPlacement`, and the wrapper at `server.ts:23421` ignores the passed reason (`rr.status === 'released' ? 'released' : 'reconcile'`); a force-claim yields `status: 'active'`, so the row carries `reason: 'reconcile'` and is never schema-rejected — "no gap" is correct.
- Concern 4 resolved: `JournalSyncApplier.ts:479-487` marks the stream `suspect` on an invalid entry and breaks, and `lastHeldSeq` advances only by the valid prefix (`:496-498`), so the next pull re-hits the same row — the whole stream halts; `topic-placement` is `rotateKeep: 0` (`CoherenceJournal.ts:254`, "rotate but NEVER delete", `:1546-1549`), so `oldestRetainedSeq` never passes the row and the gap sentinel (`:440-442`) never fast-forwards past it. §2 and §8 state this accurately (precision note, not a defect: on rollback the halt applies to rows not yet pulled; rows already held re-materialize as `active` through the old applier since `query()` does not re-validate on read — §8's "stuck-pin symptom returns" already covers that).
- Sanity: `npx tsc --noEmit -p .` exit 0; `OwnershipApplier-released` (9) + `OwnershipApplier` (14) + `LocalSessionOwnershipStore` (8) + `SessionOwnershipRegistry` (6) = 37 passed; `JournalSyncApplier` (31) + `CoherenceJournal` (41) = 72 passed. The five other `topic-placement` consumers (`WorkingSetPullCoordinator.ts:307`, `PoolActivityView.ts:202`, `server.ts:25290/25404/25437`) read only `prevOwner` / `epoch` / `ts` / `owner`-for-a-read-only-pull — none keys on `reason` or `status`, so §5's "applier is the only reader of `reason`" holds.

---

## Evidence pointers

- Live state before the fix (2026-10-22T03:1xZ): Mini `.instar/ownership/local/127648.json` = `released@3`; Studio = `active(m_4cbc…)@3` with nonce `applier:m_4cbc…:3`; the journal row `{owner: m_4cbc…, epoch: 3, reason: 'released'}` (no status); Studio reconciler verdict `deferred-no-evidence`; Mini verdict `not-my-move`.
- `npx vitest run tests/unit/OwnershipApplier-released.test.ts tests/unit/OwnershipApplier.test.ts tests/unit/OwnershipApplier-placement-paging.test.ts tests/unit/LocalSessionOwnershipStore.test.ts tests/unit/SessionOwnershipRegistry.test.ts` — 47 passed; `tests/unit/JournalSyncApplier.test.ts` (31) + `tests/unit/CoherenceJournal.test.ts` (41) passed on the journal change.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a TypeScript replication bug, not a prompt/hook/config/skill defect; no self-triggered controller added or modified).
