# Convergence Report — Apprenticeship Step 1: Program Scaffold

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's installed codex CLI (`gpt-5.5`, `status:ok`)
in rounds 2 and 3 — the clean RAN state. The internal Claude panel (security+adversarial,
integration, lessons-aware) ran round 1; the constitutional gate was LLM-degraded (fail-open, noted).

## ELI10 Overview

Step 1 builds the small, sturdy frame the whole apprenticeship hangs on: every onboarding becomes a
tracked "instance" (overseer / mentor / mentee + framework + status), and two rules are baked into
code — you can't *start* a new onboarding until the previous one has a valid retro-harvest (the
retro-gate), and you can't *finish* one until its lessons are actually captured (the doc-gate). The
only code is one new module + a small set of auth'd routes + the role schema; the gates are pure and
unit-tested.

The review changed the design materially. Round 1 (code-grounded) caught that the headline
integration claim — a TypeScript `src/` module importing the Step-0 `scripts/*.mjs` validator —
**cannot compile** under instar's `tsconfig`; corrected by relocating the validator's pure logic to
`src/core/retroHarvestValidator.ts` (source of truth) with the `.mjs` re-exporting from `dist/`. It
also caught that the gates were "advisory" and bypassable (you could PATCH the status or the
required-artifact flags directly), that `harvestRef` was an arbitrary-file-read primitive, and that
the spec was missing the `parent-principle` frontmatter its own ship-gate now requires. Rounds 2-3
(codex) tightened the rest: real CAS not just atomic-rename, acceptance metadata for partial harvests,
an explicit role→path mapping, instance-scoped ledger checks, and validated need-tracking.

The tradeoff: Step 1 is deliberately minimal (bootstrap) — it ships the registry + two gates + the
role model + a typed no-op overseer interface, and tracks the deferred needs (the differential
channel, the non-Claude ship path, the warm mentor session) to their steps rather than building them.

## Original vs Converged

- **Originally:** `src/core` imported the `scripts/*.mjs` validator. **After:** the validator's pure
  logic lives in `src/core/retroHarvestValidator.ts`; the `.mjs` re-exports it (the real precedent).
- **Originally:** gates returned `{allow}` advisorily. **After:** the **state-mutating transition**
  consults the gate and refuses on `allow:false`; `can-start`/`can-complete` are read-only previews.
- **Originally:** `requiredArtifacts` booleans could be PATCH'd true. **After:** the gate re-derives
  truth from live deps (harvest validates, instance-scoped ledger, audit present); flags are immutable.
- **Originally:** the gate read a stored `harvestRef`. **After:** it recomputes the canonical confined
  path from normalized `harvestFrom`/`harvestTo`.
- **Originally:** need-001/004/005 "noted as a dep" in prose. **After:** a tracked `programNeeds`
  field with target step + a validated `honoredBy` reference.
- **Added:** `parent-principle`, the Signal-vs-Authority framing + decision audit, `migrateClaudeMd()`,
  a status transition table (`complete` terminal), charset clamps, auth-negative tests.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | security+adversarial, integration, lessons-aware | 3 HIGH + ~8 MED | Validator relocation, transition-enforcing gates, live-derived truth, path confinement, parent-principle, Signal-vs-Authority, tracked needs, wiring/migration/atomicity/status-table fixes |
| 2 | cross-model codex (gpt-5.5) | 5 minor | acceptance metadata, real CAS, role mapping, honoredBy validation, ledger scoping |
| 3 | cross-model codex (gpt-5.5) | 4 polish | single-process note, instance-scoped ledger, role table, acceptance provenance |
| — | (converged) | trajectory HIGH→minor→polish | none material remaining |

## Convergence verdict

Converged after round 3's polish was applied. The finding severity decreases monotonically (load-
bearing integration HIGH caught before any code → minor → polish), and the final round produced only
diminishing-returns refinements, all incorporated. Cross-model posture: clean `codex-cli:gpt-5.5`.
Justin pre-approved the build for this overnight run; he reviews the spec after the fact.
