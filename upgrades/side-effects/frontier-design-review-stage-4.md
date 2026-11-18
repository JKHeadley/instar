# Side-Effects Review — Frontier design and review, stage 4: awareness and the /spec-converge migration

**Version / slug:** `frontier-design-review-stage-4`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required (agent instructions and a marker-keyed skill-wording migration; no gate, session or messaging decision is changed)`

## Summary of the change

Stage 4 of `docs/specs/frontier-design-review-standard.md` (approved 2026-11-17, topic 144319, message 144458), the parts that live in this repository. Tier 2 (rides the approved spec). The constitution article is its own pair of pull requests (2.0 rule book first, then the 1.x registry), each naming the other.

- **Awareness entry** `src/data/awareness/frontier-design-review.md`: start design work as its own session (`workKind: design`); before asking approval of any plan, design or spec run `/design-review` (or `/spec-converge` for Instar specs); the one driver command; how to read the line; that B26 and Work Board cards hold a request without it; the reference is a lookup key and the agent tells its operator so the first time. No model id in the text. Reaches every agent on update through the awareness registry (no migration).
- **`/spec-converge` SKILL.md** gains step 3, "Record the round": one `--all --record` driver run per round, its findings folded in, the line taken from `GET /design/review` before an approval request. The clean-door paragraph no longer names a model id ("the design model").
- **Migration** `migrateSpecConvergeRecordingDriverRun` in `PostUpdateMigrator`: marker-keyed one-shot (`frontier-design-review:recording-driver-run`), skips a customised copy (no `# /spec-converge` heading), idempotent; the same shape as the earlier spec-converge wording migrations.
- **Driver output** (`--all`) now carries each answering reviewer's findings (`findings`), which `/design-review` and `/spec-converge` fold into the round. Findings are never recorded.

## Decision-point inventory

No decision point is added or changed. The migration's three outcomes (already updated, customised, replaced) are existence checks.

## 1. Over-block

Nothing is blocked. A customised `/spec-converge` SKILL is left untouched and reported as skipped.

## 2. Under-block

A customised `/spec-converge` copy does not get the recording step; on that agent an Instar spec's approval request is still held by B26 until a recording run exists, so the gap is caught at the approval point, and the awareness entry gives the driver command.

## 3. Level-of-abstraction fit

Awareness in the one registry file; skill wording through the established marker-keyed migration; the driver change is in the same thin wrapper.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. No authority added; instructions and output fields only.

## 4b. Judgment-point check

None added.

## 5. Interactions

- The earlier `migrateSpecConvergeAnthropicReviewerDisclosure` replaces a stock copy lacking its marker with the bundled copy, which now carries this marker too; both migrations are idempotent and order-independent.
- `/design-review` already reads the driver output; it now finds `findings` there.

## 6. External surfaces

Every agent's instructions gain one "Feature notes" paragraph; existing agents' stock `/spec-converge` SKILL gains step 3 on update.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified: instruction text and skill content ship in the release and reach every machine on its update.

## 8. Rollback cost

Delete the awareness file (the next update removes the paragraph); a reverse migration restores the previous SKILL wording if ever needed (the marker identifies migrated copies).

## Conclusion

The repository half of stage 4. Proof of the update path (an agent on the previous release updates and gets the skill, the awareness text, the driver and the migrated wording; a second update changes nothing) is in the PR, with the constitution pair.

## Second-pass review (if required)

**Reviewer:** not required (no gate, session or messaging decision changed; see header)

## Evidence pointers

- Unit: `tests/unit/PostUpdateMigrator-recordingDriverRun.test.ts` (stock copy updated once, second run no change, customised copy untouched, not installed), `tests/unit/awareness-entry-registry.test.ts` (entry valid), `tests/unit/designReviewRun.test.ts` (findings returned).
