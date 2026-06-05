<!-- bump: patch -->

# Decision-audit lines ride their own commit

## What to Tell Your User

Nothing user-visible. An internal audit-trail leak is closed: the per-commit build-decision record (tier declared vs suggested) used to evaporate with reclaimed worktrees; it now travels inside the commit it describes.

## Summary of New Capabilities

- `scripts/instar-dev-precommit.js` stages `.instar/instar-dev-decisions.jsonl` right after appending the audit line, so the line lands in the same commit it audits.
- A gate-blocked commit leaves the line staged; it rides the retry commit (both evaluations were real).

## What Changed

One change in `writeDecisionAudit` (auto-stage after append) + a regression test (`tests/unit/instar-dev-precommit-audit-staging.test.ts`) pinning that the line is written AND staged even when the gate blocks. Root cause of the task-#62 "decision-audit didn't fire" mystery: it fired; the line sat uncommitted in the building worktree and was deleted with it.
