<!-- bump: patch -->
## What Changed

Fix PRs opened by the feedback executor now carry the two records the CI floor requires of every instar PR. Before committing, trusted executor code (`src/feedback-factory/execute/prRecords.ts`, called from the publish step) adds:

- a decision record `.instar/instar-dev-decisions/<ts>-feedback-<initiative>-a<n>.json` when the change touches a decision-audit in-scope path. Its `scope.files` lists those paths (deleted ones included). It says `source: "feedback-executor"` and `localPrecommitGate: "not-run"`, and lists the checks the executor itself ran (base check, head check, lint, related tests with their real outcome, secret gate).
- a release-note fragment `upgrades/next/feedback-<initiative>-a<n>.md` with the four required sections, when the change touches a release-relevant path.

The triage summary and the session's test name enter these files only as one plain, length-bounded line with markdown and HTML syntax removed. Spec-draft PRs are unchanged (their review head must stay one file). Before this, every executor fix PR failed `decision-audit` and `release-fragment` and could never merge (#3159, #3168).

## What to Tell Your User

Fixes I open automatically for problems people report can now actually merge. They were being stopped by two paperwork checks that every change needs, even after both reviewers approved them. I now write that paperwork myself, and it says plainly that it came from the automatic fixer rather than a person's usual checks.

## Summary of New Capabilities

- Feedback-executor fix PRs include a decision record and a release-note fragment written by trusted executor code.

## Evidence

Reproduction: worker PRs #3159 and #3168 on JKHeadley/instar passed the executor's independent review and then sat at merge-deferred because the Actions floor failed `decision-audit` ("This PR changes 1 in-scope file(s) but carries NO decision-audit record") and `release-fragment`. After the fix, `tests/unit/feedback-factory/execute-pr-records.test.ts` runs the real `scripts/decision-audit-presence-check.mjs`, `scripts/check-release-fragment.mjs`, `scripts/upgrade-guide-validator.mjs` and `scripts/assemble-next-md.mjs` over the executor's output: the same file list fails both checks without the records and passes with them, and the fragment passes the publish validator. `tests/unit/feedback-factory/execute-service.test.ts` checks a full executor run pushes both records for a fix and none for a spec draft.
