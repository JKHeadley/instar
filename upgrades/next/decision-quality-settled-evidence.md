# decision-quality settled-evidence flag

## What Changed

`GET /decision-quality` computed `outcomesKnown = right + wrong + unknown` and served
`insufficientEvidence: outcomesKnown < minSample`. An `unknown` grade is the *absence* of
a settled outcome, so a decision point whose grades were 100% unknown reported that it had
**sufficient** evidence. Measured live over 7 days: `messaging-tone-gate` at 2075
decisions / 2004 unknown / 0 right / 0 wrong served `insufficientEvidence: false`;
`completion-claim-verify` showed the same shape at 1929 / 1760.

The route now also serves `settledGrades` (right + wrong) and `unknownShare`, and
`insufficientEvidence` follows the settled count. `outcomesKnown` and `outcomesKnownRatio`
are unchanged and still served — they answer a different question. Both new fields are
added to the pool-merge field allowlist, so a `?scope=pool` row does not silently lose the
two fields that say whether its rates mean anything.

The type contract already described the intended behaviour ("below this **graded-decision**
count"), and the same object literal already divided by `right + wrong` for
`selfReportShare` — the correct denominator was present, one field simply did not use it.

This is instance 7 of ACT-1243 (critical): a completeness metric must carry its denominator
and refuse a verdict when that denominator is unverifiable, rather than report the ideal
value.

## Evidence

- **Mutation-proved:** restoring the original `outcomesKnown < minSample` expression makes
  the new test fail with exactly `expected false to be true` — the production symptom.
  Restored; 13/13 green.
- Both sides of the boundary are tested: 25 unknown grades (above the sample floor) must
  give `insufficientEvidence: true`; 25 settled grades must give `false`. The second test
  exists so the flag cannot be satisfied by being stuck true.
- The pre-existing assertion (`1 < 20 → true`) is unchanged and still passes.
- `tsc --noEmit` clean.

## What to Tell Your User

If you look at the panel showing how often your agent's internal checks get things right,
two of the busiest ones will now say there is **not enough evidence** to judge them, where
they previously said there was.

Nothing has got worse. That was already true and the display was wrong: those checks had
thousands of decisions recorded but none of them ever established as right or wrong, and
the summary was counting "we never found out" as though it were evidence. It now counts
only decisions that were actually settled, and separately shows you how much is still
unknown.

This panel only reports. It does not block anything, slow anything down, or change how
your agent behaves.

## Summary of New Capabilities

Two new read-only figures on the decision-quality view: the number of decisions actually
settled as right or wrong, and the share still unknown. The existing "enough evidence"
indicator now follows the settled figure, so a stream where nothing has been established
is reported as unproven rather than as proven.
