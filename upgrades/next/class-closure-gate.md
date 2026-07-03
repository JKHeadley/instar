# Class-Closure Gate — registry + report-only recurrence lint (increment 1, ships dark)

<!-- bump: minor -->

## What Changed

Increment 1 of the Class-Closure Gate (`docs/specs/class-closure-gate.md`, converged +
approved). This is the mechanical arm of the constitutional principle **"Distrust Temporary
Success: A Recurrence Is a Root Cause"** — until now nothing at fix-time asked *"what CLASS
of defect is this, and what structural change makes the whole class unrepresentable?"* (the
question only ever fired because the operator asked it).

Increment 1 ships **CI tooling only — no runtime gates**:

- A **defect-class registry** (`docs/defect-classes.json`) seeded with the four measured
  classes, each carrying real semantics (includes/excludes/severity/closure-standard).
- A pure count/threshold **library** (`src/core/DefectClassRegistry.ts`) that derives each
  class's recurrence count from committed instar-dev decision-audit declarations, deduped by
  PR number, and computes deterministic escalation-threshold crossings (critical-at-1;
  normal: ≥3-across-2-components, ≥2+open-gap, or ≥5-in-one-component; seeded-closed
  suppresses historical backfill).
- A self-contained **guard grader** (`scripts/lib/class-closure-grader.mjs`, mirroring
  `StandardsEnforcementAuditor` with a pinned parity test) that downgrades a `closure:guard`
  declaration to `gap` when the cited guard does not resolve to a live enforcing guard (G3:
  a dark/spec-only artifact guards nothing).
- A **report-only PR-gate lint** (`scripts/class-closure-lint.mjs`) + CI workflow
  (`.github/workflows/class-closure-gate.yml`, check name `class-closure`) that validates the
  class-declaration field-set on fixes touching agent-authored artifacts and LOGS threshold
  crossings.
- An author declaration helper (`scripts/class-closure-declare.mjs`) and the side-effects
  template's mirrored declaration section.

Config-gated behind `prGate.classClosure = {enabled, dryRun, escalatorDrafting}` (defaults
off/dry-run) and repo-gated (no-op on installs without `docs/defect-classes.json`). The
escalator's LLM drafting arm, the proposals writer, the attention-item producer, the runtime
read route, and the consolidated axis-requirements ratchet are the spec's OWN dark
**increment 3** — deliberately not in this increment.

## Evidence

- `npx vitest run tests/unit/class-closure-registry.test.ts tests/unit/class-closure-grader.test.ts tests/unit/class-closure-grader-parity.test.ts tests/unit/class-closure-registry-parity.test.ts tests/integration/class-closure-lint.test.ts`
  → **5 files, 55 tests, 0 failures** (all four escalation arms + seeded-closed suppression +
  newEvidence gate; guard-upheld vs 3 downgrade paths; report-only-exits-0 vs
  enforcing-exits-nonzero for both hard-violation types; both mirror-parity suites).
- `npx tsc --noEmit` → exit 0, zero errors.
- Report-only guarantee is structural: `scripts/class-closure-lint.mjs` computes
  `enforcing = config.enabled && !config.dryRun` and returns a nonzero exit ONLY when
  `enforcing && hardViolations.length > 0` — so under the shipped defaults (disabled +
  dry-run) it always exits 0 and cannot fail a PR.
- Side-effects review: `upgrades/side-effects/class-closure-gate.md` (8 questions + Q7
  multi-machine posture + signal-vs-authority), second-pass reviewed.

## What to Tell Your User

Nothing changes for you right now — this ships **dark and report-only**, and it is
maintainer-only CI machinery (a no-op on your install unless you develop instar itself). It
is the first brick of a system that will, later and only after an operator sign-off, notice
when the same *kind* of bug keeps recurring and propose a structural fix for the whole class
rather than patching instances one at a time. No behavior, message, or command changes today.

## Summary of New Capabilities

None active for end users in this increment — everything ships disabled/dry-run and
repo-gated. (For instar maintainers: a report-only CI lint that logs missing/invalid
defect-class declarations and deterministic class-recurrence threshold crossings, plus the
class registry and grading libraries it rides on.)
