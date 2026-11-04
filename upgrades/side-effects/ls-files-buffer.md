# Side-Effects Review — tracked-file list buffer in a test

**Tier 1.** A test-only change, fully undone by a revert.

## Summary

`tests/unit/audit-convergence-reports.test.ts` calls `git ls-files` with Node's default 1 MB output limit. The tracked list on `main` reached 1,048,674 bytes, just over 1,048,576, so the call throws `ENOBUFS`. That makes `main` red and fails every pull request's verify. The test now allows 64 MB.

## 1. Over-block

None. The test is no stricter.

## 2. Under-block

- The list keeps growing, mostly from `.instar/instar-dev-decisions`, `.instar/instar-dev-traces` and `upgrades/side-effects`, each of which grows with every change. 64 MB is far off, but the growth isn't addressed here.
- I searched other whole-repository git reads. `SafeGitExecutor` defaults to 10 MB and `scripts/release-skip-annotate.mjs` to 64 MB, so neither is near a limit. I searched for `ls-files` and a few `ls-tree` and `diff --name-only` forms, which isn't every possible read.

## 3. Level-of-abstraction fit

It belongs in the test's own call.

## 4. Signal vs authority compliance

No decision point. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

None. The test reads the same list as before.

## 6. External surfaces

None.

## 7. Multi-machine posture

Not applicable: a test.

## 8. Rollback cost

A revert restores the failure.

## Class-Closure Declaration (display-only mirror)

- defectClass: unbounded-self-action
- closure: n/a
- reason: A buffer size in a test. Nothing acts on its own.
