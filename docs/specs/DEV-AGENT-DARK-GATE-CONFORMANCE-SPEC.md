---
title: Dev-Agent Dark-Gate Conformance Guard
status: draft
tags: []
author: echo
created: 2026-06-09
relates_to:
  - PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md
  - STANDARDS-REGISTRY.md (standard_development_agent_dark_feature_gate)
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
| 1. Helper funnel + lint | Hand-rolled gate resolutions that drift from the canonical form; the gate being forked/typo'd | A feature that never resolves the gate at all |
| 2. ConfigDefaults marker check | A dev-gate-tagged config block that hardcodes `enabled: false/true` (the exact #1001 shape) | A dev-gated default with no marker comment |
| 3. Registry + both-sides wiring test | A *registered* dev-gated feature wired so it resolves dark on a dev agent | A feature not added to the registry |
| 4. Spec-intent cross-check (FeatureRolloutReconciler) | A spec that declares "ships dark / live on dev agents" whose feature is observed dark on this dev agent — **the only layer that catches forgot-entirely** | A feature whose spec never declares dark-ship intent |

## Slice 1 (this PR) — helper funnel + lint

### 1a. Canonical helper

Add `resolveDevAgentGate(explicitEnabled: boolean | undefined, config: { developmentAgent?: boolean }): boolean`
returning `explicitEnabled ?? !!config.developmentAgent`. One funnel, one place
to get it right, trivially unit-testable on both sides of the boundary.

Migrate the existing ~10 hand-rolled sites (enumerated by the lint below) to it.
This is a pure refactor — behavior identical — so it carries no runtime risk and
makes every dev-gate resolution greppable and uniform.

### 1b. `scripts/lint-dev-agent-dark-gate.js` (joins Repo Invariants)

Two assertions, both AST/text over `src/`:

1. **No hand-rolled gate.** Any occurrence of `?? !!<x>.developmentAgent` or
   `?? <x>.developmentAgent` **outside** `resolveDevAgentGate` is a violation
   (same shape as `lint-no-direct-destructive`: the funnel is the only legal
   path). Allowlist the helper's own definition.
2. **No hardcoded enabled under a dev-gate marker.** In
   `src/config/ConfigDefaults.ts`, any config block whose adjacent comment
   references the dev-gate standard (`developmentAgent` + `dark`/`gate`) MUST NOT
   set `enabled: false` or `enabled: true` — the convention is to omit it. This
   catches the #1001 shape directly.

The lint prints each violation as `file:line` with the offending text and the
fix, and exits non-zero. Wired into the `lint` npm script (the Repo Invariants
CI job) alongside the existing `lint-*` checks.

### 1c. Tests (all three tiers per Testing Integrity Standard)

- **Unit:** `resolveDevAgentGate` — dev agent + omitted → true; fleet + omitted →
  false; explicit false on dev agent → false; explicit true on fleet → true.
- **Lint self-test:** a fixture with a hand-rolled gate and a marker+`enabled:false`
  block → lint exits non-zero; the real `src/` tree → lint exits zero (proves it
  passes on the corrected codebase, the #1001 fix included).

## Slice 2 (follow-up) — dev-gated-feature registry + both-sides wiring test

An explicit `DEV_GATED_FEATURES` registry (config path + a construction probe per
feature). A test asserts each resolves **live** under a `developmentAgent: true`
config and **dark** under a fleet config — both sides of the decision boundary.
Adding a feature to the registry becomes the natural checklist step; the test
then guards it permanently. (Catches a *registered* feature wired wrong — Layer
3.)

## Slice 3 (follow-up) — spec-intent cross-check

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
  tracked so the limit is visible, not silent.

## Migration parity

The lint is a repo-internal CI check (`scripts/` + `package.json` lint script) —
it does not touch agent-installed files, so no `PostUpdateMigrator` entry is
required. The `resolveDevAgentGate` helper is internal source. If Slice 3 later
changes spec frontmatter conventions, that carries its own migration.
