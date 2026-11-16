# Side effects: Chief of Staff done items check every named PR

Tier 1. Small, reversible; a revert restores the old behaviour exactly.

## The change
`buildDoneItemEvaluator` (src/core/ChiefOfStaffEvidence.ts) read only the first "PR owner/repo#N merged" phrase in a done item. An item naming several PRs passed as soon as the first one merged. It now reads every phrase: any PR not merged into the default branch fails the item; otherwise any unreadable PR (or one in an unlinked repo) makes it unknown; only all-merged passes.

## Review
1. Over-block: an item that names a PR only as context ("PR x#1 merged earlier, now y") now needs that PR merged too. The phrase is the owner-confirmed finish-line syntax, so naming it means requiring it. No issue identified beyond that.
2. Under-block: still only "merged into the default branch"; does not prove the change is released or live. Unchanged from 3234.
3. Level of abstraction: same evaluator, same place; no new layer.
4. Signal vs authority: produces a pass/fail/unknown signal the Chief of Staff loop and owner confirm-done consume. A false "pass" was the old risk; the change only makes passes rarer. No blocking authority added.
5. Interactions: one gh call per named PR, sequential; at most a handful per item, on the loop's existing cadence. Unlinked repos are still never read.
6. External surfaces: GitHub API reads only (via the existing gh runtime).
7. Multi-machine: unchanged; the evaluator runs where the loop runs (lease holder).
8. Rollback: revert the commit.
