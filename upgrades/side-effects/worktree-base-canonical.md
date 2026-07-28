# Side-Effects Review — canonical-remote worktree base + loud non-code-base failure (task #82)

**Version / slug:** `worktree-base-canonical`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; the can-this-break-existing-layouts analysis below walks every remote configuration`

## Summary of the change

Found by the #829 live re-verify: the FIRST CLI worktree create on a real agent home branched from `origin/HEAD` = the personal fork's backup-sync main (agent-home FILES, no package.json) — and `ensureHuskyHooksActive` silently early-returned, leaving a plausible-looking worktree with ZERO commit-time checks. Fixes: (1) `validateInstarRepoCandidate` now reports `remoteName` + `remoteFetchesCanonical` (fetch-url match = refs mirror canonical; pushurl-only = trust without ref provenance), preferring fetch-url matches; `resolveBaseBranch` prefers `<thatRemote>/HEAD|main` only when fetch-canonical. (2) `ensureHuskyHooksActive` throws an actionable error (cause + `--base`/`worktree.defaultBaseBranch` remedies + cleanup command) instead of silently returning when package.json or the tracked hook is missing.

## Decision-point inventory

- `validateInstarRepoCandidate` — modified — tracks matched remote name + fetch-vs-pushurl; fetch-url match upgrades a pushurl-only match (refs beat trust-only). Trust semantics unchanged: same allowlist, same accept/reject outcomes.
- `ResolvedInstarRepo` — extended — `remoteName`, `remoteFetchesCanonical` (additive).
- `resolveBaseBranch` — modified — NEW preferred tier (allowlisted fetch-canonical remote ≠ origin: its HEAD, then its main); existing origin/HEAD → local-main fallbacks unchanged and still terminal. Exported for tests.
- `ensureHuskyHooksActive` — modified — silent early-return → loud throw. Exported for tests.

## 1. Layout-by-layout behavior analysis

- **Single-remote canonical clone** (origin url allowlisted): remoteName='origin', fetch-canonical=true → preferred tier skipped (`!== 'origin'` guard) → origin/HEAD as before. Byte-identical.
- **Fork origin + canonical second remote with allowlisted FETCH url**: base = `<canonical>/main` — the fix working as intended.
- **Fork origin, pushurl-only trust (the live Echo home, default allowlist)**: fetch-canonical=false → base falls back to origin/HEAD (still the fork) → worktree creation now FAILS LOUDLY at the husky step with the remedies, instead of silently producing a checks-free worktree. Operators fix via `--base`, `worktree.defaultBaseBranch`, or adding their canonical remote's fetch url to `worktree.repoUrlAllowlist` (which upgrades them to the preferred tier).
- **Branch already exists** (no base resolution): unchanged.
- **Explicit `--base`**: unchanged, always wins.

## 2. Could the loud throw break a legitimate flow?

Searched for legitimate package.json-less worktrees: `InstarWorktreeManager` creates worktrees of the INSTAR repo only (allowlist-validated); every canonical instar code branch has package.json + .husky/pre-commit. A base without them is precisely the broken case. The throw happens AFTER `git worktree add` — the error includes the exact `git worktree remove --force` cleanup command.

## 3. Over-permit

None — no trust widening; remote preference only selects among already-allowlisted remotes' refs.

## 4. Migration parity

None — src-internal CLI behavior.

## 5. Token/cost impact

None.

## 6. Rollback

Revert the commit: base resolution returns to origin/HEAD-first and the husky step returns to the silent skip (the garbage-worktree failure returns with it).
