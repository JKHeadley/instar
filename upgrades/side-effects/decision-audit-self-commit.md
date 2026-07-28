# Side-Effects Review — decision-audit self-commit

**Version / slug:** `decision-audit-self-commit`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane (one-line hook change, audit-integrity fix)`

## Summary of the change

`writeDecisionAudit` in `scripts/instar-dev-precommit.js` now stages `.instar/instar-dev-decisions.jsonl` immediately after appending the audit line, so the line rides the very commit it describes. Closes the task-#62 audit leak: pre-commit-hook appends land after staging, leaving the line uncommitted in the building worktree; one-PR worktrees never commit it and worktree reclaim deletes it (confirmed live twice on 2026-06-05).

## Decision-point inventory

- `writeDecisionAudit` — modified — `git add <decisions file>` inside the existing best-effort try block, after a successful append.

## 1. Over-block

None. The `git add` lives inside the existing best-effort catch — any failure (git unavailable, index lock) is swallowed exactly like an audit-write failure today; the gate never blocks on audit I/O.

## 2. Over-permit

None. Staging one known repo-tracked file adds no permissive path. The file was already tracked and union-style appended; lines now simply become part of commits.

## 3. Behavioral notes

- **Blocked commit:** the audit line is written + staged, then the gate may block. The staged line rides the author's retry commit — both evaluations were real; the record gains fidelity, not noise.
- **Out-of-scope commits** (docs/tests-only) still exit before the audit by design — unchanged.
- **Merge-conflict surface:** parallel PRs already both append to this tracked file; lines now actually LAND, so conflicts become possible where silent loss was before. The file is append-only JSONL — union-merge resolution is trivial and already practiced.

## 4. Migration parity

None needed — `scripts/` ships with the repo; agents get it on update like any source change. No config/hook-template/skill changes.

## 5. Token/cost impact

None. One `git add` of one file per gated commit.

## 6. Rollback

Revert the commit; audit lines return to being orphaned working-tree modifications (the prior, leaky behavior).
