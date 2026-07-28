# Side-Effects Review — Pre-push smoke failed-files retry

**Version / slug:** `prepush-smoke-failed-files-retry`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change keeps the existing pre-push smoke base resolver and breadth guard, then makes the smoke retry file-scoped. `scripts/pre-push-smoke.mjs` now writes a Vitest JSON report during the affected smoke run; if that run fails, it extracts unique failed test files and reruns only those files once. `scripts/lib/pre-push-scope.mjs` owns the failed-file extraction helper, `tests/unit/scripts/pre-push-scope.test.ts` covers the parsing behavior, and `.husky/pre-push` no longer retries the whole smoke command after the smoke runner has handled its own retry. The full push-suite path keeps its previous whole-command retry behavior.

## Decision-point inventory

- `scripts/pre-push-smoke.mjs#runAffectedSmoke` — add — decides whether a failed smoke run has a trustworthy failed-file list and performs one focused retry.
- `scripts/lib/pre-push-scope.mjs#failedTestFilesFromVitestJson` — add — extracts failed test file names from Vitest JSON output.
- `.husky/pre-push` — modify — decides whether retry is owned by the smoke runner or by the outer hook loop.

---

## 1. Over-block

The new JSON parser can fail to identify failed files if Vitest changes its JSON shape or the report file is not written. In that case the smoke runner preserves the original failure rather than passing the push. That can leave a developer with a normal failed smoke run instead of a focused retry, but it does not create a new block beyond the failure already observed.

A file can be retried even if only one test case inside it failed. That is intentional: file-scoped retry avoids needing brittle test-name parsing while still shrinking the second run substantially.

## 2. Under-block

If a test passes on focused retry after failing in the affected-set run, the hook passes. That is the existing retry semantics applied more narrowly. A real ordering or cross-file interaction could be masked by retrying only the failed file, but PR CI remains the full authority and will run the broader matrix before merge.

The change does not detect failures outside Vitest's affected-test selection. That limitation already exists in local smoke and is explicitly bounded by CI.

## 3. Level-of-abstraction fit

The failed-file parser is at the right layer: it consumes Vitest's structured report instead of scraping terminal prose. The retry decision lives in the smoke runner because that runner has the selected base, first-run result, and report file path. The outer Husky hook stays as the orchestration wrapper and still owns the full-suite retry path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Not applicable to conversational/product judgment — this is local developer-tooling retry control.

The logic has local authority over which smoke files to retry, but it does not judge user intent, message meaning, external operations, or product behavior. It is deterministic process tooling. When the structured signal is unavailable, it fails conservatively by preserving the original failure.

## 5. Interactions

- **Shadowing:** The smoke runner's focused retry replaces the outer hook's whole-smoke retry only for `npm run test:smoke`. The full push-suite path is unchanged.
- **Double-fire:** The outer hook now runs the smoke command once, so the focused retry cannot be followed by a whole affected-set retry from the wrapper.
- **Races:** The JSON report is written into a per-run temporary directory and deleted in `finally`. No persistent state is shared across pushes.
- **Feedback loops:** No runtime state feeds back into future runs. The retry list is computed only from the current Vitest report.

## 6. External surfaces

This affects local developers and agents pushing Instar branches. Terminal output changes when the first smoke attempt fails: the hook now prints the failed files being retried. CI, GitHub checks, Telegram, dashboard behavior, persisted ledgers, and installed-agent runtime behavior are unchanged.

## 7. Rollback cost

Rollback is a pure code revert of `.husky/pre-push`, `scripts/pre-push-smoke.mjs`, `scripts/lib/pre-push-scope.mjs`, the focused parser tests, and this artifact/spec pair. No data migration, agent state repair, or user notification is required. The regression during rollback would be returning to whole affected-set retry for local smoke failures.

## Conclusion

The review found one real tradeoff: a focused retry can pass after a cross-file interaction fails in the first affected run. That is acceptable for local smoke because CI is the authority and the first failure remains visible in the terminal output. The change is clear to ship with parser tests, a Vitest JSON compatibility probe, and the instar-dev gate.

---

## Second-pass review (if required)

**Reviewer:** instar-codey second-pass checklist
**Independent read of the artifact:** concur

The second pass agrees that this is local developer-tooling behavior, not a product/message authority. The full-suite authority boundary remains CI, and malformed report handling is conservative.

---

## Evidence pointers

- `tests/unit/scripts/pre-push-scope.test.ts`
- `scripts/pre-push-smoke.mjs`
- `scripts/lib/pre-push-scope.mjs`
- Manual Vitest 2 JSON reporter probe using a temporary failing test file; report shape confirmed as `testResults[].name/status/assertionResults[]`.
