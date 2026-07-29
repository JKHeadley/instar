# Side-effects review — decision-quality settled-evidence flag

**Change.** `GET /decision-quality` computed `outcomesKnown = right + wrong + unknown` and
served `insufficientEvidence: outcomesKnown < minSample`. An `unknown` grade is precisely
the *absence* of a settled outcome, so a decision point with 100% unknown grades reported
that it had **sufficient** evidence. Now: `settledGrades = right + wrong` is published,
`unknownShare` is published, and `insufficientEvidence` follows the settled count.
`outcomesKnown` and `outcomesKnownRatio` are unchanged and still served.

**Measured before the fix** (live, 7-day window):

| decision point | decisions | outcomesKnown | right | wrong | unknown | insufficientEvidence |
|---|---|---|---|---|---|---|
| messaging-tone-gate | 2075 | 2004 | 0 | 0 | 2004 | **false** |
| completion-claim-verify | 1929 | 1760 | 0 | 0 | 1760 | **false** |

Instance 7 of **ACT-1243** (critical, 2026-07-25): *a health/completeness metric must
carry its denominator and refuse a ratio when it is zero or unverifiable.*

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

`insufficientEvidence` flips `false → true` for any point whose settled grades are below
the floor but whose row count was above it. That is the intended correction, not
over-blocking: those rows never supported a rate. Nothing is rejected, blocked, or
withheld — this route gates nothing. The only effect is that a flag now says "don't trust
these rates" where it previously said "do."

Reader impact is real and worth stating plainly: any dashboard or reader currently seeing
`insufficientEvidence: false` on the two high-volume points will now see `true`. That is
the surface telling the truth for the first time, but it will look like a regression to
anyone who assumed the old value meant something.

## 2. Under-block — what failure modes does this still miss?

- **`minSample` is a count, not a power calculation.** 20 settled grades is a floor, not
  evidence that a rate is statistically meaningful. Unchanged by this fix.
- **A settled grade can still be low-quality.** `selfReportShare` and `byStrength` exist
  precisely because a `wrong` may be the interested party's own account (ACT-934). This
  fix does not segment settled grades by strength — it only stops counting non-grades.
- **`expired` is not counted anywhere in the flag.** An expired outcome is neither settled
  nor unknown; a point that expires everything reads as zero settled → `true`, which is
  correct, but the reason is not distinguishable from "never graded."
- **The rates themselves are still served** when `insufficientEvidence` is true. A
  consumer that ignores the flag reads `right: 0, wrong: 0` as before. The flag is a
  signal, not an authority — deliberately, per Signal vs Authority.

## 3. Level-of-abstraction fit

Correct layer, and it moves the computation toward a quantity the same object already
uses: `selfReportShare` on the very next lines divides by `right + wrong`. The settled
count was already the right denominator here — one field simply did not use it.

## 4. Signal vs authority compliance

Compliant. `/decision-quality` is explicitly observe-only and gates nothing; this change
adds no blocking authority and removes none. It repairs an **honesty** property of a
signal: the flag's whole job is to tell a consumer when not to trust the numbers beside
it, and it was answering the opposite of the truth in the two highest-volume cases.

The failure mode this closes is a Signal-vs-Authority failure one level up: a *human or
agent audit* reading `insufficientEvidence: false` alongside `right: 0, wrong: 0` would
reasonably conclude "this gate has never been wrong" and argue to **remove its blocking
authority**. A brittle input was positioned to drive a real authority decision.

## 5. Interactions

- **Pool merge:** `DECISION_QUALITY_POINT_FIELDS` is an explicit allowlist that strips
  unknown fields from peer rows. `settledGrades` and `unknownShare` are added to it —
  otherwise a `?scope=pool` row would silently lose exactly the two fields that say
  whether its rates mean anything, leaving the merged view **more** misleading than the
  local one. The allowlist's security property (a hostile peer cannot smuggle extra
  fields) is unchanged; two known-good names were added.
- **Benchmark-divergence detector:** already bounds unsettled streams independently via
  `maxUnknownShare` and reads `gradedN` / `unknownShare` from its own computation. It does
  not consume `insufficientEvidence`, so its verdicts do not change.
- **CoherenceGate** has its own unrelated `insufficientEvidence` local
  (`REVIEWER_HEALTH_MIN_OBSERVATIONS`); untouched, different symbol, no shared code.
- **No double-fire, no race:** pure arithmetic inside an existing read path.

## 6. External surfaces

`GET /decision-quality` is dev-gated (503 on the fleet). Two additive fields plus one
boolean whose *meaning* is corrected. No route, config key, message, job, or persisted
state changes; nothing is written. The response schema only grows.

## 7. Multi-machine posture

**Proxied-on-read**, and handled: `?scope=pool` merges machine-tagged rows through
`pickDecisionQualityPointFields`, which is updated so the new fields survive the merge.
Per-machine rows stay individually visible (per-machine framework routing makes per-machine
quality genuinely distinct data). No durable state, so nothing strands on a topic transfer.

## 8. Rollback cost

Revert the commit. Pure computation on a read route — no migration, no persisted state, no
config, nothing to repair. The ledger rows are untouched; the change is entirely in how
they are summarised on read.

## Verification

- **Mutation-proved:** restored the original `outcomesKnown < minSample` expression and the
  new test failed with exactly `expected false to be true` — the production symptom. Fix
  restored, 13/13 green.
- Both sides of the boundary are covered: 25 unknown grades (above the sample floor) must
  yield `insufficientEvidence: true`, and 25 settled grades must yield `false`. The second
  test exists so the flag cannot be trivially satisfied by being stuck true.
- The existing assertion (`1 < 20 → true`) is unchanged and still passes.
- `tsc --noEmit` clean.
