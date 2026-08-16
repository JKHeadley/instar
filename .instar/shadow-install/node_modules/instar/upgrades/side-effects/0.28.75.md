# Side Effects — fix(StateManager): discriminate EPERM/EACCES from JSON corruption

**Cluster**: `cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi`
**Risk**: LOW (diagnostic-only)
**Spec**: `docs/specs/fix-statemanager-eperm-discrimination.md`

## What changes (summary)

`StateManager.ts` adds a `describeReadError(err, filePath)` helper that classifies read errors into `permission` (EPERM/EACCES), `parse` (SyntaxError), and `io` (other). All four read sites — `getSession`, `listSessions`, `getJobState`, `get` — use the helper to populate `console.warn` and the `DegradationReporter.report({reason})` field. The null-return contract, the `feature` field, and `primary`/`fallback`/`impact` strings are preserved.

## 1. What user-facing behavior changes?

The DegradationReporter `reason` text changes for state-file read failures. Permission errors now read "Permission denied reading <path> (EPERM). On macOS, launchd-spawned processes need Full Disk Access to read under ~/Documents." instead of "Corrupted job state file: EPERM: operation not permitted, open '<path>'". JSON parse errors now read "Corrupted state file <path> (JSON parse failed): <message>". I/O errors get a generic "Failed to read <path> (<code>): <message>".

No CLI surface, dashboard view, or API endpoint changes shape. Anyone consuming the DegradationReporter feed sees better-targeted reasons; anyone grouping by `feature`/`fallback` is unaffected.

## 2. What ledger / state / on-disk artifacts change?

None. The change is in the catch handler of read paths. No writes added, no schema changes, no new files. State files on disk are read identically.

## 3. What downstream agents / consumers rely on the previous behavior?

The Outside-Dawn feedback pipeline currently clusters reports by `feature` and (sometimes) substring-match on `reason`. The cluster `cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi` was formed by substring "Corrupted job state file" in reasons. After this fix, EPERM reports will land in a NEW cluster keyed off "Permission denied reading" — that's the intended outcome (the reporter pipeline auto-clusters new substrings into new clusters). The old cluster is being closed out as `fixed` in this same release.

No agent code consumes the `reason` text programmatically (verified: grep for `Corrupted job state file` and `Corrupted state file` across `src/` shows zero hits outside `StateManager.ts`).

## 4. What tests verify the change?

- `tests/unit/StateManager.test.ts` — 25 pre-existing tests pass unchanged. The "Corrupted File Handling" group still asserts `null` returns for genuine parse-error inputs.
- New test: `discriminates permission errors from corruption (EPERM/EACCES)`. Chmod 0o000s a file, captures `console.warn` calls, asserts that any warning emitted contains "permission" and none contain "parse"/"Corrupted". Skips when running as root (where chmod is bypassed) and tolerates sandboxed runners that no-op chmod.

## 5. What rollback path exists?

`git revert` of the StateManager.ts diff + patch release. The revert is safe at any time:
- No persistent state needs cleanup (the change writes nothing new).
- Agents updated to the fixed version that subsequently downgrade keep working — the same `feature` names and null-return contract apply.
- The new feedback cluster (keyed off "Permission denied reading") simply stops receiving new reports; existing reports remain in their cluster.

## 6. What's the blast radius if the change is wrong?

Bounded to log/feedback-feed cosmetics. The worst case is a confusing `reason` string in a degradation report; no functional path is changed because:
- The catch handler still returns null on every error path it previously returned null on.
- The `feature` and `fallback` semantics are unchanged, so the scheduler/loader logic that gates on degradation reports continues to work.
- The new helper has no I/O of its own — it's a pure string formatter over the caught error.

A bug in `describeReadError` (e.g., throwing inside the formatter) would be caught by the existing outer null-return contract test cases, which would fail and block the release.

## 7. What invariants must hold after this change?

- `getSession`, `listSessions`, `getJobState`, `get` still return `null` (or skip the file in `listSessions`) on ANY read failure. Verified by tests.
- `DegradationReporter.report({feature, primary, fallback, impact})` for these paths still passes the same constants — only `reason` content is discriminated. Verified by inspection.
- `console.warn` still emits one line per failure, prefixed `[StateManager] <method> <kind>:`. Operators tailing logs see strictly more information than before.
- No new module-load side effects: the helper is a plain function in the same module, not a new import or class.
