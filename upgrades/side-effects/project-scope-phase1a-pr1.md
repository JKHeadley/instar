# Side-Effects Review — project-scope Phase 1a PR 1 (Initiative type extension)

**Version / slug:** `project-scope-phase1a-pr1`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Extends `src/core/InitiativeTracker.ts` with the project-layer scaffolding
called for by `docs/specs/PROJECT-SCOPE-SPEC.md` Phase 1.1: optional `kind`,
`schemaVersion`, `version` (OCC counter), `parentProjectId`, child-only
fields (`pipelineStage`, `specPath`, `prNumber`, `mergeCommitOid`,
`ciCheckedAt`, `skip*`, `unskippedAt`, `driftCheck`), and project-only
fields (`rounds[]`, `sourceDocs`, `autoAdvance`, `telegramTopicId`,
`ownerMachineId`, `targetRepoPath`, `unacknowledgedAdvanceCount`,
`firstLaunchAckAt`, `lastAckedRoundIndex`, `awaitingReconciliation`,
`driftPromptTemplateVersion`). The `InitiativeStatus` union is extended
with `'paused' | 'halted' | 'awaiting-user'` — pre-project-scope records
continue to use the original four values. Three new error classes
(`OccVersionMismatchError`, `KindImmutableError`,
`InvalidParentProjectError`) cover the validation paths; an
`omitUndefinedReplacer` and `null`-rejection guards keep serialization
stable; a digest-cache-invalidator hook (`setDigestCacheInvalidator`)
fires after every successful mutation (no-op default until PR 3 wires it).
A one-time idempotent backfill in `loadFromDisk()` writes
`kind: 'task' + schemaVersion: 1` to legacy records; the parallel
`backfillKindAndSchema()` public method handles the TaskFlow-enabled
install path. Tests: `tests/unit/InitiativeTracker.project.test.ts` (26
new tests).

## Decision-point inventory

- `Initiative.kind` immutability — **add** — `update()` throws
  `KindImmutableError` if the caller tries to change `kind` away from its
  current value.
- `InitiativeUpdateInput.ifMatch` (OCC) — **add** — when provided, must
  equal current `version` or `OccVersionMismatchError` is thrown.
- `parentProjectId` bidirectional validator — **add** — `update()` rejects
  attaching a child to a parent that doesn't exist, isn't `kind: 'project'`,
  or doesn't list this child in any of its `rounds[].itemIds`.

No other decision points are touched. The new validators sit at the
persistence-layer edge and are structural — they accept/reject based on
type and reference integrity, not on conversational context.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new rejections for legitimate input shapes. The new fields are all
optional and additive — pre-existing callers that don't touch them are
not affected. The OCC check only fires when `ifMatch` is explicitly
provided, so backward-compatible callers continue to enjoy unconditional
writes. The `parentProjectId` validator only fires when the caller is
actually setting that field; clearing (set to null) skips validation.
The `kind` immutability check only rejects values that differ from the
current kind — passing the same kind value is accepted as a no-op.

---

## 2. Under-block

**What failure modes does this still miss?**

The OCC check is opt-in — old callers that don't provide `ifMatch` still
get last-write-wins semantics. This is intentional for backward
compatibility. The HTTP layer (PR 2) will enforce `If-Match` on the
project-kind `PATCH /projects/:id` endpoint specifically, where staleness
matters; legacy `/initiatives/*` keeps current semantics.

`parentProjectId` validation only fires inside `update()`. A caller
that sets `parentProjectId` at create time (via
`InitiativeCreateInput.parentProjectId`) bypasses the bidirectional
check. This is acceptable for Phase 1.1 because the round-runner and HTTP
layer (PR 2 / Phase 1.5) construct child initiatives and then attach them
in a separate update — the create-time field exists for migration/testing
shapes only. PR 2 may tighten this if the create flow uses it directly.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Type extension, OCC counter, `kind` immutability, and the
`parentProjectId` bidirectional check all live at the persistence layer,
which is correct because the tracker is the single source of truth for
both project and task initiative records. The validators compare to
fields already owned by the tracker (`rounds[].itemIds`, `kind`,
`version`), so reaching outside the tracker would only add coupling, not
clarity. The HTTP layer (PR 2) will map the three error classes to 4xx
responses; that's a thin translation, not a re-implementation.

The digest-cache-invalidator hook is a deliberate inversion of
dependency — the tracker doesn't know about the cache (which is owned by
PR 3's project-scope digest), it just signals "something changed." This
keeps the layering clean.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface in the
      conversational-content sense.

The three new validators (`KindImmutableError`,
`OccVersionMismatchError`, `InvalidParentProjectError`) are structural
schema/reference checks, not behavioral content gates. They fall under
the "When this principle does NOT apply" carve-out in
`docs/signal-vs-authority.md`: schema validators, type guards, and
referential-integrity checks at API edges are expected to be structural
and brittle by design — the right answer to "does this PATCH change an
immutable field?" is a deterministic yes/no, not an LLM judgment. The
spec calls this out explicitly in Phase 1.1.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The backfill in `loadFromDisk()` runs once at construction
  time. It does not shadow other checks because it operates on raw JSON
  before the cache is populated. The version-bump in `update()` runs
  after all field assignments and before the persistence call; it
  doesn't shadow any existing check.
- **Double-fire:** `setPhaseStatus()` and `update()` both bump `version`
  and both call the digest-cache invalidator. They're separate code
  paths called by different callers, never on the same logical write.
  `create()` and `remove()` likewise each invalidate exactly once per
  successful mutation. No double-fire.
- **Races:** The legacy-JSON path is single-process (one server, one
  tracker instance). The TaskFlow path inherits TaskFlow's existing
  concurrency model (controllerInstanceId + expectedRevision). PR 4 will
  add multi-machine reconciliation via `awaitingReconciliation`; the
  field is present in this PR but unused.
- **Feedback loops:** The digest cache invalidator hook is a one-way
  signal; no feedback path is created. The default no-op cannot loop.

The backfill rewrite happens inside `loadFromDisk()`. The constructor
runs `loadFromDisk()` synchronously before any caller can touch the
tracker, so there's no race between backfill and the first read. If
`fs.writeFileSync` fails, the cache still reflects the backfilled shape
(in-memory) and the next mutation will rewrite to disk — the legacy
file remains valid because `kind`/`schemaVersion` are optional.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** No. The new fields are all
  optional; agents that read `Initiative` records without expecting them
  see the same shape as before.
- **Other users of the install base:** No HTTP changes in this PR.
  Endpoints in `routes-initiatives.ts` continue to operate on the
  pre-existing field set. PR 2 will introduce `/projects` routes.
- **External systems:** None.
- **Persistent state:** Legacy `initiatives.json` files gain a one-time
  backfill: each record acquires `kind: 'task'` and `schemaVersion: 1`.
  This is forward-compatible — old code reading the file ignores the
  new fields. The TaskFlow path stores the same shape in `stateJson`.
  No schema migration is required for rollback (see § 7).
- **Timing / runtime conditions:** The backfill adds a small write at
  startup the first time a server boots with this code on a legacy
  install. Bounded by the number of legacy records; in practice
  microseconds.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** Revert the commit. All new fields are optional;
  rollback restores the original behavior.
- **Data migration:** None required. Records that received
  `kind: 'task' + schemaVersion: 1` from the backfill simply carry
  those extra fields after rollback — old code ignores them. The
  `version` field was added to in-memory records during this PR's
  lifetime; if it survives the rollback in the on-disk file, old code
  ignores it.
- **Agent state repair:** Not needed. The legacy JSON path tolerates
  unknown extra fields. TaskFlow's `stateJson` is opaque to TaskFlow
  itself; only the projector cares.
- **User visibility:** No user-visible regression during rollback. No
  HTTP responses or dashboard surfaces change in this PR.

Rollback is a single `git revert` with no follow-up.

---

## Conclusion

PR 1 of 3 for the project-scope Phase 1a build. All changes are
additive and structural: optional type fields, three error classes for
structural validators, a one-time idempotent backfill, and a no-op
digest-cache hook. The 26 new tests in
`tests/unit/InitiativeTracker.project.test.ts` cover backfill,
immutability, OCC, parent validation, serialization stability, the
extended status enum, and the invalidator hook. The full existing
InitiativeTracker suite (87 tests across 4 files) continues to pass.
Clear to ship.

---

## Second-pass review (if required)

Not required. No new decision points, no sentinel/gate/watchdog
touched, no externally-visible behavior change. Per the
`/instar-dev` rubric in `skills/instar-dev/SKILL.md` § Phase 5, a
second-pass review is reserved for changes that alter conversational
gates or recovery infrastructure.

---

## Evidence pointers

- `tests/unit/InitiativeTracker.project.test.ts` — 26 new tests, all
  passing.
- Full InitiativeTracker test sweep:
  `node node_modules/vitest/vitest.mjs run tests/unit/InitiativeTracker tests/unit/initiative-tracker-taskflow tests/unit/routes-initiatives` → 87 tests, all passing.
- `node_modules/typescript/bin/tsc --noEmit` → clean.
- Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` Phase 1.1.
