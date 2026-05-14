# Side-effects review — File Viewer extends never-editable to .instar/jobs/instar/

## What changed

Two-line spec compliance item from INSTAR-JOBS-AS-AGENTMD §Decision Points:

- `src/server/fileRoutes.ts:NEVER_EDITABLE_PREFIXES` adds `.instar/jobs/instar/`. Any `PATCH /api/files/config` attempt to declare an `editablePath` under that prefix is rejected with HTTP 400 + "never editable" error. Direct save attempts on a file under that path are rejected the same way.
- Migrator-emitted CLAUDE.md doc string (`PostUpdateMigrator.ts` line 1501) updated to list `.instar/jobs/instar/` alongside the existing never-editable namespaces.

## Why

The `.instar/jobs/instar/` namespace is owned by the update process and signed against the bundled lock-file. A Dashboard editor that lets the operator edit a default's body would (a) be overwritten on next update, (b) break the body-hash verification, and (c) bypass the spec's intended override flow (fork to `.instar/jobs/user/` via the Override action).

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none for users — the override flow is the documented path for customizing a default. Hand-edits in the file viewer were never useful here (they'd revert on update).
- **Under-block:** the prefix check is exact-startswith. A path like `.instar/jobs/instar.lock.json` is NOT under `.instar/jobs/instar/` (different filename), so the lock-file itself remains read-accessible. That's correct: the lock-file is JSON that the operator may want to view for debugging.

### 2. Level-of-abstraction fit

One entry in a closed-set array. Zero new code paths.

### 3. Signal-vs-authority compliance

`NEVER_EDITABLE_PREFIXES` is the authority for "what can be edited via the Dashboard." Adding to the list strengthens, not weakens, the structural property.

### 4. Interactions

- **Phase 2 installBuiltinJobs** — already writes `.instar/jobs/instar/<slug>.md` on init + update; the never-editable list is the matching read-only enforcement.
- **Phase 4 Dashboard UI rewrite (future)** — the future override/unfork UI lives at a different path; not affected by this change.
- **File Viewer config UI** — config save endpoint already rejects never-editable prefixes; this addition is automatically enforced there.

### 5. Rollback cost

Trivial. Remove one line + revert one CLAUDE.md doc-string line.

## Test coverage

`tests/e2e/file-viewer-e2e.test.ts` adds one case in the existing "rejects editablePaths targeting <never-editable>" cluster — same shape as the `node_modules/` test. The pre-existing file-viewer-e2e suite covers the read/write enforcement that the new prefix automatically inherits.
