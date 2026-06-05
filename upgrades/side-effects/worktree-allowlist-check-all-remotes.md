# Side-Effects Review — worktree repo validation checks all remotes, not just origin

**Version / slug:** `worktree-allowlist-check-all-remotes`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `required (touches a security validation boundary)`

## Summary of the change

`validateInstarRepoCandidate()` in `InstarWorktreeManager.ts` validated a checkout by reading ONLY `remote.origin.url` and checking it against `worktree.repoUrlAllowlist`. Fleet agents fork instar (origin = `instar-<name>.git`, NOT allowlisted) and keep a canonical remote (e.g. `upstream`/`instar-ai`) that the worktree actually builds against — so `instar worktree create` rejected every agent's own checkout. The fix accepts the checkout if origin is allowlisted (unchanged fast path) OR if any remote (`git remote -v`) is allowlisted.

## Decision-point inventory

1. **origin allowlisted** → accept, `remoteUrl = origin` (unchanged).
2. **origin not allowlisted (or unset)** → scan `git remote -v`; accept the first remote whose url is allowlisted, `remoteUrl = that url`.
3. **no allowlisted remote at all** → reject with the SAME messages as before (`remote.origin.url unset` when origin unset; `remote.origin.url <url> not in worktree.repoUrlAllowlist` otherwise).

## 1. Security boundary (does this weaken trust?)

No. The allowlist remains the sole trust gate. The change only stops a FALSE NEGATIVE: a checkout with a fork origin but a canonical (allowlisted) remote was always a legitimate instar checkout — that's literally the fleet convention. A repo with NO allowlisted remote is still rejected, byte-for-byte the same error. An attacker cannot pass without putting an allowlisted (canonical) url on one of the repo's own remotes, which is the same trust signal as before — just no longer required to be named `origin`.

## 2. Over-block / under-block

- Over-block removed: fork-origin checkouts with a canonical remote now pass (the bug). 
- Under-block: none new — every accept path still requires an allowlisted url to be present on the repo. The `core.hooksPath`-outside-repo refusal and path-containment checks are untouched.

## 3. Behavior preserved (test-verified)

- "rejects when remote.origin.url is unset" — preserved (`remote.origin.url unset`).
- "rejects when remote.origin.url is not in the allowlist" (single non-allowlisted origin, no other remote) — preserved (`… not in worktree.repoUrlAllowlist`).
- "accepts a repo with allowlisted origin" — preserved (fast path).
- NEW: "accepts a fork origin when a second remote is allowlisted" — the fix.
- 31/31 InstarWorktreeManager tests green; `tsc --noEmit` clean.

## 4. Reversibility

Fully reversible: revert the `validateInstarRepoCandidate` block + drop the new test. No state, no config, no migration.

## 5. Blast radius

One function in `src/core/InstarWorktreeManager.ts` + one unit test. No route, config contract, or persistence change. Affects only `instar worktree create` resolution.

## Second-pass review

**Reviewer:** required — independent read of the diff confirms the allowlist remains the trust gate; only the remote SOURCE widened from origin-only to all-remotes. Rejection paths + messages for untrusted repos are unchanged. The `git remote -v` parse uses an anchored regex `^\S+\s+(\S+)\s+\((?:fetch|push)\)$` and exact `allowlist.has()` membership (no substring/loosening).
