---
title: "Tiered-dev awareness + migration parity (Steps C + D of the tiered development process)"
date: 2026-06-01
author: echo
review-convergence: pending
approved: false
eli16-overview: tiered-dev-awareness-stepCD-spec.eli16.md
---

# Tiered-dev awareness + migration parity (Steps C + D)

> **Status:** Steps C + D (the final steps) of the **Tiered Development Process** project.
> Step A (#666, the tier classifier + Tier-1 path) and Step B (#669, codex cross-model
> review) are merged. This step makes the developing agent *aware* of the new tier system
> (Step C) and closes the migration-parity question (Step D).

## Goal

The tier system shipped in Step A is live in the gate (`scripts/instar-dev-precommit.js`)
and the trace writer (`write-trace.mjs`), but nothing the developing agent *reads* tells it
the system exists. Step A intentionally left the skill/docs awareness to this step. Step C
adds that awareness in the two surfaces the developing agent actually consults — the
`/instar-dev` skill and the constitution (`docs/STANDARDS-REGISTRY.md`). Step D records the
migration-parity analysis: enumerate every changed file, classify agent-installed vs
dev-repo-only, and conclude (with cited evidence) whether a `PostUpdateMigrator` migration
is required.

## The orchestrator's judgment (and why it holds)

The tiered-dev process is **DEV tooling** — *how an agent develops instar* — **not an
end-agent capability**. A customer's bot built on instar never runs the instar-dev commit
gate, so it never needs to know what a tier is. Therefore:

- Awareness goes in **`skills/instar-dev/SKILL.md`** (the developing agent's surface) and
  **`docs/STANDARDS-REGISTRY.md`** (the constitution the developing agent is governed by).
- Awareness does **NOT** go in the generated end-agent CLAUDE.md template
  (`src/scaffold/templates.ts` → `generateClaudeMd()`). The **Agent-Awareness Standard**
  governs *end-agent* capabilities; the tiered-dev gate is not one.

This judgment was confirmed against the code, not assumed (see Migration Parity below): the
tiered process is absent from `generateClaudeMd()` today, and `instar-dev` + `spec-converge`
are dev-repo-only (not in `package.json` `files[]`, not installed by
`installBuiltinSkills()`). This mirrors the precedent Step B already set — its side-effects
artifact concluded "no migration, `/spec-converge` is dev-only."

## Design

### Step C.1 — `skills/instar-dev/SKILL.md`

A focused **"Tiered development (tier signal → you decide → audited)"** section, inserted
before "What this skill explicitly does NOT do", covering exactly the Step-A mechanics:

- The gate computes + prints a **tier SIGNAL** (size + a risk floor from
  `scripts/lib/classify-tier.mjs`); the signal informs, never decides.
- The agent **DECLARES** the tier in the trace
  (`write-trace.mjs --tier <1|2|3> --tier-reasoning ...`,
  `--eli16-path`/`--side-effects-path` for Tier-1).
- The **Tier-1 path** (ELI16 + side-effects, no pre-approved converged spec) vs the
  **Tier-2+** full chain; no-declared-tier → Tier-2 (back-compatible).
- The **Tier-1 auto-merge** policy (Echo auto-merges a clean Tier-1 on green CI, operator
  spot-checks).
- The **decision audit** (`.instar/instar-dev-decisions.jsonl`, the loud `belowFloor`
  override notice).
- Cross-links **The Body and the Mind**.

Kept tight on purpose so the in-scope diff stays small and the change itself qualifies
Tier-1 under the very classifier it documents — a clean dogfood.

### Step C.2 — `docs/STANDARDS-REGISTRY.md`

A concise **Tiered Development** standard in the **Building — engineering discipline**
family, in the house format (Rule / Derives from / In practice / Earned from / Traces to the
goal / Applied through), framed as **deriving from The Body and the Mind**: structure (the
gate) *informs* the tier, the agent *decides*, the decision is *audited*; formality scales
with size **and** risk. (`docs/` is not in-scope for the commit gate.)

### Step D — Migration parity (see the dedicated section below)

## Migration parity

Every changed file in this step, classified:

| File | Class | Agent-installed? | Migration? |
|------|-------|------------------|------------|
| `skills/instar-dev/SKILL.md` | dev-repo-only skill | **No** | None |
| `docs/STANDARDS-REGISTRY.md` | dev/constitution doc | **No** | None |
| `docs/specs/tiered-dev-awareness-stepCD-spec.md` (+ `.eli16.md`) | spec | **No** | None |
| `upgrades/side-effects/tiered-dev-awareness-stepCD.md` | side-effects artifact | **No** | None |
| `upgrades/next/tiered-dev-awareness-stepCD.md` | release fragment | **No** | None |

**Evidence the in-scope skill is dev-repo-only (so no `PostUpdateMigrator` change):**

- **`package.json` `files[]`** ships only `.claude/skills/{setup-wizard,secret-setup,autonomous,build}`.
  The top-level `skills/` directory — where `skills/instar-dev/SKILL.md` lives — is **NOT**
  in `files[]`, so it is never published to npm and never reaches an end-agent home.
- **`installBuiltinSkills()`** (`src/commands/init.ts`) installs a fixed allowlist of
  end-agent skills (`evolve`, `learn`, `gaps`, `commit-action`, `feedback`,
  `triage-findings`, `reflect`, `coherence-audit`, `degradation-digest`,
  `state-integrity-check`, `memory-hygiene`, `guardian-pulse`,
  `session-continuity-check`, `git-sync`, `rollback-from-artifact`). `instar-dev` and
  `spec-converge` are **not** in that set — they are never installed into an agent home.
- **`generateClaudeMd()`** (`src/scaffold/templates.ts`) is untouched by this step, and the
  tiered-dev process is absent from it today (no `instar-dev` / `spec-converge` / tier-system
  mention). The **Agent-Awareness Standard** it serves governs *end-agent* capabilities; the
  instar-dev commit gate is not one, so it correctly stays out.

**Conclusion: no `PostUpdateMigrator` / `migrateClaudeMd` migration is needed.** The change
is dev-tooling, not an agent-installed file. Every file is either dev-repo-only (skill,
constitution doc, spec) or a release artifact. No agent-installed file is changed, so the
Migration-Parity Standard's update-path requirement is not triggered. (This matches Step B's
own migration-parity conclusion for `/spec-converge`.)

## Safety / blast radius

Documentation-only. No runtime code path changes: no `src/`, no gate, no classifier, no
trace writer. The SKILL.md section and the constitution standard *describe* the Step-A
mechanics already shipped; they add no behavior. The only structural surface touched is the
two dev-facing documents the developing agent reads. Rollback is a trivial revert of two
documentation edits plus the artifacts — there is no deployed-state to repair.

## Testing

No runtime behavior changes, so no new unit/integration/E2E tests. The verification bar is:

- `npx tsc --noEmit` exit 0 (no TS touched; confirms the worktree compiles).
- `npm run lint` green (the doc/url/destructive lints pass on the changed docs).
- The SKILL.md section accurately reflects the live gate mechanics (verified by reading
  `scripts/instar-dev-precommit.js` Steps 3.5 / 4.5 / 4.6 and `classify-tier.mjs`).

## Out of scope (a later step)

Nothing remains after Steps C + D — this is the final step of the project. Tier-1 auto-merge
*config/CI wiring* (as opposed to the *policy* this documents) and any future risk-floor
list growth are governed by the standing **Close the Loop** cadence on the
`belowFloor`/mis-classification audit, not a new project step.
