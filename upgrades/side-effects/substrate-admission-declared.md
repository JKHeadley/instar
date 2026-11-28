# Side-Effects Review — Substrate membership sweep recorded; admission declared for new members

**Version / slug:** `substrate-admission-declared`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy, owner of the 21 Dec countdown cliff by the Chief of Staff's assignment)`
**Second-pass reviewer:** `independent read-only reviewer subagent — CONCUR on re-review`

## Summary of the change

- `docs/audits/substrate-membership-sweep-2026-11-27.md`: the recorded sweep. It covers all 27 headings, three tests each, with quoted evidence, from an independent reader, spot-checked (Close the Loop moved to borderline). Result: 9 members, 13 misfiled, 5 borderline. It proposes; it moves nothing.
- New `scripts/lint-substrate-admission-declared.mjs`, in the blocking lint chain: every `### ` article in the Substrate section not in the baseline must carry an `**Admission.**` line that names test 1, test 2 and test 3. A baselined article that gains the line must leave the baseline. A baseline entry no longer in the section fails. A missing, corrupt or malformed baseline fails.
- `docs/substrate-admission-baseline.json`: the 27 swept titles, shrink-only.
- `docs/STANDARDS-REGISTRY.md` is NOT changed here. The registry text (the countdown marked met, naming this check and the sweep, and the 26→27 count correction) ships in the single registry PR for the 21 Dec cliff, by the Chief of Staff's ruling of 2026-11-27 17:50. This PR's lint passes on main's registry as it stands.
- Tests: `tests/unit/lint-substrate-admission-declared.test.ts`, 7 cases.

## Decision-point inventory

One commit-time check. No runtime change.

## 1. Over-block

A legitimate new substrate property must carry a three-test Admission line. That is the point. An existing article is never blocked: the 27 are baselined.

## 2. Under-block

The truth of the stated reasons (a semantic reading, left to family review). An article filed in another family that belongs here is not checked; that is the reverse direction, and not this obligation. And if the Substrate heading text is renamed, the lint fails loudly, because it finds no section.

## 3. Level-of-abstraction fit

It sits with the other registry-structure lints (`lint-single-governing-obligation.mjs`, `lint-registry-tree-parentage.mjs`). It declares and does not infer, as *Intelligence Infers, Keywords Only Guard* requires.

## 4. Signal vs authority compliance

It blocks on a declared structural fact, whether the line is present and names the three tests. It does not judge.

## 4b. Judgment-point check

None.

## 5. Interactions

`scripts/generate-standards-hierarchy.mjs --check` and the registry lints are unaffected: no heading or tree line changes. Moves remain the operator's, and a move removes the article from the section, which makes its baseline entry stale, so the move PR also removes the entry.

## 6. External surfaces

None at runtime.

## 7. Multi-machine posture

Machine-local by design: a repository lint.

## 8. Rollback cost

Revert the PR: the lint, its chain entry, its baseline, its tests and the sweep document. No registry text is involved here.

## Conclusion

Closes both halves of the obligation honestly: the pass over the members, and a check on future members, without claiming the check judges truth.

## Second-pass review

**Reviewer:** independent read-only reviewer subagent, launched by the Pipeline Strategy session with no part in writing the change.
**Verdict:** DISSENT, then CONCUR on re-review (2026-11-27 18:56).
- The DISSENT named two blocking errors: the sweep totals were wrong (the correct figure is 9/13/5), and the notes described a registry edit that is not in this PR. Both are fixed.
- Its advisory points are also fixed: level-1 headings end the section, indented and tab-separated headings count, fenced blocks are ignored, and "test 10" no longer counts as test 1. 10 of 10 tests pass.
- Remaining and stated: a fence opened with ``` and closed with ~~~ counts as closed, and an unclosed fence hides what follows, as it does when rendered.
Review record: `.instar/state/handoffs/reviews/substrate-admission-review.md` (agent-local).

## Release note fix (2026-11-27, about 20:35 PT)

CI assembles the release notes from main plus this branch. Main's upgrades/next/ was empty after a release, so this fragment was checked alone, and it failed the repository invariant "missing ## Summary of New Capabilities section" (seen on #4038). Fix: internal-only marker added: the change is a lint, a baseline and an audit document, and stages nothing under src/, so the assembler fills the two user-facing sections. Checked alone with the repository's own assembleNextMd and validateGuideContent: the old version fails and the new one passes.
