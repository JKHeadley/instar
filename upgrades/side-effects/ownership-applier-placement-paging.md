# Side-effects review — OwnershipApplier placement paging

**Change:** `OwnershipApplier.tick()` now walks every page of the `topic-placement`
journal query (bounded, using the reader's existing keyset cursor) instead of reading a
single page. `PlacementReader` gains an optional `cursorFor` and a `cursor` query option;
`maxScanPages` is threaded through the wiring factory.

**Tier:** 1, declared. The signal moved between my planning run and the commit gate and the
record should say so: my pre-commit classifier run over all 3 changed files + the test file
said `suggestedTier 1, riskFloor 1`; the commit gate itself, over the 3 in-scope source
files (194 LOC), printed `suggestedTier=2 (size=2, riskFloor=1)`. The declaration is Tier 1
on reasoning, at the risk floor and not below it (the floor — the only threshold that
raises a `belowFloor` audit flag — is 1): a bounded completeness fix in one consumer
module, no new authority/route/config/migration, rollback a plain revert. The SIZE half of
the signal crossed a line-count threshold on artifacts and comments, which is not what the
size heuristic is a proxy for. The decision is recorded in the audited decisions file
either way. Phase 5 second-pass review was run regardless — the change is adjacent to
session-lifecycle decisions — and the reviewer's four concerns are all fixed here.

**Root cause (measured, not inferred).** A `topic-placement` query is ordered
EPOCH-DESCENDING (`CoherenceJournalReader.compareKey`) and clamped to 500 rows
(`READER_MAX_LIMIT`). One page is therefore "the 500 highest-epoch rows", not the 500 most
recent. The applier read one page. Live measurement on the Mac Mini, 2026-09-05:

| probe | result |
|---|---|
| single page (`limit: 1000` → clamped 500) | 500 entries, **33** distinct topics, epoch floor **6**, max **173** |
| exhaustive cursor walk, same reader | 3 pages, 1015 entries, **150** distinct topics |
| topic 69507 (epochs 1, 2) | **absent** from page 1; **found on page 2** |

Consequence: the Mini never materialized ownership for 69507, so
`GET /pool/ownership-view?key=69507` returned `{owner:null, epoch:0, status:null}`, so every
drain refused `refused-not-owner` with `observedStatus:"none"` (logged 18:58:16Z and
21:44:45Z, identical). The operator's pinned transfer could not land; `pinState: diverged`
for ~4h with no self-heal.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing is rejected. The change is strictly additive in what it READS; it adds no
predicate, filter, or refusal path. Every entry the applier accepted before is still
accepted identically — the per-entry validation, the epoch fence, the `transferring`
downgrade and the fast-forward CAS are untouched. The only behavioural delta is that MORE
entries reach that unchanged logic.

## 2. Under-block — what failure modes does this still miss?

- **The per-file newest-500 tail cap.** `readTailTolerant(io, file, READER_MAX_LIMIT, …)`
  reads at most 500 entries per stream FILE, before the merge. Measured: a single file with
  700 rows exposes only 500 distinct topics even under exhaustive paging. This is a second,
  independent completeness limit in the same family, and it contradicts the reader's own
  header comment promising `topic-placement` queries are ANSWER-COMPLETE.

  **Urgency corrected after review.** My first draft wrote "not biting today" and set a
  month-out date — headroom asserted without a rate, which the reviewer flagged as an
  unsourced assumption. Measured rather than assumed (2026-09-05):

  | stream | rows | growth | headroom | crosses 500 in |
  |---|---|---|---|---|
  | Studio | 384 | 21.8/day | 116 | **~5 days** |
  | third machine | 383 | 5.0/day | 117 | ~23 days |
  | Mini | 249 | 3.2/day | 251 | ~77 days |

  So the headroom is days, not weeks, and `rotateKeep: 0` means there are no archives to
  fall back on. Tracked: <!-- tracked: ACT-1811 --> **ACT-1811** (high, due 2026-09-10;
  supersedes ACT-1810, cancelled because its date rested on the unmeasured assumption).

  Still NOT bundled into this PR, deliberately: raising that bound interacts with the 4MB
  byte ceiling and changes the memory profile of every placement read — a materially larger
  blast radius that deserves its own spec rather than being smuggled into a fix PR. The
  deferral is tracked with an accurate date, not waved through.
- **The 4MB shared byte ceiling.** A journal larger than the ceiling still truncates, with
  `truncated: true`. The applier does not currently surface that flag. Not a regression (it
  never did), and the ceiling is far above live volumes.
- **Ownership records already wedged by this bug** are not retro-repaired by the code
  change; they converge on the next tick once the row becomes visible, which is the
  intended and sufficient path.

## 3. Level-of-abstraction fit

The fix sits in the CONSUMER, not the reader. That is deliberate. The reader's
epoch-descending order is correct for its other callers, and its cursor is a public,
documented, already-tested pagination contract designed for exactly this. Changing the
reader's sort key or cap would have altered every placement consumer to fix one of them.

Sweep of every `topic-placement` consumer. **Corrected after second-pass review:** my first
table listed 4 of 8 callsites and presented itself as complete — exactly the class of claim
this review exists to catch. Full enumeration
(`grep -rn "kind: 'topic-placement'" src/`):

| consumer | shape | affected? |
|---|---|---|
| `OwnershipApplier.ts` | cross-topic, no filter, needs completeness | **YES — this bug** |
| `WorkingSetPullCoordinator.ts:307` | `topic`-filtered, limit 20 | No — filter applied during collection, before sort/slice |
| `PoolActivityView.ts:199` | `topic`-filtered, limit 1 | No — same; ordering puts the highest epoch first |
| `server.ts:23714` | `topic`-filtered, limit 20 | No — same |
| `server.ts:23828` | `topic`-filtered, limit 1 | No — same |
| `server.ts:23861` | `topic`-filtered, limit 1 | No — same |
| `server.ts:22181` | `machine`-filtered, limit 1 | No — reads only `res.streams[machineId].lastTs`, which is stream metadata and independent of paging entirely |
| `routes.ts:9370` (`GET /coherence/journal`) | generic HTTP read | No — exposes `cursor`; paging is the caller's job |

The applier is the only consumer that asks a cross-topic question and therefore the only
one the epoch-descending page order can starve.

**Precision correction (also from review):** "complete for that topic" over-stated it. A
topic-filtered answer is complete only *within the newest-500-rows-per-file window*, because
the topic filter runs AFTER the per-file tail read. That window is the ACT-1811 limit above;
it bounds these callers too, not just the applier. No current caller is affected (live
streams are under the cap), but the wording should not have implied an unconditional
guarantee.

## 4. Signal vs authority compliance

Compliant, and the change moves in the safe direction. The applier is not an authority: it
adopts an ALREADY-DECIDED ownership from the journal (a replication step), and the module
comment says so explicitly. It runs no FSM transition, makes no block/allow decision, and
this change grants it no new authority — it only lets it see rows it was always intended to
see. If anything, the BUG created de-facto blocking behaviour (drain refusals) out of
incomplete data; completing the data removes an accidental authority rather than adding one.

## 5. Interactions

- **Does not shadow / get shadowed.** No other component materializes ownership from
  placements; the applier is the sole path.
- **Does not double-fire.** Keyset pagination is strict (`compareToCursor < 0`), so pages do
  not overlap. Even if they did, `bestByTopic` keeps the max epoch per topic and the store
  write is a fast-forward CAS — both idempotent.
- **Does not race adjacent cleanup.** Same 15s timer, same off-hot-path position, same
  write path. The tick does more reading before the same writes.
- **Existing behaviour preserved for narrow callers.** Existing fakes in
  `tests/unit/OwnershipApplier.test.ts` have no `cursorFor`; they take the single-page path
  and pass unchanged. Sourced counts (an earlier draft said "41 adjacent tests", which
  matched no measurement I had actually taken — review caught it):
  `OwnershipApplier.test.ts` **14**, `ownershipApplierWiring.test.ts` **6**, plus this
  change's own **10** = 30 in the directly-adjacent set, all green. The reviewer
  independently ran 66 across every file referencing `OwnershipApplier`, also all green.

## 6. External surfaces

- No HTTP route, config key, or user-facing string changes.
- `OwnershipApplyResult` gains three OPTIONAL observability fields
  (`pagesScanned`, `pageCeilingHit`, `pagingUnavailable`). Verified: the ONLY consumer is
  `src/commands/server.ts:22283`, which read `r.materialized` / `r.examined` — so the added
  fields could not break it.
- That consumer is extended to LOG the two degraded states. This is deliberate and is the
  same lesson as the bug itself: an applier silently scanning only part of the journal is
  precisely what deadlocked a transfer for four hours while every surface looked healthy.
  The ceiling and no-cursor states are now logged even on a tick that materialized nothing,
  so a future degradation announces itself instead of being inferred from an absent record.
  Log-only — no new route, metric, or alert.
- No timing or conversation-state dependency. Per-tick cost rises from 1 query to N
  (3 on the live journal, hard-capped at 40).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated — this IS the replication path.** The applier's whole job is consuming
`peers/<machineId>.topic-placement.jsonl` replicas and materializing them locally, and the
bug was a completeness hole in exactly that path. Posture notes:

- Every machine runs its own applier over its own replica set; there is no leader and no
  cross-machine call, so the fix converges independently on each machine as it updates.
- **Asymmetric-state note:** the incident's shape was one machine holding an `active` record
  naming a second machine that held no record at all. That asymmetry was NOT a replication
  failure — the journal row had replicated correctly and was on disk; it was a READ
  completeness failure on the receiving side. Worth stating because the obvious diagnosis
  ("replication is broken") would have been wrong.
- No user-facing notice is emitted, so no one-voice gating is needed.
- No durable state strands on topic transfer; no URLs are generated.
- A machine still on the old version keeps under-scanning until it updates — degraded, not
  incoherent, and identical to today's behaviour.

## 8. Rollback cost

Low. Revert the commit — the applier returns to a single-page read, which is exactly
today's shipped behaviour. No data migration (the change writes no new record shape and
adds no field to the store), no agent state repair, and records already materialized by the
paged walk are ordinary, correctly-formed ownership records that the old code also produces
and reads. No release coupling.

---

## Phase 5 — second-pass review

Reviewer: dedicated subagent, independent read of this artifact and the diff.

**Verdict: "Concur with the review on substance — the root cause is real, the fix is
correct, and the tests genuinely prove it. Four concerns raised, none of which block the
merge."**

The reviewer did not take the author's summary on trust. It re-derived the root cause from
`READER_MAX_LIMIT`, `clampLimit`, `compareKey` and `sortMerged` directly; it broke the fix
itself (`page < maxPages` → `page < 1`), re-ran, confirmed the key test fails with
`expected undefined to be 'm_self_mini'` (an absent ownership record — the user-visible
property, not an incidental mechanism), then restored and re-confirmed green. It also built
its own single-file fixture to test whether the multi-file fixture shape was justified, and
independently ran 66 tests across every file referencing `OwnershipApplier`.

All four concerns were accepted and fixed in this PR — including the two the reviewer
filed as follow-ups, since both were one-liners in code this diff already touches:

1. **`maxScanPages: NaN` scanned zero pages, silently** (reviewer probe C:
   `pagesScanned=0 examined=0 rec=null`, no log line — the exact silent-under-scan shape
   this change exists to remove). Fixed with a `Number.isFinite` guard, plus a test.
   **Honesty note:** falsification showed the guard alone is *not* load-bearing — the loop
   restructure (`pagesScanned >= maxPages` checked at the TOP) already makes `NaN` benign,
   because `0 >= NaN` is false. Removing the guard does not fail the test. The test is
   written against the observable contract ("never scan zero pages") and does fail against
   the original `for (page = 0; page < maxPages; page++)` form. The comment in the test says
   so rather than implying the guard is what saves it.
2. **`pageCeilingHit` false positive** (reviewer probe B: 1000 rows / 2 pages / budget 2
   reported a COMPLETE scan as a ceiling hit, which the new server logging would print as
   "INCOMPLETE — some topics may not be materialized"). **My first attempt did not actually
   fix this** — I moved the flag to the top of the loop and softened the wording, but in the
   reviewer's exact case the walk still has a live cursor and still flagged. Falsification
   caught that. The real fix is one bounded probe query with the live cursor when the budget
   is spent: empty ⇒ the scan was complete, don't flag. Costs one extra query only in the
   rare ceiling case. Both sides are now tested (does-not-flag when complete; still-flags
   when rows genuinely remain).
3. **Sweep table listed 4 of 8 callsites** while presenting itself as complete. Corrected in
   §3 above; all four missed callsites verified genuinely unaffected.
4. **Unsourced headroom claim** for the per-file cap. Measured; it is ~5 days on the busiest
   stream, not a month. ACT-1810 cancelled and replaced by ACT-1811 (high, due 2026-09-10).

Also corrected: the "41 adjacent tests" figure, which matched no measurement I had taken.

**What this review caught that I did not.** Two of my own fixes were vacuous when I first
wrote them, and I only found that by reverting each one and watching the test *not* fail.
Concern 2 in particular I had recorded as fixed when it was not. That is the same failure
mode a reviewer rejected in this repo earlier the same day — an author trusting that a test
proves what its name says.
