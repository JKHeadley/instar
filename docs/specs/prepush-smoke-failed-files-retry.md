---
title: Pre-push smoke failed-files retry
review-convergence: retrospective-single-pass
approved: true
eli16-overview: prepush-smoke-failed-files-retry.eli16.md
---

# Pre-push Smoke Failed-Files Retry

## Problem

The pre-push hook still retries the local smoke tier by running the entire affected-test command a second time. After the base resolver and broad-set guard, the selected set is no longer pathological in normal agent worktrees, but it can still be large enough that repeating the whole set wastes local time when only one or a few files failed.

Local smoke is a fast pre-check. It should spend its retry budget on the files that actually failed, while PR CI remains the authoritative full-suite gate.

## Scope

This change updates the local pre-push smoke path only:

- Keep the existing affected-test selection, base resolver, and broad-set guard.
- On the first smoke run, preserve normal Vitest terminal output and also write a JSON result report.
- If the first smoke run fails, parse the JSON report to extract the unique failed test files.
- Retry only those failed test files once.
- If the report is missing, malformed, or contains no failed files, preserve the original failure instead of hiding it.
- Prevent the outer Husky wrapper from re-running the whole smoke command after the smoke runner has already performed the focused retry.

## Non-Goals

- Do not change CI behavior.
- Do not change the Vitest push config exclusions.
- Do not broaden or narrow the affected-test selection logic from the previous PR.
- Do not add per-test-case retry semantics; this retry is file-scoped.

## Acceptance Criteria

- A failed smoke run retries only the failed test files once.
- The retry logs the file list it is re-running.
- Missing or unparsable Vitest JSON does not turn a failed smoke run into a pass.
- The full push-suite path keeps its existing whole-command retry behavior.
- Unit tests cover failed-file extraction from Vitest JSON.
- The instar-dev precommit gate passes before publishing.
