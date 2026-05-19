---
title: "Tier-3 E2E lifecycle tests for Layer-3 parity primitives"
slug: "parity-primitives-tier3"
author: "echo"
status: "converged"
type: "amendment-spec"
eli16-overview: "parity-primitives-tier3.eli16.md"
review-convergence: "2026-05-19T17:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T17:00:00Z"
review-report: "docs/specs/reports/parity-primitives-tier3-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode hybrid C, with explicit 2026-05-19 ack: 'please enter autonomous mode and complete ALL of these')"
approved-date: "2026-05-19"
approval-note: "Audit-identified Testing Integrity Tier-3 gap from PRs #252-#254. Each primitive PR shipped Tier-1 unit tests but deferred Tier-3 E2E lifecycle tests. This closes the gap with one consolidated E2E suite covering registry+rules+sentinel+backfill end-to-end against a real fixture project."
lessons-engaged:
  - "P1 (Structure>Willpower): the test asserts the feature is actually alive end-to-end, not just that the modules import successfully."
  - "P4 (Testing Integrity, NON-NEGOTIABLE): direct fix for the Tier-3 gap. 12 new E2E lifecycle tests cover: registry alive at boot, rule contract surface, getParityRule resolution, alwaysOverwrite advertising, end-to-end skill render cycle, end-to-end hook render cycle with stamp comment, memory verify production-init, PostUpdateMigrator backfill end-to-end, idempotency, sentinel boot scan, sentinel start/stop idempotency. No mocks."
  - "P6 (Zero-Failure): added 12 tests + a small migrator-categorization tweak (recognize memory's 'refused to remediate' as a skip rather than error). Full unit suite remains green."
  - "P10 (Comprehensive-First): one consolidated E2E suite covers all four parity-layer concerns rather than four separate stub files."
  - "L6 (Side-effects review): seven-dimension review at upgrades/side-effects/feat-parity-primitives-tier3.md."
  - "L9 (ELI16 required): parity-primitives-tier3.eli16.md sibling."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
---

# Tier-3 E2E lifecycle tests for Layer-3 parity primitives

## What changed

One new E2E test file: `tests/e2e/parity-primitives-lifecycle.test.ts`. 12 tests covering production-init for the parity layer:

**Registry alive at boot (5 tests):**
1. Returns the expected Layer-3 rules (skill, hook, memory)
2. Each rule exposes the ParityRule contract surface (verify, listInstances, remediate, listOrphans, removeOrphans)
3. getParityRule resolves each registered primitive by name
4. hookParityRule advertises alwaysOverwrite=true per Migration Parity §4
5. skillParityRule does NOT set alwaysOverwrite (refuse-on-conflict per §5)

**Skill rule end-to-end (1 test):**
6. listInstances → verify → remediate produces the framework-native rendering at .claude/skills/<name>/SKILL.md

**Hook rule end-to-end (1 test):**
7. listInstances → remediate produces stamped framework-native rendering (x-instar-stamp audit comment)

**Memory rule end-to-end (1 test):**
8. verify on canonical AGENT/USER/MEMORY.md returns structured output (the rule is alive)

**PostUpdateMigrator backfill end-to-end (2 tests):**
9. migrateAsync iterates the registry and renders all canonical instances
10. Migration is idempotent on second run (marker prevents re-render)

**FrameworkParitySentinel boot lifecycle (2 tests):**
11. constructs + scans + stops without errors against the live registry
12. start + stop are idempotent in production-init

Plus one small categorization tweak in `src/core/PostUpdateMigrator.ts`: the parity-renderings backfill now recognizes `'refused to remediate'` (memory rule's documented refuse pattern) as a skip alongside `'user-edit-conflict'` (skill rule's). Both are documented §5 refuse patterns; both should be operator-action notes, not errors.

## Why this ships now

Audit-identified Tier-3 gap. The Testing Integrity Standard (NON-NEGOTIABLE) requires all three test tiers for every significant feature:

> Tier 3: E2E Lifecycle Tests — Production initialization path mirroring server.ts. Is the feature actually alive? Returns 200, not 503?

PRs #252-#254 shipped Tier-1 unit tests for each primitive but deferred Tier-3. The rules were verified in isolation; they were not verified to be alive when assembled into the production-init path. This PR closes the gap with one consolidated suite covering registry + rules + sentinel + backfill.

## Design

### One file, not four

The Testing Integrity Standard says four primitives need Tier-3 coverage. The natural reading would be four separate test files. The four primitives share the same registry, same boot path, same fixture setup, and the boundary "the parity layer is alive in production-init" is more meaningfully tested as one cohesive E2E suite than four siloed checks.

The consolidated file is structured with five describe() blocks (registry / skill / hook / memory / migrator / sentinel) so failures localize to the right concern. Each block reuses the same projectDir fixture via beforeEach/afterEach.

### Real fixture, no mocks

Per Testing Integrity Standard: "Tier 3 ... no mocks." The fixture is a real tmpdir-backed project with `.instar/config.json`, real canonical sources written with `fs.writeFile`, real `await rule.remediate()` calls that produce real `.claude/skills/...` and `.claude/hooks/...` files. The test reads back the rendered files to confirm content + stamp comments.

### Categorization tweak rationale

The memoryParityRule's remediate() throws `"refused to remediate ... — Memory artifacts are user/agent-authored and never auto-regenerated"`. The PostUpdateMigrator parity-renderings backfill previously categorized this as an error (only `user-edit-conflict` was recognized as a skip). Both are §5 refuse patterns; both should be operator-action notes. The tweak broadens the skip detection to `msg.includes('user-edit-conflict') || msg.includes('refused to remediate')`.

This is the right categorization layer: rules express their refusal in human-readable error messages; the migrator's job is to interpret those into result categories. Future rules with new refuse patterns can extend the regex without changing each rule's contract.

## What this PR does NOT do

- Does not add Tier-2 integration tests (HTTP route coverage). The parity rules don't have HTTP endpoints; the existing FrameworkParitySentinel has an EventEmitter surface tested in unit tests. Tier-2 is N/A for this primitive layer.
- Does not add tests for Agent and Tool primitives. Those parity rules don't exist yet (the registry has only skill, hook, memory). When they're added, the registry-iteration pattern picks them up — the test file's "registry alive at boot" assertion uses `expect.arrayContaining` so adding rules doesn't break the suite, and the for-loop over `listParityRules()` exercises any added rule's contract surface automatically.

## Bootstrap exception

The lessons-aware reviewer (PR #260) is structurally in /spec-converge SKILL.md but its content migration to deployed agents is the parity-renderings backfill (PR #262, this PR's base branch). Manual lessons-check applied transparently in the spec body.

### Manual lessons-aware check (vs `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`)

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — Tier-3 is the structural verification that the feature is alive, not docs request |
| P4 Testing Integrity §3 | ✓ Direct fix — closes the audit-identified Tier-3 gap |
| P6 Zero-Failure | ✓ Engaged — 12 new tests + 11 inherited from #262 pass; broader migrator categorization preserves all existing assertions |
| P10 Comprehensive-First | ✓ Engaged — single consolidated suite covers all four parity-layer concerns |
| L6 Side-effects review | ✓ Engaged — sibling file |
| L9 ELI16 required | ✓ Engaged — sibling ELI16 file |
| L10 Release notes in same PR | ✓ Engaged |

No contradictions found. Zero deferrals.

## Implementation slice for this PR

1. This spec + ELI16 + convergence report.
2. `tests/e2e/parity-primitives-lifecycle.test.ts` — 12 new tests.
3. `src/core/PostUpdateMigrator.ts` — categorization tweak (recognize 'refused to remediate' as skip).
4. `upgrades/NEXT.md` + `upgrades/side-effects/feat-parity-primitives-tier3.md`.
5. Package.json version bump.
