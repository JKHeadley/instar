# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1a PR 1 — Initiative type extension

First of three PRs scaffolding the project-scope feature. This PR adds the
type-level surface that the round-runner, drift checker, and HTTP routes
will rely on in PR 2/3.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.1.

- `Initiative` gains optional project-layer fields: `kind` (`'task' |
  'project'`, immutable after creation, defaults to `'task'`),
  `schemaVersion`, `version` (OCC counter), `parentProjectId`, plus
  child-only fields (`pipelineStage`, `specPath`, `prNumber`,
  `mergeCommitOid`, `ciCheckedAt`, `skipped*`, `unskippedAt`,
  `driftCheck`) and project-only fields (`rounds[]`, `sourceDocs`,
  `autoAdvance`, `telegramTopicId`, `ownerMachineId`, `targetRepoPath`,
  `unacknowledgedAdvanceCount`, `firstLaunchAckAt`,
  `lastAckedRoundIndex`, `awaitingReconciliation`,
  `driftPromptTemplateVersion`). All optional → fully backward compatible.
- `InitiativeStatus` is extended with `'paused' | 'halted' |
  'awaiting-user'`. Existing four values unchanged.
- New error classes for structural validators:
  - `OccVersionMismatchError extends Error` (carries `currentVersion`)
  - `KindImmutableError extends Error`
  - `InvalidParentProjectError extends Error`
- `InitiativeTracker.update()` accepts `ifMatch?: number` for optimistic
  concurrency. When provided and stale, throws `OccVersionMismatchError`
  (the HTTP layer in PR 2 will translate this to 409 with body
  `{currentVersion}`). When omitted, last-write-wins — backward compatible.
- `update()` rejects mutations of `kind` (`KindImmutableError`).
- Setting `parentProjectId` requires a bidirectional match: the named
  parent must exist, be `kind: 'project'`, and list this child in one of
  its `rounds[].itemIds`. Clearing (`null`) skips validation.
- One-time idempotent backfill: `loadFromDisk()` writes
  `kind: 'task' + schemaVersion: 1` to legacy records on first load and
  rewrites the file. Second load is a byte-identical no-op. A parallel
  `backfillKindAndSchema()` public method handles TaskFlow-enabled installs.
- Serialization rule: `saveToDisk()` omits any field whose value is
  `undefined`. Round-trip stability asserted in tests.
- New `setDigestCacheInvalidator(fn)` hook fires after every successful
  mutation (`create`, `update`, `setPhaseStatus`, `remove`). Default is a
  no-op; PR 3 wires the real invalidator for the project-scope digest cache.

## What to Tell Your User

Your agent now has the type-level scaffolding for multi-spec projects.
This PR alone doesn't change anything visible — no new commands, no new
dashboard tab, no new behavior on existing endpoints. It lays the
foundation so PR 2 can expose the projects HTTP routes and PR 3 can wire
the project skill and the session-start digest.

The only thing you might notice is a very small one-time write at server
startup if your initiatives file predates this version — your agent will
quietly mark existing records as task-type and add a schema version marker
so they work correctly alongside new project records.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Optional project-layer fields on `Initiative` | additive; existing callers unaffected |
| OCC on initiative updates | pass `ifMatch: <currentVersion>` in `InitiativeUpdateInput` to enforce |
| `kind` immutability gate | automatic — `update()` rejects `kind` mutation |
| Bidirectional `parentProjectId` validation | automatic on `update({ parentProjectId })` |
| Backfill of legacy initiative records | automatic on server start; idempotent |
| Digest-cache invalidator hook | `tracker.setDigestCacheInvalidator(fn)` (PR 3 wires it) |

## Evidence

Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.1.

- `tests/unit/InitiativeTracker.project.test.ts` — 26 new tests covering
  backfill, kind immutability, parent validation, OCC, serialization
  round-trip, status enum extension, and the invalidator hook.
- Full InitiativeTracker test sweep (87 tests across 4 suites) passes
  unchanged.
- Side-effects review: `upgrades/side-effects/project-scope-phase1a-pr1.md`.
