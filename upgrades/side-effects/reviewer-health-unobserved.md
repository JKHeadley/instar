# Side-Effects Review — a reviewer that never ran reported a PERFECT pass rate

**Version / slug:** `reviewer-health-unobserved`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 note (reduced independence, disclosed)`

## Summary of the change

`CoherenceGate.getReviewerHealth()` computed `passRate = total > 0 ? passCount/total : 1`
and defaulted `status` to `'healthy'`. With zero observations a reviewer that had **never
executed once** therefore reported a perfect pass rate and a healthy status, and
`overallStatus` aggregated it as healthy. The absence of information rendered identically
to the presence of good information.

`getReviewerStats()` carried the same defect pointing both directions at once: `passRate: 0`
(pessimistic) for the SAME quantity ~110 lines away, and `jsonValidityRate: 1` — claiming
perfect JSON validity from a reviewer that had never parsed a response. Two opposite
defaults for one quantity in one file is the tell that neither was reasoned about.

After: rates are `null` at zero observations, the denominator is always present, `status`
gains `'unobserved'`, and a minimum-observation floor (5) gates **only** the optimistic
conclusion.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `status` per reviewer | `invariant` | Deterministic thresholds on measured rates. No competing signals; the only change is that the optimistic branch now requires evidence. |
| `overallStatus` aggregation | `invariant` | Fixed precedence `failing > degraded > unobserved > healthy`. |
| `REVIEWER_HEALTH_MIN_OBSERVATIONS` | `invariant` | A constant floor, not a judgment. Adopts the `total >= 100` precedent in `SelfActionGovernor.checkObserveLimbo`; smaller (5) because this surface reports continuously rather than gating a one-way promotion. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is blocked — this is a read surface with no gating authority (verified: the only
consumer of `getReviewerHealth` is `routes.ts` serving `GET /review/health`).

The nearest analogue to over-blocking is **withholding a healthy verdict from a reviewer
that deserves one**. Bounded: 1–4 observations report `status: 'unobserved'` with the real
rate still visible, so a reader loses the label and keeps the data. At 5+ observations the
verdict returns. Demonstrated: 20 passes → `'healthy'`, unchanged from before.

## 2. Under-block

**What failure modes does this still miss?**

- The floor is a count, not a confidence interval. 5 passes out of 5 reports `'healthy'`
  though a real interval would still be wide. Deliberate: this is a health display, and
  the previous state was infinitely worse (0 observations → healthy).
- `jsonParseErrors > total * 0.3` remains reachable at low `total`. Left as-is: it errs
  toward *degraded*, which is the safe direction, and widening this change to re-derive
  every threshold would exceed the finding.
- Sibling sites in the same audit class are NOT fixed here and are recorded rather than
  silently dropped: `dashboardInsightCollectors.ts:57` (`overallErrorRate → 0`, rendered
  `Error rate: 0%`) is a real display-class instance; `OrgIntentDriftAnalyzer`,
  `IntentDriftDetector`, `FeatureRegistry`, `ScenarioPack`, `GrowthMilestoneAnalyst` and
  `escalation-resolution` are unexamined. The class is NOT closed.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The defect is in how these two methods report their own metrics, so the fix belongs in
them. A shared "rate with provenance" helper was considered and rejected as premature: the
sibling instances have not been read yet, and inventing an abstraction over one confirmed
and one probable instance would be the "six mechanisms from one bad early choice" mistake
the registry spec's own review caught.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

No. Pure reporting, zero authority: no branch of either method blocks, delays, or alters
any message, and neither is consulted by any decision path. The change makes the surface
*less* likely to mislead a human reading it. There is no new failure mode where a
misclassification denies anything, because nothing is denied.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. Every branch is a deterministic comparison on counted
observations, and the new floor is a constant. The one asymmetry is deliberate and stated
in code: the floor gates the optimistic conclusion only, so thin evidence can never
suppress a genuine failure (errored on both of 2 calls → still `'failing'`).

## 5. Interactions

- `getHealthDashboard()` consumes `stats.summary`, **not** `stats.reviewers`, so the
  nullable rates do not reach it. Verified by reading the method.
- `getHealthDashboard()` already computed `reviewerCoverage` — "has this reviewer run?" —
  as a separate boolean. The information needed to avoid this defect was already being
  computed in the same class; the health surfaces just did not use it.
- `routes.ts:31285` and `:31367` JSON-serialise the results. `null` serialises cleanly.
  No consumer performs arithmetic or `toFixed` on these fields (checked).
- No persistence, no migration, no config: these values are computed per call from
  in-memory counters.

## 6. External surfaces

`GET /review/health` and `GET /review/stats` response shapes change: rates may be `null`,
`status` may be `'unobserved'`, and three fields are added (`errorRate`,
`observationsRequired`, `insufficientEvidence`). On installs where the response-review
pipeline is disabled — including this one — both routes already return `501`, so the live
blast radius here is nil. Any consumer must already handle `501`, and a `null` rate is
strictly more honest than the `1` it replaces.

## 6b. Operator-surface quality

An operator asking "is my outbound review pipeline healthy?" previously received a
confident yes from a pipeline that had never run. They now receive `unobserved` with the
observation count beside it, which is answerable rather than misleading. `'unobserved'` is
deliberately not an alarm word: nothing is wrong, nothing is known yet.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no new state.** These are derived reads over
per-process in-memory counters that already existed. Each machine reports its own
reviewers' observations, which is correct: a reviewer's execution count is a property of
the process that ran it. No replication path is needed because nothing is stored, and no
`machine-local-justification` marker is required because no new machine-local state is
introduced.

## 8. Rollback cost

Trivial and self-contained: revert one commit touching one source file and one test file.
No migration, no persisted state, no config key, nothing to unwind. A consumer written
against the new shape sees the old shape again, and the old shape's failure mode is the
one documented above.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned.
A standing instruction in this session prohibits spawning subagents unless the operator
requests it, so the review lenses (over-block, under-block, abstraction fit, signal-vs-
authority, interactions, multi-machine) were applied by the author. That is **reduced
independence** and is recorded as such rather than presented as a concurring second pass.

What author-applied review actually caught and changed:

1. An initial draft treated `total === 0` and `0 < total < 5` as one state. Splitting them
   mattered: at `total > 0` the rate is real data worth showing, and only the *verdict*
   needs withholding. Hence `passRate` is `null` only at zero, never at "few".
2. The first design gated all three branches on the floor, which would have **suppressed a
   genuine failure** on thin evidence — recreating the same defect pointing the other way.
   Corrected so the floor gates optimism only.
3. The consumer check was run rather than assumed, which is what established that
   `getHealthDashboard` reads `stats.summary` and is unaffected. An earlier claim in this
   session that this surface "gates the enforcement flip" was **disproven** by the same
   check and withdrawn: `getReviewerHealth` has exactly one consumer, the route.
