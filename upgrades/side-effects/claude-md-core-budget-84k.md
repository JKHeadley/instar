# Side-Effects Review — CLAUDE.md core size budget 80,000 -> 84,000

## Summary of the change

`CLAUDE_MD_CORE_BUDGET_CHARS` in `src/scaffold/claudeMdLayout.ts` goes from 80,000 to 84,000, with the measurement and reason in its comment. `docs/specs/claude-md-reference-layout.md` and its plain-English overview carry the new number. No other code changes. The constant is read only by three tests (unit, integration, e2e); nothing at runtime reads it.

## Decision-point inventory

One: the size test that fails a change when the generated core passes the budget. It is a development gate on changes, not a runtime decision.

## 1. Over-block

Before: a change adding a legitimate row to a core heading fails once the queue ahead of it has used the last 734 characters. After: the same change passes until the core reaches 84,000. No new over-block.

## 2. Under-block

The test now lets the core grow by up to 4,734 more characters before anyone has to decide. A change that puts a long paragraph under a core heading by mistake is caught later than before. Mitigation is the comment's stated direction (short rows) and the follow-up below.

## 3. Level-of-abstraction fit

The budget is the right place for a ceiling; it is the wrong tool for keeping individual rows short. A per-row length check would act where the growth happens. That check is not in this change. <!-- tracked: CMT-1767 -->

## 4. Signal vs authority compliance

The test is a hard gate with simple logic (a length comparison). It stays one; the change only moves its threshold. No brittle detector gains authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added or removed. The number is a floor argued from measurement (stated in the code comment and the spec).

## 5. Interactions

`tests/unit/claude-md-reference-layout.test.ts` also asserts the budget is below 150,000: 84,000 satisfies it. The integration and e2e tests compare generated files with the same constant. No other reader (`grep CLAUDE_MD_CORE_BUDGET_CHARS` over src, tests, scripts, docs).

## 6. External surfaces

Installed agents: no file changes on update from this change alone; their `CLAUDE.md` is whatever the template generates. The effect is indirect: later changes may now grow every agent's always-loaded file up to 84,000 characters (about 1,000 tokens more per session at the ceiling; with an agent's own kept sections of 19-26k the file tops out near 110k, under the 150k warning).

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: a build-time test constant. Nothing replicated, no notices, no URLs.

## 8. Rollback cost

Revert the commit. If the core has grown past 80,000 by then, the revert fails the size test until rows are shortened, which is the intended pressure.

## Conclusion

Low risk, reversible, measured. It trades up to one twentieth more always-loaded text for not failing a dozen queued changes on size alone.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the three new files, not the author's conclusions; read-only (no test run)

First read (the draft raised the budget to 88,000): "Concern raised": the amended spec still stated the old budget in two rollout checks and a now-false "~70k" margin, and the claim "each sat 600-720 characters under the old budget" was unclear because main itself had only 734 left. It confirmed by grep that only three tests read the constant, that no other file hardcodes the old number for this budget, that no content hash guards the spec, and that the 150,000 assertion and the arithmetic hold. It could not verify the 79,266 measurement or the count of open changes by reading.

Changes made in response: the two rollout checks now say "the budget"; the margin reads 66k; the unclear claim is replaced by the measurements (734 left; each open change alone measured 79,280 to 79,375, numbers reported by the session that rebuilt them); and because that restatement shows the queue needs far less than 8,000 characters, the raise was cut from 88,000 to 84,000. Second read (the revised, staged change): no stale statement remains, every number is consistent with 84,000, and this section describes the first read fairly, with one nuance it asked to keep: it found no content hash on the spec and did not trace the env-gated convergence-report check in the pre-commit script. "Concur with the review".

## Evidence pointers

Measurement run 2026-11-14 on main 0001c8c10: core 79,266; coreBody 68,610; dispatch section 10,248. Open changes touching `src/scaffold/templates.ts`: 12 of 83 non-draft.
