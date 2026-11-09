# Side-Effects Review — audit-convergence test reads the file list with an explicit buffer

**Version / slug:** `test-lsfiles-buffer`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra`

## Summary of the change

`tests/unit/audit-convergence-reports.test.ts` failed on main with `spawnSync git ENOBUFS`: the repository's tracked-file list passed Node's 1 MiB default `maxBuffer` (1,048,674 bytes on main at 6436a019d). Both of the test's `git ls-files` reads now pass an explicit 64 MiB buffer. Test-only; no product code changes.

## Decision-point inventory

None.

---

## 1. Over-block

None: the test's assertions are unchanged.

## 2. Under-block

None added. The listing overflows its buffer again only past 64 MiB; the test's own validation failures are unchanged.

## 3. Level-of-abstraction fit

The buffer belongs at the call. Other full listings already set one: `scripts/release-skip-annotate.mjs` (64 MiB) and SafeGitExecutor (10 MiB default). Known gap, out of scope here: the evidence-artifact hook that `src/core/PostUpdateMigrator.ts` installs lists `CLAUDE_PROJECT_DIR` (or the working directory) with Node's default buffer, and on overflow its `git()` helper returns an empty list silently. That is a hook change with its own migration path, filed as feedback rather than folded into this unblock fix.

## 4. Signal vs authority compliance

Not applicable: no runtime decision.

## 5. Interactions

Unblocks the local-verify queue, which held PRs 2719, 2733 and 2734 while main was red on this file.

## 6. External surfaces

None.

## 7. Multi-machine posture

Test code; not applicable.

## 8. Rollback cost

Revert one test file.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra

Concur with the review. The audit gate is unchanged: assertions, report selection, exemptions, parsing and validator arguments are identical, and both listings still fail on errors. `maxBuffer` is the right option and 64 MiB the right value; the constant initializes before either helper runs. The buffer claims for `scripts/release-skip-annotate.mjs` and SafeGitExecutor were confirmed. Low findings, applied: the byte count is main's (1,048,674), the PostUpdateMigrator listing is not guaranteed small and is now named as a known gap, and the under-block line now speaks only of buffer overflow. The reviewer's sandbox could not run vitest (EPERM writing Vite's temporary config); the test passes locally (5/5) and in local verify. VERDICT: YES.
