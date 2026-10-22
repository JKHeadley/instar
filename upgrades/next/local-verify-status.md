## What Changed

- **local-verify posts (or, by default, logs) the `instar/local-verify` commit status** (spec `docs/specs/local-verify-merge-authority.md` §3, piece 3a). A 60-second loop on the lease holder projects each open PR's status from its local-verify record (or mirrors the Actions checks for PRs that stay on the Actions floor), posts only on a change, through one serialized writer per head, and withdraws `success` when a condition stops holding. A post-merge `main` verify (debounced, capped) with `main-suspect`/`main-red` states stops merges except a repair while `main` is red. The local floor takes effect only when GitHub's own settings require the check and classic protection requires nothing. New `GET /local-verify/status`. Posting is off unless `monitoring.localVerify.postStatuses` is true.

## What to Tell Your User

Nothing changes for you yet. This is the part that will post a pass/fail mark on each pull request from my own test runs; for now it only notes what it would post, and stays that way until you approve the switch.

## Summary of New Capabilities

- `GET /local-verify/status` (floor in force, main health, last pass; instar source checkouts only).
- `monitoring.localVerify.postStatuses` (default false).

## Evidence

- `tests/unit/localVerify/{statusProjection,StatusReconciler,mainHealth,floorGate}.test.ts`
- `tests/integration/local-verify-routes.test.ts`, `tests/e2e/local-verify-lifecycle.test.ts`
