# Side-Effects Review — Stop the throughput fixture expiring on a calendar date

**Version / slug:** `fix-expiring-throughput-fixture`
**Date:** `2026-07-30`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required — test-only change, no decision-point surface`

## Summary of the change

`tests/e2e/throughput-series-live.test.ts` fed the throughput route a stub PR with literal dates (`createdAt: '2026-07-22T12:00:00Z'`, `mergedAt: '2026-07-23T12:00:00Z'`). The route keeps only PRs where `cutoff <= mergedAt <= now` with `cutoff = now - days` (`src/server/throughputRoutes.ts:114-117`), so at `2026-07-30T12:00:00Z` the stub fell out of the rolling 7-day window, `rows` became `[]`, and the assertion failed. Every open PR went red within the hour — reproduced locally on a branch off `origin/main`, so it is not caused by any in-flight change.

The stub's dates are now derived from `Date.now()` (merged −24h, created −48h). Files touched: `tests/e2e/throughput-series-live.test.ts` only. No `src/` change.

## Decision-point inventory

No decision point. This is a test fixture; it gates nothing, blocks nothing, and constrains no agent behavior.

- `tests/e2e/throughput-series-live.test.ts` — **modify** — stub dates made relative to now instead of literal.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Other hardcoded dates elsewhere.** This fixes the one fixture that expired. A repo-wide sweep for literal dates inside time-windowed assertions is not attempted here, so a sibling time bomb could exist and would surface the same way — red on a date, with no code change to blame. Recording this rather than silently scoping it out. <!-- tracked: ACT-1613 -->
- **No structural guard against reintroduction.** Nothing prevents a future author typing a literal date into a windowed test. The mitigation is a comment naming the exact failure at the exact site, which is weaker than a lint. A lint would need to distinguish a date used as a window input from a date used as inert data, which is not obviously decidable — so a comment is the honest level of protection here rather than a guard I would be overstating. <!-- tracked: ACT-1613 -->

---

## 3. Level-of-abstraction fit

Correct layer. The bug is in the test's own fixture data, and that is where it is fixed. The route's windowing behavior is right and is deliberately untouched — the test was wrong about time, not the code.

The alternative was freezing the clock (`vi.setSystemTime`). Rejected: it would make this test's passing depend on fake-timer setup interacting with the route's real `Date.now()` calls, which is more machinery and more coupling than deriving two dates.

---

## 4. Signal vs authority compliance

Not applicable — no authority and no signal. Per `docs/signal-vs-authority.md` the principle governs decision points; a test fixture is neither.

---

## 5. Interactions

- **The 24h created→merged gap is preserved on purpose.** `metrics()` derives `medianLatencyH` from `mergedAt - createdAt`, and `team.index` is computed from latency alongside merges and LOC. Changing the gap would move the expected `index: 80` and force an assertion edit that was never wrong. Verified by running the file: 3/3 pass with the assertion untouched.
- **Day bucketing** (`pacificDay`) now buckets to "yesterday in Pacific time" rather than a fixed calendar day. The test asserts on `rows[0]` and not on a specific date, so this is immaterial.
- **No shadowing or double-firing** — nothing else consumes this fixture.
- **Does not mask the Vercel check failure** also present on PR #1753; that is a separate, unrelated red and is not addressed here.

---

## 6. External surfaces

None. Test-only: no route, hook, template, scaffold, migration, or runtime behavior changes. Nothing visible to any user, agent, or external system. The only externally-visible effect is that CI can go green again.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — and not meaningfully a posture question: this is a test file executed by whichever runner checks out the repo. There is no agent state, no replication path, no merged read, no user-facing notice, no durable state that could strand on topic transfer, and no generated URL. Stated explicitly rather than omitted, because the question exists to catch silent single-machine assumptions in features, and this is not a feature.

---

## 8. Rollback cost

Zero. `git revert` restores the previous literals — which would immediately re-red CI, so the revert is only meaningful alongside a different fix. No migration, no state repair, no release coupling.
