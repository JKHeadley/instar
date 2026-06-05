<!-- bump: patch -->

# Decision-audit lines ride their own commit

## What to Tell Your User

Nothing user-visible. An internal audit-trail leak is closed: the per-commit build-decision record (tier declared vs suggested) used to evaporate with reclaimed worktrees; it now travels inside the commit it describes.

## Summary of New Capabilities

- `scripts/instar-dev-precommit.js` stages `.instar/instar-dev-decisions.jsonl` right after appending the audit line, so the line lands in the same commit it audits.
- A gate-blocked commit leaves the line staged; it rides the retry commit (both evaluations were real).

## What Changed

One change in `writeDecisionAudit` (auto-stage after append) + a regression test (`tests/unit/instar-dev-precommit-audit-staging.test.ts`) pinning that the line is written AND staged even when the gate blocks. Root cause of the task-#62 "decision-audit didn't fire" mystery: it fired; the line sat uncommitted in the building worktree and was deleted with it.

## Evidence

Reproduced live twice on 2026-06-05 before the fix: two build worktrees (`keychain-per-agent`, then `dev-claim-check`) each held an orphaned, uncommitted `+{"ts":"2026-06-05T08:49:24Z","slug":"keychain-per-agent-master-key",...}` line in the tracked `.instar/instar-dev-decisions.jsonl` after their PR commit — `git status` showed ` M .instar/instar-dev-decisions.jsonl` post-commit, and removing the worktree would have deleted the only copy (one line was hand-rescued before reclaim). After the fix, observed on PR #814's own commit: `git status --short .instar/instar-dev-decisions.jsonl` is CLEAN immediately post-commit and the commit diff contains the gate's own audit line for that very commit — the dogfood proof quoted in the PR body.
