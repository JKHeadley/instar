# Side-Effects Review — guard-safe remote enumeration in resolveInstarRepo

**Version / slug:** `worktree-remote-urls`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; the does-this-widen-the-guard question addressed below`

## Summary of the change

`validateInstarRepoCandidate`'s any-remote allowlist check enumerates remotes via `git config --get-regexp '^remote\..*\.(url|pushurl)$'` instead of `git remote -v`. The `remote` verb is not in SafeGitExecutor's source-tree allowance, so against an agent home (which IS the instar source tree) the old call threw inside `tryGit`, was swallowed as `{ok:false}`, and #777's any-remote check silently no-oped — `instar worktree create` rejected every agent's own checkout, and agents fell back to raw `git worktree add`, which skips identity + husky-hook wiring (the silent local-gate bypass found as task #81).

## Decision-point inventory

- Remote enumeration call — modified — `remote -v` → read-only `config --get-regexp` (already in the guard's allowed set; no guard changes).
- Line parser — modified — `remote.<name>.(url|pushurl) <url>` shape; now covers `pushurl` explicitly (the fork-fetch/canonical-push origin shape used by real agent homes — `remote -v` surfaced it only incidentally).
- Allowlist semantics — unchanged — same allowlist, same first-match acceptance, same rejection error.

## 1. Direction-of-failure analysis

- **Old failure (live):** the resolver rejected valid agent homes → CLI unusable → raw-git fallback → no husky shim → pre-commit gate (lint, instar-dev gate, decision-audit) silently never ran on worktree commits. Verified across all three of this session's worktrees.
- **New behavior:** verified live — `resolveInstarRepo({cwd: <agent home>})` resolves via the allowlisted pushurl. The CLI path works again, which wires `ensureHuskyHooksActive` on every created worktree (that code already existed and was unreachable in practice).
- **Trust surface NOT widened:** acceptance still requires an allowlisted URL; the new `pushurl` coverage accepts only URLs already in the same allowlist (a checkout that can PUSH to canonical instar is at least as trusted as one that fetches from it). A repo with no allowlisted url/pushurl is still rejected — pinned by test.
- **Guard untouched:** SafeGitExecutor / SourceTreeGuard are not modified; the fix moves the caller onto an already-permitted read form.

## 2. Over-permit

The only semantic addition is `pushurl` matching. Bounded by the same allowlist; no wildcarding, no new verbs permitted.

## 3. Scope deliberately NOT taken

- Adding `remote` (read-only shapes) to the guard's allowed verbs — unnecessary once the caller uses config reads, and widening the guard for one caller is the wrong direction.
- A CI-side structural check for gate-bypassed commits (no decision-audit entry in a PR) — tracked separately under task #81's close-out.

## 4. Migration parity

None — src-internal; ships with the next release, applies wherever the CLI runs.

## 5. Token/cost impact

None.

## 6. Rollback

Revert the commit; the resolver returns to rejecting agent homes (and the raw-git fallback returns).
