# Side-Effects Review — Git hygiene sentinel for agent-local Instar state

**Version / slug:** `git-hygiene-sentinel`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `required before merge if policy requires an
independent maintainer read; implementation is otherwise covered by focused
tests and typecheck`

## Summary of the change

This change prevents `GitSyncManager` from sweeping local-only or secret-bearing
agent state into commits when staging broad `.instar/` scopes.

What lands:

- `src/core/FileClassifier.ts`
  - Adds Instar-specific runtime/generated patterns such as `.instar/messages/`,
    `.instar/reports/`, `.instar/sessions/`, `.instar/shadow-install*`,
    `.instar/telegram-inbound/`, and `.instar/views/`.
  - Adds Instar-specific secret patterns such as `.instar/config.json`,
    `.instar/config.json.*`, `.instar/identity.json`, `.instar/agent-tokens/`,
    `.instar/cloudflared-*.yml`, `.claude.json`, and `.mcp.json`.
  - Matches patterns against both basenames and normalized repo-relative paths.
- `src/core/GitSync.ts`
  - Replaces broad direct staging with `syncEligibleDirtyPaths`.
  - Uses raw `git status --porcelain -z -- <paths...>` output to enumerate dirty
    paths without corrupting leading-space status bytes.
  - Skips non-delete dirty paths whose classifier strategy is `exclude` or
    `never-sync`.
  - Allows deletions so cleanup commits can untrack previously bad paths.
  - Falls back to existing add/diff behavior when status reports no dirty entries
    or the status call fails.
- Tests:
  - `tests/unit/file-classifier.test.ts` covers Instar local secret/runtime
    classification.
  - `tests/unit/GitSync.test.ts` covers skipped secret/runtime paths and
    legitimate state staging.

## Decision-point inventory

1. **Pattern list expansion** — add — classifies known agent-local paths as
   generated or secret.
2. **Repo-relative pattern matching** — add — makes directory patterns like
   `.instar/messages/` effective, not just basename patterns.
3. **Status-first staging filter** — add — classifies dirty paths before `git add`.
4. **Deletion allowance** — add — lets cleanup commits remove bad historical
   tracked files even when their path classifies local-only.
5. **Raw status helper** — add — avoids trimming machine-readable porcelain
   status output.

## 1. Over-block

Possible over-block: a future file under one of the excluded directories might
turn out to be useful shared state. The impact is that GitSync leaves it local
and reports a degradation event. The fix is additive and low-risk: move that
file to a syncable location or narrow the classifier pattern with a test.

This is preferable to under-blocking because the failure class being addressed
is accidental commit of local runtime artifacts and secret-bearing config.

## 2. Under-block

The classifier can only block paths it knows about. New local runtime paths not
covered by these patterns can still be staged. The implementation makes this
easy to extend by keeping the path list centralized in `FileClassifier` and
testing the path families directly.

The fallback to existing add/diff behavior on status failure is a deliberate
availability tradeoff: a transient status failure should not permanently disable
sync. The normal path is covered by focused tests.

## 3. Level-of-Abstraction Fit

Right layer. `FileClassifier` already owns merge/staging strategy categories,
and `GitSyncManager` owns the staging operation. The server, dashboard, and
caller code do not need to understand which local files are safe for Git.

## 4. Signal vs Authority Compliance

This is a structural git safety guard, not a conversational or product-judgment
authority surface. It does not decide what an agent should do; it decides which
local files may be staged by an automatic sync operation.

## 5. Interactions

- `.gitignore`: still useful for new untracked files, but this guard also
  protects already-tracked bad paths by inspecting dirty tracked files before
  staging.
- Cleanup commits: deletions are allowed so agents can untrack local artifacts.
- Existing commit messages and auto-push behavior: unchanged.
- Degradation reporting: skipped paths are reported so the decision is visible
  to operators without leaking file contents.

## 6. External Surfaces

No HTTP route, CLI flag, config field, dashboard panel, or schema migration is
added. The visible behavior is that GitSync no longer includes local-only paths
in auto-sync commits.

## 7. Rollback Cost

Trivial code revert. No state migration.

## Verification

- `./node_modules/.bin/vitest run tests/unit/file-classifier.test.ts tests/unit/GitSync.test.ts`
  - 137 tests passed.
- `./node_modules/.bin/vitest run tests/e2e/sync-edge-cases.test.ts tests/unit/no-silent-fallbacks.test.ts tests/unit/file-classifier.test.ts tests/unit/GitSync.test.ts`
  - 191 tests passed after CI surfaced the edge-case and no-silent-fallback regressions.
- `pnpm exec tsc --noEmit`
  - clean.

An accidental broad `pnpm test -- tests/unit/file-classifier.test.ts
tests/unit/GitSync.test.ts` invocation ran unrelated suites and surfaced
pre-existing E2E session-management timeouts before being stopped. Those
failures are not attributed to this change.

## Second-pass review

**Reviewer:** `Ohm` subagent

Initial result: concern raised. The reviewer found that the first implementation
parsed `git status --porcelain -z` rename/copy records backwards: NUL mode emits
the destination path first and the source path second, while the code advanced
to the source path.

Resolution:

- `src/core/GitSync.ts` now keeps the destination path and skips the following
  source-path field for rename/copy records.
- `tests/unit/GitSync.test.ts` now includes regression coverage for rename
  destination staging, deletion allowance for `never-sync` paths, and status
  fallback behavior.

Final result after amendments: `Concur with the review`.

## CI follow-up

The first PR CI run found two issues and both were addressed:

- `tests/e2e/sync-edge-cases.test.ts` expected `.instar/config.json` to remain
  normal structured data. That path is intentionally secret / never-sync under
  this change, so the structured-data fixture now uses `.instar/jobs.json`.
- `tests/unit/no-silent-fallbacks.test.ts` counted an existing
  `FileClassifier` binary-stage inspection catch after nearby edits shifted its
  detection window. The catch now has an explicit `@silent-fallback-ok` marker
  because failure to inspect binary stages escalates to conflict resolution.
