# Side-Effects Review — /health counts a job failure only while it can still change

**Version / slug:** `health-job-failure-currency`
**Date:** `2026-10-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (Tier 1: 145 LOC, one extracted pure predicate plus one read-only route field, no config, no migration, no persistent state)

## Summary of the change

`GET /health` summed every scheduled job's `consecutiveFailures` with no bound and reported the total as `consecutiveJobFailures`, which also feeds the `>= 5` degrade condition. That count only resets on a successful run, so a **disabled** job keeps its last count permanently — nothing can ever bring it down. Measured on a working agent on 2026-10-21: `consecutiveJobFailures: 119`, `status: degraded`, where 118 belonged to `w29-working-set-mirror` (`enabled: false`, `lastRun: 2026-09-26`, twenty-five days earlier). The predicate is extracted to `src/server/jobFailureCurrency.ts` (`summarizeJobFailures`) and `src/server/routes.ts` consumes it: a job's failures count toward health when the job is enabled **and** ran within 24h; everything excluded is reported under a new authed-only `staleJobFailures` field naming the slug, count, last run, and whether it was excluded as `disabled` or `stale`.

## Decision-point inventory

- `routes.ts` `/health` → `isDegraded` input `totalFailures` — **modify** — the same `>= 5` threshold now reads a currency-bounded sum instead of an unbounded one.
- `jobFailureCurrency.summarizeJobFailures` — **add** — a pure predicate splitting recorded job failures into current and excluded.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change cannot refuse a request; it only changes two reported numbers and one status string.

The analogous risk is **over-exclusion**: a real failure classified as stale and dropped from the verdict. Two concrete shapes, both handled. (a) A job on a cadence longer than a day — a weekly job that failed six days ago is excluded although nothing has had a chance to fix it. It still appears in `staleJobFailures` with `reason: stale`, so it is visible, but it no longer degrades the agent. Accepted deliberately: the alternative is a weekly job's single failure pinning the verdict for a week. (b) A job whose `lastRun` is absent or unparseable — deliberately counted as **current**, so a corrupt state file over-reports rather than silences.

## 2. Under-block

No block/allow surface — under-block not applicable.

The analogous risk is **under-reporting**: something still slips. Known and stated. The 24h window is wall-clock, not cadence-aware: it does not read a job's cron expression, so a 6-hourly job and a daily job are treated alike. A cadence-aware window (`stale` = older than N intervals of this job's own schedule) is the better predicate and is deliberately not built here — it needs the schedule parser and a decision about jobs with no cron at all. The flat window is a strict improvement over no window and does not foreclose it.

---

## 3. Level-of-abstraction fit

Right layer, and deliberately the lowest one that works. This is a **detector** with no authority of its own: it computes a number that an existing condition (`totalFailures >= 5`) already consumed. Nothing new gained block authority. The exact same shape already exists one layer over in `DegradationReporter.HEALTH_WINDOW_MS` (30 min), whose comment states the identical lesson — a single old event "would otherwise pin the dashboard 'Degraded' badge red for the whole process lifetime even after recovery". That precedent was consulted rather than re-derived, and the window differs from it (24h vs 30 min) for a stated reason: a job's cadence is its own, so the degradation window would drop a daily job's real failure.

The predicate is extracted to its own module rather than left inline specifically so it is testable at this layer instead of only through HTTP.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

`summarizeJobFailures` is pure arithmetic over durable job state. It holds no block authority: it narrows the input to a pre-existing numeric condition and adds a read-only field. The threshold, the condition, and every consumer are untouched. Brittleness risk is therefore bounded to "a reported number is wrong", which is the class the change is fixing, not creating.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no competing live signals here: "is this job enabled" is a declared boolean from the job definition, and "when did it last run" is a recorded timestamp. Both are enumerable facts, not a judgment between conflicting evidence. The only tunable is the window length, and it is a named constant with its reasoning in the module header, not a magic number at a decision point.

---

## 5. Interactions

- **Shadowing:** `totalFailures` is computed before the `isDegraded` expression and before the degradation-window read; ordering is unchanged. The degradation window (`DegradationReporter.getRecentEvents`) is an independent term of `isDegraded` and is not affected — a currently-degrading event still degrades regardless of job counts.
- **Double-fire:** none. Nothing acts; two numbers are reported. `grep` over `src tests scripts` finds exactly one consumer of `consecutiveJobFailures` (the assignment itself) — no dashboard renderer, hook, or script reads it, so no downstream parser changes behaviour.
- **Races:** read-only. `getJobState` and `getJobs` are the same calls the previous loop made, in the same place, once per request.
- **Feedback loops:** none. `/health` does not feed the scheduler; a lower reported count cannot cause or suppress a job run. Worth stating explicitly because the opposite would be a real loop: if anything throttled jobs on this number, lowering it would change job behaviour. Nothing does.

---

## 6. External surfaces

- **Other agents on the machine / install base:** the lifeline polls `/health`. It reads `status` and the gate-route fields, not the job counters. An agent that was reporting `degraded` purely because of historical job failures will now report `ok` — which is the intended correction, and is visible to anything watching `status`.
- **External systems:** none.
- **Persistent state:** none written. Job state is read, never modified; no migration, no new file, no new config key.
- **Timing we do not control:** the 24h window is evaluated against `Date.now()` at request time, so a clock jump backwards could briefly reclassify a stale job as current (over-reporting, the safe direction).
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or touched. `staleJobFailures` is authed-only read data on an existing endpoint; there is no new form, grant, or approval. The operator-visible improvement is that the existing dashboard health badge stops being red for an unfixable reason.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, markup file, approval page, or grant/secret form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, with the reason: job state and the scheduler are per-machine, and `/health` is explicitly a per-machine report — each machine runs its own scheduled jobs and reports its own failures. A job disabled on one machine may be enabled on another, so a replicated "job failure" count would be meaningless, and the pool-wide question is already answered by proxied-on-read merged views (`?scope=pool` on the surfaces that have it, and `GET /guards?scope=pool` for posture). This change does not alter that: it makes each machine's own report honest.

Explicitly: it emits **no** user-facing notices (so no one-voice gating is needed), holds **no** durable state (nothing to strand on a topic transfer), and generates **no** URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the two source files and ship as the next patch. The change is pure computation.
- **Data migration:** none. No persistent state is written or altered.
- **Agent state repair:** none. Existing agents' job state is untouched; the reported number changes on the next `/health` request after the update, in both directions.
- **User visibility during rollback:** an agent would go back to reporting its historical failures and showing a degraded badge — the pre-change behaviour, not a new regression.

---

## Conclusion

The review produced one design change: the excluded failures are **reported** rather than simply dropped. The first cut only skipped them, which would have traded a false alarm for a silence — the opposite defect, and the worse one, since a disabled-but-failing job is exactly the thing someone should eventually delete or re-enable. It also produced one honest limitation, stated rather than hidden: the window is wall-clock, not cadence-aware, so a job on a longer-than-daily cadence is excluded sooner than its own schedule would justify. Clear to ship; the cadence-aware window is a later improvement this does not block.

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: n/a**

## Evidence pointers

- `tests/unit/job-failure-currency.test.ts` — 11 tests, both sides of every boundary plus the exact production shape (118 disabled + 1 current → 1).
- `tests/integration/health-stale-job-failures.test.ts` — 4 tests through the real route pipeline: the incident shape, omission of the field when nothing is excluded, five current failures still degrading, and the excluded detail absent for an unauthenticated caller.
- Live before-state: `GET /health` → `consecutiveJobFailures: 119`, `status: degraded`; `GET /jobs` → `w29-working-set-mirror` `{enabled: false, consecutiveFailures: 118, lastRun: "2026-09-26T07:01:15.227Z"}`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `novel` is NOT claimed. The nearest registered class is the measurement family this belongs to: a surface that reports a number which cannot decrease, so it reads as a live signal while describing frozen history. Declared as `closure: gap` rather than `guard`, honestly: this change fixes the **instance** on `/health` and adds no guard that would refuse the next surface to sum unbounded durable counters.
- **`closure`** — `gap`.
- **`guardEvidence`** — not applicable (no guard claimed).
- **`gap`** — the class-level guard worth building is a lint over health/report surfaces that sum a durable, non-self-clearing counter without a currency bound; tracked as an evolution action rather than asserted here, because claiming `guard` with the two tests above would be claiming instance coverage as class coverage, which is the exact overstatement the class-closure gate exists to catch.
