---
title: Dev-Agent Dark-Gate Conformance Guard
status: active
parent-principle: "Structure beats Willpower"
tags: [side-effects]
author: echo
created: 2026-06-09
relates_to:
  - PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md
  - STANDARDS-REGISTRY.md (standard_development_agent_dark_feature_gate)
review-convergence: "2026-06-10T00:08:49.703Z"
review-iterations: 2
review-completed-at: "2026-06-10T00:08:49.703Z"
review-report: "docs/specs/reports/dev-agent-dark-gate-conformance-convergence.md"
approved: true
approved-by: "Justin (topic 21624)"
approved-at: "2026-06-10T00:22:34Z"
---

# Dev-Agent Dark-Gate Conformance Guard

## Why this exists (grounded requirement)

Justin, 2026-06-09, topic 21624 — after catching that PR #1001 (the
GrowthMilestoneAnalyst) shipped dark for *everyone, Echo included*:

> "have we made changes to prevent oversights like this happening again in the
> future"

The bug: the GrowthMilestoneAnalyst was meant to follow the
`standard_development_agent_dark_feature_gate` convention — **dark for the fleet,
live on development agents** (the dogfooding ground). Instead its config default
hardcoded `enabled: false` and its construction site only ran when `enabled`
was literally `true`. Net effect: dark on dev agents too, contradicting our own
standard. It was caught only by operator review — there was no structural guard.

Per **Structure > Willpower**: a behavior that matters must be enforced in code,
not left to an agent (or a reviewer) remembering. We have a whole family of lint
checks that fail CI for exactly this class of mistake
(`lint-no-unfunneled-topic-creation`, `lint-no-direct-destructive`,
`lint-no-direct-llm-http`, …). There simply isn't one for the dark-gate
standard. This spec adds it.

## The standard being enforced

A *development-agent dark feature* resolves its enabled state as:

```ts
const enabled = cfg?.enabled ?? !!config.developmentAgent;
```

Convention (already documented in `src/core/types.ts` and
`src/config/ConfigDefaults.ts`):

- The config default **OMITS** `enabled` so the gate decides at runtime.
- On a `developmentAgent: true` agent the feature runs **live**.
- On the fleet it stays **dark** until explicitly flipped on.
- An explicit `enabled` in config **always wins** (force-dark a dev agent with
  `false`, fleet-flip with `true`).

The bug is any deviation that makes a feature intended for this gate resolve
**dark on a dev agent**.

## What is detectable (and what is honestly not)

No purely-mechanical check can catch *"a developer intended dev-gating but
forgot the gate entirely"* — intent isn't in the syntax. So the guard is
**layered**, each layer catching a strictly larger class, with the honest limit
named:

| Layer | Catches | Misses |
|-------|---------|--------|
| 1. Helper funnel + lint | Hand-rolled gate resolutions in the realistic spellings (`!!`, `Boolean(...)`, bracket access) outside the funnel | A feature that never resolves the gate at all; an arbitrary alias/wrapper (`const dev = config.developmentAgent`) — A bans the spellings, not every possible expression |
| 2. ConfigDefaults marker check | A gate-*marked* config block that hardcodes `enabled: false` (bare or quoted key) — brace-matched, so comment length doesn't matter (the literal #1001 shape *when the block carries a dev-gate marker*) | A dev-gated default with **no** marker comment (the literal #1001 bug had none); a *marked* block whose `enabled` is a non-literal expression (`… ?? false`) — both fall to Layer 3/4 |
| 3. Registry + both-sides wiring test | A *registered* dev-gated feature wired so it resolves dark on a dev agent | A feature not added to the registry |
| 4. Spec-intent cross-check (FeatureRolloutReconciler) | A spec that declares "ships dark / live on dev agents" whose feature is observed dark on this dev agent — **the only layer that catches forgot-entirely** | A feature whose spec never declares dark-ship intent |

## Slice 1 (this PR) — helper funnel + lint

### 1a. Canonical helper

Add `resolveDevAgentGate(explicitEnabled: boolean | undefined, config: { developmentAgent?: boolean }): boolean`
returning `explicitEnabled ?? !!config.developmentAgent`. One funnel, one place
to get it right, trivially unit-testable on both sides of the boundary.

Migrate the existing **11** hand-rolled sites (enumerated by the lint) to it —
this includes `routes.ts`'s `?? Boolean(ctx.config.developmentAgent)` form, which
the first pass missed (an `!!`-only grep) and which the convergence review's
integration reviewer surfaced. This is a pure refactor — behavior identical (each
site returns the same boolean) — so it carries no runtime risk and makes every
dev-gate resolution greppable and uniform.

### 1b. `scripts/lint-dev-agent-dark-gate.js` (joins Repo Invariants)

Two assertions, both line/regex text scans over `src/`:

1. **No hand-rolled gate.** Any `?? [!! | Boolean(]<x>.developmentAgent` —
   including bracket access `['developmentAgent']` — **outside**
   `resolveDevAgentGate` is a violation. The funnel is the only sanctioned path
   for the *realistic spellings*; the lint cannot catch an arbitrary alias or a
   wrapper helper (`const dev = config.developmentAgent; … ?? dev`) — that is the
   Layer-1 "misses" limit, named honestly rather than papered over. Allowlist the
   helper's own definition.
2. **No hardcoded `enabled: false` under a dev-gate marker.** In any
   `ConfigDefaults.ts`, a config block introduced by a comment referencing the
   dev-gate convention (`developmentAgent` + `dark`/`gate`) must not hardcode
   `enabled: false` (bare or quoted key). The scan is **brace-matched on the
   block** — NOT a fixed line window — because the convergence review found that a
   fixed 8-line window let the *real* growthAnalyst block (a ~10-line marker
   comment) slip a regressed `enabled: false` through: the guard silently
   no-op'd on its own origin case. `enabled: true` is NOT flagged (it is the
   allowed deliberate fleet-flip); comment prose is skipped (code lines only).
   This catches the #1001 shape **when the block is gate-marked**; a markerless
   dev-gated default is the Layer-2 miss above.

The lint prints each violation as `file:line` with the offending text and the
fix, and exits non-zero. Wired into the `lint` npm script (run by the Repo
Invariants posture in CI and by the pre-commit hook) alongside the existing
`lint-*` checks.

### 1c. Tests (per Testing Integrity Standard)

- **Unit:** `resolveDevAgentGate` — dev agent + omitted → true; fleet + omitted →
  false; explicit false on dev agent → false; explicit true on fleet → true;
  undefined config → false.
- **Lint self-test:** fixtures proving both assertions fire AND both stay quiet on
  the legitimate cases — a hand-rolled `!!` gate and a `Boolean(...)` gate → A
  fires; a marker + `enabled: false` block, **including a ≥10-line marker comment
  (the growthAnalyst-window regression)** → B fires; `enabled: true` and
  comment-prose mentions of `enabled: true` → B stays quiet; the real `src/` tree
  → lint exits zero (it passes on the corrected codebase, with the #1001 fix and
  all 11 migrated sites — green because the gate is structurally absent, not
  because the scan misses the block).

## Slice 2 (follow-up) — dev-gated-feature registry + both-sides wiring test
<!-- tracked: CMT-1253 -->

An explicit `DEV_GATED_FEATURES` registry (config path + a construction probe per
feature). A test asserts each resolves **live** under a `developmentAgent: true`
config and **dark** under a fleet config — both sides of the decision boundary.
Adding a feature to the registry becomes the natural checklist step; the test
then guards it permanently. (Catches a *registered* feature wired wrong — Layer
3.)

## Slice 3 (follow-up) — spec-intent cross-check
<!-- tracked: CMT-1253 -->

Extend `FeatureRolloutReconciler` to read declared dark-ship intent from spec
frontmatter and cross-check it against observed dev-agent resolution. A spec that
says "ships dark / live on dev agents" whose feature is observed dark on *this*
dev agent surfaces as a growth-analyst finding ("declared dark-ship but not live
on this dev agent — wired wrong?"). This is the only layer that catches
forgot-the-gate-entirely, because it keys on declared intent, not code shape —
and it routes through the very analyst #1001 introduced. (Layer 4.)

## Non-goals

- Not changing the gate's runtime semantics — only enforcing them structurally.
- Not auto-fixing violations — the lint reports; the developer fixes (same
  contract as the other `lint-*` checks).
- Slice 1 does not attempt Layer 3/4 coverage; those are explicitly deferred and
  tracked so the limit is visible, not silent. <!-- tracked: CMT-1253 -->

## Migration parity

The lint is a repo-internal CI check (`scripts/` + `package.json` lint script) —
it does not touch agent-installed files, so no `PostUpdateMigrator` entry is
required. The `resolveDevAgentGate` helper is internal source. If Slice 3 later
changes spec frontmatter conventions, that carries its own migration.
