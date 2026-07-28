# Side-effects review — deliver the corrected convergence criterion to installed agents

## What this changes

Adds `PostUpdateMigrator.migrateConvergeDesignClassCriterion`, registered immediately after the
sibling `migrateConformanceGateAutoInvoke`. It delivers the bundled `skills/spec-converge/SKILL.md`
to an already-installed agent when that copy lacks the corrected stop criterion.

## Why a second migration rather than fixing the first

The sibling migration already delivers this exact file. Its idempotency guard is keyed on
`'Standards-Conformance Gate auto-invocation'` — a marker introduced by an EARLIER change. Once an
agent's copy contains it, the migration returns early on every subsequent run, permanently. So it
delivers one change and then silently declines to deliver any other change to the same file.

Verified live on the authoring agent 2026-07-27: installed copy contains the sibling marker (1 hit)
and does NOT contain the corrected criterion (0 hits). PR #1673 therefore could not have reached it.

Fixing the general guard means keying delivery on the file's CONTENT rather than on one change's
marker. That is fleet-migration machinery — it updates every agent — and its risk floor is above
this change. Tracked as ACT-1420; deliberately not attempted here.

## Blast radius

Writes one file, on agents whose installed copy is stock and lacks the criterion. Bounded three ways,
all pre-existing conventions:

- **No installed file** → returns. A fresh install receives the bundled copy via `installBuiltinSkills`.
- **Customized file** (no `# /spec-converge` heading) → `skipped`, untouched. An operator who rewrote
  the skill keeps it.
- **Already carries the criterion** → returns. Idempotent.

The bundled-copy check (`if (next.includes(MARKER))`) means a build whose bundled file somehow lacks
the criterion writes nothing rather than downgrading an installed copy.

## What is NOT weakened

The sibling migration is untouched. No existing marker, guard, or ordering changes. The new call runs
after it, so an agent taking both in one update converges on the current bundled file either way —
the same sequencing note the sibling's own comment records.

## Verification

- 6 tests. `tsc --noEmit` exit 0.
- **Falsified against the bug, not the implementation:** re-keying this migration to the SIBLING
  marker — i.e. reproducing the defect — fails exactly the test written for that population
  (`1 failed | 5 passed`). Restored → 6 passed.
- **Falsified the customization guard:** removing it fails exactly the customization test
  (`1 failed | 5 passed`). Restored → 6 passed.
- The load-bearing test simulates an agent already carrying the sibling marker, which is the live
  state of the authoring agent and the state that produced this finding.

## Honest limit

This delivers ONE change. The structural defect — a per-change marker guard that becomes a permanent
no-op for later changes to the same file — is unchanged, and every future edit to this skill will
need its own migration for the same reason. Saying so here rather than letting a passing test imply
the class is closed.
