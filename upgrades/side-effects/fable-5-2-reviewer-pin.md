# Side-effects review — Fable 5.2 as an explicit clean-door reviewer pin

**Tier:** 1 (one allow-list entry + one test; a revert fully undoes it). No spec; ELI16 at `docs/specs/fable-5-2-reviewer-pin.eli16.md`.
**Change size:** 2 files, ~17 LOC.
**Effort:** 1 build attempt.
**Trigger:** operator request 2026-11-09 14:12 PT (topic 141133): "please make sure fable 5.2 is involved in the spec design and review process." `resolveClaudeReviewerModel` refuses `claude-fable-5-2` as `override-not-frontier`; the id was live-verified against the claude CLI (2.1.321) the same hour.

## Summary
Adds `claude-fable-5-2` to `CLAUDE_REVIEWER_EXPLICIT_MODELS` in `src/core/crossModelReviewer.ts`, with a test asserting the explicit pin resolves and the default stays `claude-fable-5`. Nothing is repointed by this change; it makes the operator's pin possible.

## 1. Over-block
None added; this removes a refusal of a real, operator-requested id. No issue identified.

## 2. Under-block
The set is still an explicit allow-list; one verified id is added. A wrong id is still refused `override-not-frontier`. The entry is not added to the frontier set, so it does not become a default or a fallback.

## 3. Level-of-abstraction fit
Exactly where the Opus 5.5 operator exception lives. No parallel list is added.

## 4. Signal vs authority compliance
Structural validation of an enumerable domain; no judgment logic. Compliant.

## 5. Interactions
`resolveClaudeReviewerModel` is the single resolution point; the invocation path (`reviewerHardening.model`) receives whatever it returns. The freshness lint pins only `CLAUDE_REVIEWER_DEFAULT_MODEL`, which is unchanged, so no lint row moves. PR #3002 adds the same id to `KNOWN_CLAUDE_MODEL_IDS`; the two lists are independent (topic pins vs reviewer pins) and this change does not depend on that one.

## 6. External surfaces
None visible until an operator sets `specConverge.reviewers.anthropic.model` to the id. The convergence report then names `claude-fable-5-2` as the reviewer model, which is the intended disclosure.

## 6b. Operator-surface quality
Not applicable: no UI change.

## 7. Multi-machine posture
Code-level allow-list: identical on every machine running this build. An older machine refuses the pin until it updates (the existing version-skew behaviour).

## 8. Rollback cost
Delete the entry and the test case. A reviewer config naming the id would then degrade loudly (`override-not-frontier`), which is the designed behaviour for an unknown pin.

## Found problems (triage)
- None.

## Proportion
Tier 1, 2 files, 1 attempt. In line.
