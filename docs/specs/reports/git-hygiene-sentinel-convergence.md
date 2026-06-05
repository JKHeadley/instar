# Spec Convergence Report — Git hygiene sentinel

**Spec:** `docs/specs/git-hygiene-sentinel.md`
**Date:** `2026-06-05`
**Reviewer:** `instar-codey`
**External cross-model posture:** unavailable (`codex-auth-apikey-forbidden`)

## Result

Converged for this implementation pass.

No material findings remain after implementation and focused verification.

## Review Pass

### Security / privacy

The change moves the automatic sync path away from broad `.instar/` staging and
toward path-by-path classification. Known local secret paths classify
`never-sync`; known local runtime paths classify `exclude`. Deletions remain
stageable so cleanup commits can remove historically tracked bad files.

Residual risk: new local runtime directories not represented in
`FileClassifier` can still be staged. This is an additive maintenance risk, not
a regression from the current behavior.

### Integration

The implementation stays within existing layers:

- `FileClassifier` owns path strategy.
- `GitSyncManager` owns staging.
- `DegradationReporter` surfaces skipped-path decisions.

No route, config, schema, or dashboard contract changes.

### Failure direction

Over-block leaves a file local and emits a degradation report. Under-block can
still stage a newly introduced local path family. Given the incident that drove
this change was accidental inclusion of local artifacts, this direction is the
right default.

### Verification

- Focused unit tests:
  `./node_modules/.bin/vitest run tests/unit/file-classifier.test.ts tests/unit/GitSync.test.ts`
  passed, 137 tests.
- CI failure reproductions:
  `./node_modules/.bin/vitest run tests/e2e/sync-edge-cases.test.ts tests/unit/no-silent-fallbacks.test.ts tests/unit/file-classifier.test.ts tests/unit/GitSync.test.ts`
  passed, 191 tests.
- Typecheck:
  `pnpm exec tsc --noEmit` passed.
- Build:
  `pnpm build` passed. It warned that uncommitted source changes can make the
  generated manifest differ from committed source, and warned that no local
  release signing key was available. Both are expected in this development
  worktree.

### Non-material observations

An accidental broad test invocation ran unrelated suites and hit existing E2E
session-management timeouts before being stopped. The focused tests and
typecheck are the verification signal for this change.

## Second-Pass Finding and Resolution

Independent second-pass review initially raised one material concern:
`git status --porcelain -z` rename/copy entries were parsed backwards. In NUL
mode Git emits the destination path first and the source path second. The first
implementation advanced to the second field, which would classify/stage the old
source path instead of the destination.

Resolution:

- `GitSyncManager.syncEligibleDirtyPaths` now keeps the first path for rename
  and copy records and skips the following source-path field.
- `tests/unit/GitSync.test.ts` now covers rename destination staging, deletion
  allowance for a `never-sync` path, and fallback behavior when the status
  lookup fails.

## CI Follow-Up

The first PR CI run exposed two additional regressions:

- The older sync edge-case test still expected `.instar/config.json` to be
  structured data. The new product behavior deliberately treats that path as
  secret / never-sync, so the test now uses `.instar/jobs.json` as the normal
  structured state example.
- The no-silent-fallback ratchet counted an existing binary-stage inspection
  fallback in `FileClassifier` after nearby edits shifted its detection window.
  That catch now carries the explicit exemption marker because it escalates to
  conflict resolution rather than silently accepting a binary merge.
