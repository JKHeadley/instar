# Side-Effects Review — `instar worktree create` works from a checkout of the canonical repo

**Version / slug:** `worktree-create-canonical-repo`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (developer tooling; no gate, sentinel, lifecycle or messaging decision)`

## Summary of the change

Tier 1, 3 files. `instar worktree create` failed twice in a row from a real checkout of the instar repo (Mama PC, `.dev/instar`, origin `https://github.com/JKHeadley/instar.git`):

1. **Allowlist.** `DEFAULT_INSTAR_REPO_URL_ALLOWLIST` listed only `instar-ai/instar` (which returns 404 from GitHub today), so a checkout of `JKHeadley/instar` — where instar is developed and released — was refused with "remote.origin.url … not in worktree.repoUrlAllowlist" unless the operator had configured an addition. The default now also lists the `JKHeadley/instar` SSH and HTTPS URLs; the `instar-ai` entries stay for existing checkouts.
2. **Hook activation order.** `createWorktree` ran `ensureHuskyHooksActive` (which runs `npm run prepare`, i.e. `husky`, a node_modules binary) before `maybeSymlinkNodeModules`, so in a fresh worktree `husky` was not found and every real create failed closed ("husky: prepare failed … husky: not found"). The order is swapped: share node_modules, then activate hooks. The fail-closed behaviour is unchanged — a worktree still is not returned without an active, executable pre-commit shim.

Why tests never caught (2): the integration fixture's prepare script was `node scripts/fake-husky.mjs`, a committed file that needs no node_modules, and the test runner's own PATH carries a real `husky`. The new integration test uses `prepare: "husky"` with `husky` present only in the source repo's `node_modules/.bin`, and strips `node_modules/.bin` from PATH for its duration: it fails on the old order with the exact production error and passes on the new one.

Evidence: unit 52/52 (new test fails without the allowlist change: 1 failed / 51 passed); integration 8/8 (new test fails without the reorder); real run from `.dev/instar` creates a worktree whose `.husky/_/pre-commit` is executable and `core.hooksPath` is `.husky/_` (probe worktree removed afterwards).

Effort: 1 pass; 1 commit attempt.

## Decision-point inventory

`worktree repo allowlist` — modify — widens the default to the real canonical repo. No other decision point.

## 1. Over-block
Removes a false refusal (the real canonical repo). Nothing newly refused.

## 2. Under-block
Could a non-instar repo now be accepted? Only a checkout whose remote is exactly `JKHeadley/instar` (SSH or HTTPS), which is the instar repo. The other checks (source signature, hooksPath inside the repo) are unchanged.

## 3. Level-of-abstraction fit
Both fixes are in `InstarWorktreeManager`, where the allowlist and the create sequence live. Operators can still extend the allowlist in config.

## 4. Signal vs authority compliance
The allowlist is a guard on which repo the command operates on; it stays exact-match. No brittle logic added (`docs/signal-vs-authority.md` reviewed).

## 5. Interactions
`--no-share-node-modules` keeps today's behaviour (prepare runs without shared node_modules and fails closed unless the worktree has its own). The shared node_modules warning already printed by the CLI is unchanged.

## 6. External surfaces
Developer CLI only.

## 7. Multi-machine posture
Machine-local by design: a local developer command.

## 8. Rollback cost
Revert.
