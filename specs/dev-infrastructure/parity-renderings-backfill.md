---
title: "PostUpdateMigrator parity-renderings backfill (Migration Parity §5)"
slug: "parity-renderings-backfill"
author: "echo"
status: "converged"
type: "amendment-spec"
eli16-overview: "parity-renderings-backfill.eli16.md"
review-convergence: "2026-05-19T16:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T16:30:00Z"
review-report: "docs/specs/reports/parity-renderings-backfill-convergence.md"
review-deviation: "Tactical amendment closing the Migration Parity §5 backfill gap that PRs #252-#254 deferred. Manual lessons-aware check in spec body; the lessons-aware reviewer (PR #260) is structurally in /spec-converge but its content migration to deployed agents lands as a sibling concern (the new backfill itself can render that update once it ships)."
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode hybrid C, with explicit 2026-05-19 ack: 'please enter autonomous mode and complete ALL of these')"
approved-date: "2026-05-19"
approval-note: "Audit-identified backfill gap. The recently-shipped primitive PRs (#252-#254) ship the canonical sources + the parity rules, but neither the PostUpdateMigrator nor the sentinel boot wiring fires the renderings for existing agents on update. This is the structural backfill."
lessons-engaged:
  - "P1 (Structure>Willpower): backfill runs in code on every update, not via a docs request for operators to manually re-render."
  - "P3 (Migration Parity §5): direct fix — existing agents now receive the canonical→framework renderings on update."
  - "P4 (Testing Integrity): 11 new unit tests covering registry iteration, framework filtering, conflict capture, idempotency, error handling, marker recording, empty-canonical path, continue-past-failure, and the migrateAsync wrapping contract."
  - "P10 (Comprehensive-First): full backfill ships in v0.1 covering all three currently-registered rules. Agent and Tool parity rules will be covered automatically when they're added to the registry (registry-iteration pattern)."
  - "L6 (Side-effects review): seven-dimension review at upgrades/side-effects/feat-parity-renderings-backfill.md."
  - "L9 (ELI16 required): parity-renderings-backfill.eli16.md sibling."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
  - "B28 (Spec-converge pre-auth circular): this amendment is the audit's structural fix #3 — Migration Parity §5 wasn't built when the primitive PRs shipped."
---

# PostUpdateMigrator parity-renderings backfill

## What changed

Two coordinated changes in `src/core/PostUpdateMigrator.ts`:

1. **New `migrateParityRenderings(result)` step** — iterates the parity rule registry (`listParityRules()`), and for every rule × every canonical instance × every enabled framework, calls `rule.remediate(projectDir, instance, framework)`. This causes every canonical source to be re-rendered into the framework-native shape. Idempotent via `_instar_migrations` marker. Errors during remediation are categorized: `user-edit-conflict` is captured as a skip (operator-action required), all other errors land in `result.errors` for visibility.

2. **New `migrateAsync()` companion** to `migrate()` — `migrate()` keeps its synchronous signature (callers expecting `MigrationResult` continue to work), and `migrateAsync()` wraps it plus runs the async parity-renderings backfill. The three production callers in `src/cli.ts`, `src/core/UpdateChecker.ts`, and `src/commands/server.ts` are all in async contexts and are updated to use `migrateAsync()`.

## Why this ships now

Audit finding #3 from PR #252-#254. Each of those PRs shipped a parity rule + canonical source format but deferred the PostUpdateMigrator entry that would render the canonical to the framework-native shape for existing agents. The premise was that the FrameworkParitySentinel (PR #255) would handle rendering on its scan cadence — but the sentinel is not yet wired to boot. So deployed agents updating from v1.0.0 to v1.0.10 had:

- `skills/<name>/SKILL.md` canonical sources from #252 — but no `.claude/skills/<name>/SKILL.md` rendered
- `.instar/hooks/canonical/<event>/<name>.sh` canonical hooks from #253 — but no `.claude/hooks/<event>/<name>.sh` rendered
- Memory canonical sources from #254 — but no rendering for memory either

The promise of canonical-to-framework-native parity was theoretical, not observed. This PR closes the gap.

## Design

### Per-rule policy preservation

The backfill calls `rule.remediate()` and lets each rule's own policy govern:

- **`hookParityRule` (alwaysOverwrite=true per §4)** — built-in canonical hooks always re-render. User-edited renderings are clobbered (the audit event `parity:user-edit-overwritten` records the clobber on the sentinel scan path; on the migrator path, the clobber happens silently in the migration result's `upgraded` list). Per Migration Parity §4 the always-overwrite policy is the explicit decision.

- **`skillParityRule` (refuse-on-conflict per §5)** — when verify() detects a user-edit-conflict on the rendered skill, remediate() throws. The backfill catches the throw, recognizes the user-edit-conflict shape, and records a skip in `result.skipped`. Operators see the skip in the update output and can resolve via `/spec-converge` or manually.

- **`memoryParityRule` (refuse-on-conflict per §5)** — same shape as skill. Memory canonical content is operator-managed; the system never clobbers.

### migrate() vs migrateAsync()

The pre-existing `migrate()` returns synchronously and is used by three production call sites. Adding the async parity-renderings backfill required either:

- Changing migrate() to async (breaking change for sync callers, of which there are none in production but tests exist)
- Adding a new `migrateAsync()` companion (additive, no breaking change)

The companion approach was chosen. `migrate()` continues to handle the existing 18 synchronous migration steps; `migrateAsync()` runs `migrate()` then awaits the parity-renderings backfill. The three production call sites are updated to `await migrator.migrateAsync()` since they're all in async contexts already.

The `_instar_migrations` marker dedupes across sync/async calls: a sync `migrate()` call doesn't run the parity backfill, but the marker isn't set either, so the next `migrateAsync()` call picks up the backfill. Existing test paths that use `migrate()` synchronously continue to work.

### Idempotency + error semantics

- **Migration marker** in `config._instar_migrations` prevents re-running the backfill across `instar update` cycles.
- **Per-rule fail-closed but continue-past** — if `listInstances()` throws for one rule (e.g., disk corruption), the error lands in `result.errors` but the migration continues to the next rule. Sibling primitives are not held hostage by one rule's failure.
- **User-edit-conflict is a skip, not an error** — refuse-on-conflict is the documented v0.1 behavior for refuse-on-conflict rules (per §5). The operator's job is to resolve via `/spec-converge`; the migrator's job is to record the skip and move on.

## What this PR does NOT do

- Does not change the parity rule policies. Hooks stay alwaysOverwrite; skills + memory stay refuse-on-conflict.
- Does not wire FrameworkParitySentinel to server.ts boot. That's a separate concern; the backfill handles the catch-up rendering, and the sentinel handles cadence-based drift detection going forward.
- Does not modify the AdaptiveTrust gating on mirror-trust rules (that landed in PR #261). The backfill's remediate calls bypass the sentinel's trust gate because they originate from PostUpdateMigrator, not from the sentinel scan path. This is intentional: backfill is "render the canonical sources for existing agents on update" — that's the user-intent of running `instar update`. Cadence-based remediation continues to go through the trust gate via the sentinel.

## Bootstrap exception

Lessons-aware reviewer (PR #260) is structurally in /spec-converge SKILL.md but its content migration to deployed agents has NOT yet been built — the backfill that this PR adds will actually be the mechanism that renders the updated SKILL.md content for deployed agents on update. So this PR is the bootstrap for /spec-converge's own update propagation. Manual lessons-check applied transparently in the spec body against the canonical principles index.

### Manual lessons-aware check (vs `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`)

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — backfill in code, not docs request |
| P2 Signal vs Authority | ✓ Engaged — rule.remediate is the authority; rule.verify is the signal |
| P3 Migration Parity §5 | ✓ Direct fix for the audit-identified backfill gap |
| P4 Testing Integrity | ✓ Engaged — 11 unit tests covering registry iteration, framework filtering, error categorization, idempotency, marker recording, empty-canonical, continue-past-failure, and migrateAsync contract |
| P5 Agent Awareness | N/A — internal update path; no new agent-facing surface |
| P6 Zero-Failure | ✓ Engaged — full unit suite green; my 11 new tests + all existing PostUpdateMigrator tests pass |
| P7 LLM-Supervised Execution | N/A — deterministic gating |
| P8 UX & Agent Agency | N/A — no user-facing surface |
| P9 Intent Engineering | N/A |
| P10 Comprehensive-First | ✓ Engaged — backfill ships in v0.1 covering all three currently-registered rules; Agent and Tool parity rules will pick up automatically when their rules land via registry-iteration pattern |
| L1 AGENT.md bloat | N/A |
| L6 Side-effects review | ✓ Engaged — `upgrades/side-effects/feat-parity-renderings-backfill.md` |
| L9 ELI16 required | ✓ Engaged — sibling ELI16 file |
| L10 Release notes in same PR | ✓ Engaged |
| B28 Spec-converge pre-auth circular | ✓ Engaged — audit-driven fix #3 |

No contradictions found. Zero deferrals (Agent/Tool parity rules are NOT deferrals of THIS PR — they're upstream gaps that this PR's registry-iteration pattern will pick up automatically when they're added).

## Implementation slice for this PR

1. This spec + ELI16 + convergence report.
2. `src/core/PostUpdateMigrator.ts` — new `migrateParityRenderings()` + `migrateAsync()` wrapper.
3. `src/cli.ts`, `src/core/UpdateChecker.ts`, `src/commands/server.ts` — updated to `await migrateAsync()`.
4. `tests/unit/PostUpdateMigrator-parityRenderings.test.ts` — 11 new tests.
5. `upgrades/NEXT.md` + `upgrades/side-effects/feat-parity-renderings-backfill.md`.
6. Package.json version bump.
