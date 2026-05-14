# Side-effects review — agentmd two-rename atomic save

## What changed

Implements INSTAR-JOBS-AS-AGENTMD spec §Design Principle 2 "Override = fork; race-safe two-rename commit":

> Save sequence is md-first, manifest-last:
>   1. Write `<file>.md.new` (staged body).
>   2. Write `<schedule>.json.new` (staged manifest).
>   3. rename(<file>.md.new → <file>.md)
>   4. rename(<schedule>.json.new → <schedule>.json)

New module `src/scheduler/AgentMdAtomicSave.ts` exports:

- `atomicSaveAgentMdJob({ mdPath, manifestPath, mdBody, manifest })` — performs the two-rename commit; returns `{ ok: true }` or a structured `AtomicSaveFailure` with the failure stage + partial-write state.
- `listStagedNewFiles(jobsRootDir)` — walks the tree for any `.md.new` or `.json.new` left over from a crashed save. Used by `reconcile()` (future PR) to surface "interrupted save" rows in the Issues card.
- `discardStagedFile(stagedPath)` — routes through `SafeFsExecutor.safeUnlinkSync` to delete an orphaned staged file.

No consumer wired yet — the Phase 4 Dashboard UI rewrite is the future consumer. Shipping the helper standalone so the spec's atomicity guarantee has a tested implementation independent of UI delivery.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. The save is pure-additive — it writes `.new` siblings before any rename, so a half-progressed save NEVER corrupts the existing files.
- **Under-block:** the helper does NOT acquire a file lock. Two concurrent saves to the same slug race; whichever finishes its rename pair last wins. The spec's design principle (§Design Principle 2) treats `manifestVersion` optimistic concurrency at the Dashboard layer as the lock — the helper trusts that the caller validated the version before invoking. This matches the spec.

### 2. Level-of-abstraction fit

Pure file-system helper. Zero scheduler/state dependencies. Single entry-point function with a structured result type. The `listStagedNewFiles` + `discardStagedFile` companions are sized for the future `reconcile()` consumer.

### 3. Signal-vs-authority compliance

The helper is the AUTHORITY for "what's on disk after a save." The caller (Dashboard, CLI edit command) provides the signal "this job should now have this body+manifest." The helper performs the canonical commit sequence and surfaces stage-level failures for caller recovery.

### 4. Interactions

- **Phase 1a JobLoader** — handles the rename-B-failed state (new body + old manifest) gracefully. The loader reads the body via `loadAgentMdBody` and the schedule from the manifest; if they disagree on the body hash, Phase 1c-runtime's `lockTrust` machinery flags it.
- **Phase 4 Dashboard UI rewrite (future)** — will consume `atomicSaveAgentMdJob` for every job-edit save.
- **Phase 5 PostUpdateMigrator** — does NOT consume this helper directly; the auto-migrate path writes manifests via `jobsMigrate` which has its own atomicity semantics (backup-first).
- **reconcile() boot lifecycle (future PR)** — will consume `listStagedNewFiles` to surface orphaned staged files as Issues-card rows.

### 5. Rollback cost

Trivial. Single module file + single test file. No callers yet (intentionally), so removing the helper has zero behavioral impact.

## Test coverage

`tests/unit/scheduler/AgentMdAtomicSave.test.ts` — 8 cases:

1. Happy path: both files written, no .new files left
2. rename B fails: new md committed, manifest.new staged, old manifest preserved
3. rename A fails: both .new files staged, no committed change
4. stage-md (write of .md.new) fails: no .new files produced
5. Idempotent re-save: re-running with same input is a no-op for end state
6. `listStagedNewFiles` walks nested directories
7. `discardStagedFile` removes via SafeFsExecutor
8. Recovery: after rename-B-failed state, a fresh successful save heals

All 8 pass locally. Lint + type-check pass.

## What is NOT in this PR

- Caller wiring (Phase 4 Dashboard UI rewrite owns this).
- `reconcile()` boot-time discovery of staged orphans (own PR, task #26).
- `manifestVersion` optimistic-concurrency enforcement (caller-side; out of scope here).
