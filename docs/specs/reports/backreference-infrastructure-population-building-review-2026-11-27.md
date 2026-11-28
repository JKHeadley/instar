# Building area review — the back-reference check widened to decision infrastructure (PR 4024)

Date: 2026-11-27. The change edits one article in the Building family, *References Run From Both Ends — the Registry Names the Code, the Code Names the Standard* (`docs/STANDARDS-REGISTRY.md`, the one line holding its Applied-through field). This review records the family audit for the changed article content.

## What changed in the article

- The Applied-through field now says the lint also checks every shipped file named as decision infrastructure, plus `scripts/lint-*` and hook sources. It names the shrink-only infrastructure baseline and says an absent baseline counts as empty.
- The named unenforced sub-obligation is narrowed to what is still unchecked: files not named like guards, and the accuracy of the named standard.
- `STD-SUBCOUNTDOWN-backreference-completion` moves to 2027-02-26, owned by Pipeline Strategy. The text says the date is set by the operator's approval of this change.
- No other article and no other field changed.

## Review

- **Author:** echo (Pipeline Strategy), with a focused run on head bee6368e through the Studio wrapper at 16:35 PT. The guard test passed 16 of 16. `lint-standard-code-backreference` and `lint-documented-only-countdown` both exited 0.
- **Independent reader, read-only:** CONCUR on bee6368e. Record: `.instar/state/handoffs/reviews/pr-4024-backreference-guard-review.md`.
  - The reader confirmed that only line 947 changes and that the countdown lint parses the new countdown.
  - It confirmed the text is honest, with one wording overstatement ("shrink-only" was stronger than the code).
  - It named three non-design follow-ups:
    1. shrink-only enforced in one direction only;
    2. two missing test cases;
    3. a case-insensitive name match catching words such as "Delegated".
  - These are fixed in a separate follow-up commit (c0b18224), which will be reviewed on its own after this PR merges. None is a design question.

## Disposition

- No unresolved design question.
- The family's reference-resolution floor is kept as recorded; this change lowers no floor.
- The Building family's enforcement classification is unchanged: no article moved between classes.
