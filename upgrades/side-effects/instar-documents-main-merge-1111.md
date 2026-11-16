# Side-Effects Review — Instar Documents: merge with main (2026-11-11)

**Version / slug:** `instar-documents-main-merge-1111`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

PR #3053 (Instar Documents, dark-gated) had gone stale against main (v1.3.1739) and showed CONFLICTING. This commit merges origin/main into the branch, and changes no behavior. The four content conflicts were all parallel additions, and both sides are kept:

- `dashboard/console/console.js`: the branch's `renderDocuments` import, plus main's new `rememberOperatorSession` / `forgetOperatorSession` from `ui.js`.
- `src/scaffold/templates.ts`: both `DOCUMENTS_CLAUDEMD_SECTION` and main's `USAGE_LEDGER_CLAUDEMD_SECTION`, imported and rendered.
- `tests/integration/team-access-status-table.test.ts`: main's improved `sample()` helper, plus the branch's extra `[0-9a-f-]{36}` → UUID replacement that the documents routes need.
- `tests/unit/capabilities-discoverability.test.ts`: both `documentRoutes.ts` and `usageRoutes.ts`.

Main's release removed `upgrades/next/`, so git proposed moving the branch's five release notes to `upgrades/`. They are kept in `upgrades/next/`, where the next release assembler reads them.

## Decision-point inventory

None. No runtime decision logic changed in the merge. Every feature decision point is as reviewed in the earlier artifacts (`instar-documents-core.md` through `instar-documents-proof-fixes.md`).

## 1. Over-block

No issue identified. The merge adds no checks.

## 2. Under-block

No issue identified. The merge removes no checks.

## 3. Level-of-abstraction fit

Not applicable: this is a merge with no new logic.

## 4. Signal vs authority compliance

Not applicable: no decision point changed.

## 5. Interactions

The documents CLAUDE.md section now renders next to main's usage-ledger section. The two are independent.

## 6. External surfaces

None beyond what the feature already had. Documents stay dark for everyone except development agents.

## 7. Multi-machine posture

Unchanged from the feature artifacts.

## 8. Rollback cost

Revert the merge commit. No state.

## Evidence

- `tsc --noEmit` is clean on the merged tree.
- Unit tests: `documents*`, `console-documents` and `capabilities-discoverability` pass (21 files, 375 tests). Integration tests: `documents*` and `team-access-status-table` pass (4 files, 38 tests).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-11-11
**Independent read of the artifact: concur**

For each conflicted file, the reviewer compared the branch side, the main side and the result. In `console.js`, both imports and the `work/documents` route are kept. The only branch lines dropped are the old ui.js import and a comment that main's operator-session change superseded. In `templates.ts`, both sections are imported and rendered, and main's longer context-budget row replaced the branch's older one. The team-access test uses main's `sample()` and `deviceBucket.clear()` plus the branch's UUID replacement. The discoverability list has both routes. Under `upgrades/`, the merge adds only the branch's own documents notes and side-effects files, and nothing of main's is dropped.
