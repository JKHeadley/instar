---
title: "Shadow capability mirror (portability Gap 6 — minimal shim)"
slug: "portability-shadow-capabilities"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-shadow-capabilities.eli16.md"
review-convergence: "2026-05-19T22:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T22:00:00Z"
review-report: "docs/specs/reports/portability-shadow-capabilities-convergence.md"
approved: true
approved-by: "Justin (2026-05-19, explicit choice via AskUserQuestion: 'Minimal Codex/Gemini shim')"
approved-date: "2026-05-19"
approval-note: "Gap 6 — final audit gap. Operator explicitly chose the 'minimal shim' approach over canonical-doc / pure-renderer / literal-audit options. Ships v1.0.14, closes the v1.0.0 cross-framework portability audit at 6/6 code gaps."
lessons-engaged:
  - "P1 (Structure>Willpower): the migrator mirrors sections structurally; not a doc telling operators to copy them."
  - "P4 (Testing Integrity): 6-case test — appends, idempotent, both shadows, no-op no-shadow, no-op no-CLAUDE.md, identity preserved."
  - "Trust-Verify-Improve: bodies are LITERALLY copied from the just-patched CLAUDE.md; no duplicated section bodies in source, so the two cannot drift."
  - "L1-equivalent (audit-driven, framing corrected): the audit's 'unify with IdentityRenderer' conflated identity and capability docs; the operator-chosen minimal shim resolves it without conflating them or doing a 360-line refactor."
  - "L6/L9/L10: siblings."
---

# Shadow capability mirror (Gap 6 — minimal shim)

## Problem

`generateClaudeMd` + `migrateClaudeMd` produce a rich capability/instructions
document for Claude Code (Self-Discovery, Private Viewing, Dashboard,
Coherence Gate, External Operation Safety, Playbook, Threadline Network, …)
— but Codex/Gemini shadows had no equivalent. Gap 1 (shipped v1.0.9) gives
non-Claude shadows their canonical identity; this closes the capability-
instructions gap so an agent on Codex/Gemini knows the same set of things it
can *do* as a Claude Code agent does.

## Why "minimal shim" — operator decision

The audit said "unify migrateClaudeMd with IdentityRenderer." Verified
against the code, that framing conflates two different things: identity
(canonical AGENT.md → shadow filename) and capability instructions (rich
per-section content). After presenting four grounded options
(minimal-shim / canonical-doc / defer / literal-audit) the operator chose
the minimal-shim approach: a sibling migrator that mirrors the SAME sections
into non-Claude shadows when they exist, without re-architecting CLAUDE.md's
role.

## Change

New `migrateFrameworkShadowCapabilities` runs immediately after
`migrateClaudeMd`. For each non-Claude shadow that exists (AGENTS.md,
GEMINI.md), it:

1. Reads the just-patched CLAUDE.md (the authoritative source of currently-
   shipped capability sections).
2. For each well-known section marker (`### Self-Discovery`, `**Private
   Viewing**`, `**Cloudflare Tunnel**`, `**Dashboard**`, `**File Viewer`,
   `### Coherence Gate`, `### External Operation Safety`, `### Playbook`,
   `## Threadline Network`):
   - If absent from the shadow, slice the section out of CLAUDE.md (from
     the marker through the start of the next `##`/`###` heading or EOF)
     and append it to the shadow.
3. Writes the shadow only when something was appended.

Section bodies are LITERALLY copied from CLAUDE.md — they are NOT duplicated
in source, so the Claude and non-Claude shadows cannot drift. The full
extraction of `migrateClaudeMd`'s ~360 lines of inline section content into
a shared array was deliberately NOT done — that would have been high-risk
for low marginal benefit per the operator's minimal-shim choice.

## What this is NOT

- Not a touch on `migrateClaudeMd` itself — Claude Code behavior is
  byte-identical.
- Not an IdentityRenderer change — identity render (Gap 1, shipped) is the
  separate concern; this only mirrors capability sections.
- Not a Claude-only-install impact — no shadow exists there, no-op.
- Not a v1.1 deferral — the operator explicitly chose to ship this in v1.0.

## Testing

`tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts` — 6 cases:
appends missing sections to AGENTS.md from a fixture CLAUDE.md; idempotent
on re-run; mirrors into BOTH AGENTS.md and GEMINI.md; no-op when no shadow
exists; no-op (with note) when CLAUDE.md is absent; identity content above
the appended sections is preserved.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ structural mirror |
| P4 Testing Integrity | ✓ 6 cases, both decision sides |
| P6 Zero-Failure | ✓ suite green |
| Trust-Verify-Improve | ✓ bodies LITERALLY copied; cannot drift |
| L1 (audit-framing corrected) | ✓ identity vs capability disentangled |
| L6/L9/L10 | ✓ siblings |

No contradictions. Operator-chosen scope explicit.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/core/PostUpdateMigrator.ts` — new `migrateFrameworkShadowCapabilities`
   + call after `migrateClaudeMd`.
3. `tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts` (NEW, 6 tests).
4. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-shadow-capabilities.md`.
