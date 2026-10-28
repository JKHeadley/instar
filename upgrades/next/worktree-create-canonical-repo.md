<!-- internal-only -->
# `instar worktree create` works from a checkout of JKHeadley/instar

## What Changed

- The default worktree repo allowlist includes `JKHeadley/instar` (SSH and HTTPS); `instar-ai/instar` stays.
- `createWorktree` shares node_modules before activating Husky hooks, so `npm run prepare` (`husky`) is found in a fresh worktree. Still fails closed without an active pre-commit shim.

## Evidence

Unit 52/52 and integration 8/8; both new tests fail without their fix (the integration one with the production error "husky: not found"). A real create from a JKHeadley/instar checkout produced an active `.husky/_/pre-commit`.
