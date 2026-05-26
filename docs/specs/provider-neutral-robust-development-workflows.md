---
slug: provider-neutral-robust-development-workflows
title: Provider-neutral robust development workflows
author: codey
project: instar
status: approved
review-convergence: "2026-05-26T16:24:56Z"
review-iterations: 4
review-note: "Converged through iterative Codey draft + Echo live-repo critique + Justin approval on 2026-05-26. This was a bootstrapping Codex parity spec; full automated /spec-converge is the capability this work makes portable."
review-report: "docs/specs/reports/provider-neutral-robust-development-workflows-convergence.md"
approved: true
approved-by: justin
eli16-overview: provider-neutral-robust-development-workflows.eli16.md
---

# Provider-Neutral Robust Development Workflows

## Problem Statement

Instar has a mature development discipline around Echo's work on Instar itself:
worktree hygiene, spec-first planning, side-effects review, trace/evidence
artifacts, semantic review, and gate-backed verification. That discipline has
proven useful, but parts of it are still represented as Echo-local prose or
Claude-shaped skills rather than provider-neutral workflow contracts.

This creates two problems:

- A Codex-based Instar agent can be subject to the same structural git gates,
  but may not discover the phase-ordered guidance needed to satisfy them.
- Practices that should benefit all serious project work remain coupled to
  Instar-only development, even when the underlying discipline generalizes.

## Goal

Create a two-layer workflow model:

1. **Generic robust project-development workflow** for substantial project work.
2. **Instar evolution overlay** for changes to Instar itself.

The model is context-gated, not Echo-gated. Any qualified Instar agent should be
able to use robust development guidance. When the project is Instar itself, the
Instar overlay adds the stricter repo-local gates and artifacts.

## Non-Goals

- Do not weaken the existing Instar pre-commit gate.
- Do not reimplement the existing `write-trace.mjs` trace emitter.
- Do not make Instar-specific release mechanics mandatory for every project.
- Do not make agent identity the safety authority.
- Do not force a heavyweight process for tiny, low-risk edits.

## Layer 1: Generic Robust Project Development

Layer 1 should be available to any project when work is substantial or risky.

Robust mode is appropriate when work touches source behavior, persistence,
external services, shared runtime behavior, security/privacy surfaces, release
mechanics, or multi-file architecture. Small documentation edits, one-file local
script changes with no behavior impact, and quick lookups can stay lightweight.

The generic workflow has these phases:

1. **Scope and context.** Identify the project, branch, topic binding, and risk.
2. **Isolation strategy.** Prefer a dedicated worktree for substantial changes,
   keep shared checkouts clean, and explain when a worktree is not used.
3. **Provider placement constraints.** Some harnesses need worktrees under an
   agent-home path for sandbox survival. This is provider/platform-specific, not
   a universal rule.
4. **Spec-first plan.** For substantial work, state the goal, non-goals,
   affected surfaces, and review strategy before code.
5. **Side-effects review.** Identify user-visible behavior, persistence,
   security, external systems, rollback cost, and adjacent interactions.
6. **Tracked later-work.** Any work intentionally left outside the change must
   have an owner or tracker. Do not leave orphan "TODO later" statements.
7. **Implementation.** Make scoped changes, preserve user work, avoid unrelated
   refactors.
8. **Evidence.** Record what changed, why, and how it was verified.
9. **Verification.** Run focused checks and broader checks when shared behavior
   is touched.
10. **Delivery.** Summarize the result, evidence, and residual risk.

## Layer 2: Instar Evolution Overlay

Layer 2 applies when the project is Instar itself.

Additional requirements:

- Recognize the Instar source checkout through existing SourceTreeGuard and
  coherence infrastructure. Do not hand-roll checkout detection.
- Surface repo-local workflows such as `/instar-dev` and `/spec-converge`.
- Use `skills/instar-dev/scripts/write-trace.mjs`; do not rebuild trace
  emission.
- Satisfy `scripts/instar-dev-precommit.js` unchanged.
- Keep `approved: true` as a human authority action.
- Include the ELI16 companion.
- Pass the orphan later-work/content scanner.
- Treat workflow descriptor edits as in-scope gate-protected files.
- Validate a new provider path with semantic review from Echo or another
  qualified reviewer.

## Workflow Descriptors

Provider-neutral descriptors make workflow guidance discoverable outside one
harness's native slash-command system.

This change adds:

- `skills/robust-development/workflow.descriptor.json`
- `skills/instar-dev/workflow.descriptor.json`
- `skills/spec-converge/workflow.descriptor.json`

The descriptor is the provider adapter contract. The existing `SKILL.md` prose
remains the human source of intent where a skill exists.

## Instar Developer Drift Audit

Instar should ship an off-by-default built-in job template that audits drift
between developer-local practices and provider-neutral Instar surfaces.

The template should be enabled first for Echo because Echo is currently the
primary Instar developer agent. It must not be only an Echo-local user job,
because that would recreate the drift pattern it is meant to catch.

The audit compares current developer practices against a checked-in baseline
manifest of provider-neutral development surfaces. When it finds actionable
drift, it produces a short private report or attention item. When no actionable
drift exists, it stays quiet.

## Safety Model

Workflow entry is a signal, not an authority. Surfacing robust workflow guidance
does not grant permission to ship.

Authority remains with the project controls: topic/project coherence, worktree
isolation, existing git gates, human approval, side-effects artifacts, tests,
review, and merge discipline.

For Instar, the structural gate plus human approval are the real authority. A
"qualified agent" label must never become the safety story.

## Acceptance Criteria

- Codex can discover a generic robust development workflow for substantial
  project work.
- The generic workflow includes worktree hygiene and provider-specific placement
  constraints.
- In non-Instar projects, Codex does not surface Instar-specific gates.
- In an Instar source checkout, Codex can discover the Instar overlay workflow
  descriptors.
- Descriptor edits are in scope for the Instar pre-commit gate.
- The developer drift audit ships as a built-in job template, disabled by
  default.
- A checked-in baseline manifest exists for the drift audit.
- Instar-specific artifacts continue to use `write-trace.mjs` and the existing
  pre-commit gate.
- Human approval remains human-controlled.

