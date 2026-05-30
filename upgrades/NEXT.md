---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "Please proceed as you best to see fit" — my judgment call to fix SourceTreeGuard's read-vs-write distinction first, since it blocks the failure-learning telemetry I just enabled)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Failure-Learning Loop's git reads now work on dogfooding agents.**

The 2026-05-29 pipeline post-mortem (PR #545) flipped on the `ci` and
`revert` ingestion sources for Echo. The next ~hour of `server-stderr.log`
filled with `[revert-detector] SourceTreeGuardError: Refusing to run
failure-learning:revert-detect against the instar source tree` warnings,
once per detector tick, while `/failures/analysis` kept reporting `total: 1`.
The loop's whole point — capture CI failures + reverts so we can learn from
them — was silently broken on the canonical dogfooding agent.

Cause: `RevertDetector` (and the `CiFailurePoller`'s `resolveRepo`, and the
`FailureAttributionEngine`'s `commitTouchedFiles`) call
`SafeGitExecutor.readSync` to read `git log` / `git show` / `git remote
get-url`. SourceTreeGuard refuses any operation against the agent's own
checkout when that checkout IS the instar source tree — which is exactly the
case for Echo. The guard exists for write protection (the 2026-04-22
destructive-tool-target class), but it gates reads by default too. There's
an existing, audited escape hatch — `SafeGitOptions.sourceTreeReadOk:
true` — already used by the worktree-manager and the canonical-ref
reconciler, scoped to the explicit `SOURCE_TREE_READ_TIER_VERBS` set
(`log`, `show`, `cat-file`, `remote`, `rev-parse`, `ls-tree`, …).

Fix: opt every failure-learning git read at every callsite into that
escape hatch. No guard weakening; only the three loop callsites change.

The existing RevertDetector + CiFailurePoller unit tests entirely mocked
the `git` / `runGh` injection points, which is how the gap shipped silently
in the first place. This PR adds a static-introspection unit test that
pins the call shape, plus an integration test that exercises the DEFAULT
git invocation against the actual instar source tree (the path the
existing tests never touched).

## What to Tell Your User

Nothing visible unless you've also flipped on `monitoring.failureLearning.
sources.ci: true` / `sources.revert: true` on an agent whose project
directory IS the instar source tree. If you have, the
`[revert-detector] SourceTreeGuardError` warnings in `server-stderr.log`
will stop on the next process restart, and the failure-learning loop's
revert + CI sources will start actually capturing events.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Failure-learning revert detection works on dogfooding agents | Automatic. RevertDetector's default git invocation now passes `sourceTreeReadOk: true`. |
| Failure-learning CI poller resolves repo on dogfooding agents | Automatic. `resolveRepo` no longer trips SourceTreeGuard. |
| Failure-learning attribution engine reads touched files on dogfooding agents | Automatic. `commitTouchedFiles` no longer trips SourceTreeGuard. |
| Static-introspection guard against future failure-learning git reads missing the flag | Automatic (CI). A new unit test scans every `SafeGitExecutor.readSync` tagged `failure-learning:*` and fails if `sourceTreeReadOk: true` is missing. |

## Evidence

- 5 new tests (4 unit + 1 integration). Both new tests verified by
  destructive-negative test (removing the flag from `RevertDetector` →
  both tests fail as expected, with `SourceTreeGuardError` surfacing).
- `tsc --noEmit` clean.
- Side-effects review:
  `upgrades/side-effects/failure-learning-source-tree-readok.md`.
- Existing `RevertDetector.test.ts` (9 tests) and `CiFailurePoller.test.ts`
  (12 tests) remain green.
