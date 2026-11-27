# Side-effects: decision-audit coverage for three release-branch files

## Summary

The decision-audit check on PR #3013 found three in-scope files with no decision record, because their changes arrived without passing through the local pre-commit gate:

- `src/commands/machine.ts`: the `instar join <url> --dir <new path>` fix (create the state folder before writing the machine-local config). It was committed in a worktree made with plain `git worktree add`, which runs no commit hooks. Its test is `tests/unit/join-missing-dir.test.ts` (red before the fix, green after).
- `src/core/GraphMembershipTypes.ts`: type-only graph membership shapes, first added on the feature branch in a merge commit (9a1068eb6), so no gate run recorded it.
- `scripts/notification-selectivity-raw-baseline.json`: one baseline entry kept from each side when main was merged in (`handleCommand` from the branch, `sendOfferList` from main).

This change puts all three through the pre-commit gate in one commit, each with a small real change: the baseline is regenerated with the lint's own `--write-baseline` (the merge had left three entries out of the tool's order; same entries and counts), the join fix's comment now names its test, and the types file's header names its spec. No behaviour changes.

## 1. Over-block
No issue identified.

## 2. Under-block
No issue identified. No behaviour changes.

## 3. Level-of-abstraction fit
Audit-trail repair only.

## 4. Signal vs authority compliance
No authority changes.

## 5. Interactions
None.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert the commit; it only reorders the baseline and adds two comment lines.

## Class-Closure Declaration
Defect class: n/a. Closure: n/a. The gap's cause (a worktree without hooks) is already detected by the decision-audit check itself, which is how this was found.

## Evidence
- decision-audit run 42879990937 on 76d09056b listed exactly these three files as uncovered.
- The regenerated baseline has the same entries and counts; only their order changed.

## Second-pass review
Not required: no behaviour change; this only records gate runs for changes that were already reviewed in their own notes (the join fix in the release note and harness review; the merge resolution in conversation-graph-release-merge-1109.md).
