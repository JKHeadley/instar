# Side-effects review: ladder entry for projections.calibration

## What changes
One line is added to `src/data/feature-ladders.json`: a `ladder` entry with id `projections.calibration`, flag `projections.enabled`, final `default-on`, risk `standard` and tracking `needed`. It has one fleet rung with a 14-day soak, advance by code, and two jsonl-log metrics read from `logs/feature-evidence.jsonl`: at least 20 fired rows, and an error ratio of 0.

## Why
`docs/specs/projection-calibration.md` names `- **ladder:** projections.calibration`. The ladder coverage test (`tests/unit/feature-ladders-coverage.test.ts`, "every spec that names a ladder names a real entry") failed because no such entry existed. The numbers come from the spec's own maturation plan.

## Side effects considered
- **Runtime:** none today. The feature isn't built yet, so nothing reads this flag and the maturation board shows the entry as tracking-needed with no evidence. No route, config default, migration or hook changes.
- **The maturation board:** it gains one row in the needed state. Its reader treats a missing evidence log as no samples, never as a pass.
- **Accuracy:** the plan text says plainly that this is a spec-only entry and that the build must write the evidence rows. A later build that measures differently should edit this entry, not add a second one.
- **Rollback:** delete the line.

## Tier
Tier 1: one data line, no code, no capability and no migration.

## Tests
feature-ladders-coverage, MaturationLadder and feature-delivery-completeness pass.
