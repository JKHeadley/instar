---
title: "Init renders non-Claude identity shadows (portability Gap 1)"
slug: "portability-init-identity-shadows"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-init-identity-shadows.eli16.md"
review-convergence: "2026-05-19T19:45:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T19:45:00Z"
review-report: "docs/specs/reports/portability-init-identity-shadows-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode, 'finish making all the fixes based on the audit and get them deployed' + 'proceed as you best see fit')"
approved-date: "2026-05-19"
approval-note: "Gap 1 of the six cross-framework portability gaps from the v1.0.0 audit. Ships as v1.0.9, the first of the v1.0.9-v1.0.14 hardening patch series the v1.0.8 release notes committed to."
lessons-engaged:
  - "P1 (Structure>Willpower): init now structurally renders non-Claude shadows; not a doc telling operators to create AGENTS.md."
  - "P4 (Testing Integrity): 5-case unit test — renders AGENTS/GEMINI, never clobbers CLAUDE.md, no-op-no-throw without AGENT.md, idempotent, relay-appendix."
  - "P10 (Comprehensive-First): both init code paths (primary + secondary) fixed in this PR; no half-fix."
  - "L1-equivalent (audit-driven): closes audit Gap 1 verified against the actual code (init had zero framework awareness; runtime self-healed only at first spawn)."
  - "L6 (Side-effects review): sibling file."
  - "L9 (ELI16 required): sibling file."
  - "L10 (Release notes same PR): upgrades/NEXT.md in this PR."
---

# Init renders non-Claude identity shadows (portability Gap 1)

## Problem

`instar init` had zero framework awareness. It always wrote a
Claude-Code-specific `CLAUDE.md` (the rich capability/instructions document
from `generateClaudeMd()`) and the canonical `.instar/AGENT.md`, but produced
no identity file for non-Claude runtimes. A Codex install got a `CLAUDE.md`
(which Codex ignores) and no `AGENTS.md`. Identity was not auto-loaded for
that runtime until the first server spawn called `ensureFrameworkIdentityFile`
(runtime self-heal). This is verified Gap 1 from the v1.0.0 cross-framework
portability audit.

## Change

A new `renderNonClaudeIdentityShadows(projectDir, opts)` in `IdentityRenderer`
renders every known framework shadow EXCEPT `claude-code` from the canonical
`.instar/AGENT.md`. Both `instar init` CLAUDE.md write sites now call it right
after writing CLAUDE.md.

Design decisions:

- **claude-code is deliberately excluded.** `generateClaudeMd()` produces a
  rich capability document that legitimately owns the `CLAUDE.md` filename.
  That is NOT an identity render and must not be clobbered. The unification of
  `migrateClaudeMd`/`generateClaudeMd` with the identity renderer is a
  separate audit gap (Gap 6) tracked independently.
- **Additive and best-effort.** No-ops when `.instar/AGENT.md` is absent;
  never throws into the init flow (init must not fail because a shadow could
  not be written).
- **Idempotent.** Re-running reproduces identical shadow content.

## What this is NOT

- Not the Gap 6 migrator/identity-renderer unification.
- Not a change to the Claude-Code CLAUDE.md content or its generator.
- Not the runtime spawn path (`ensureFrameworkIdentityFile` is unchanged; this
  closes the *init-time* gap so the shadow exists before first spawn).

## Testing

`tests/unit/renderNonClaudeIdentityShadows.test.ts` — 5 cases: renders
AGENTS.md + GEMINI.md from canonical AGENT.md; never writes/clobbers
CLAUDE.md; no-op-no-throw when AGENT.md absent; idempotent; Telegram relay
appendix on request.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ structural render, not a doc |
| P4 Testing Integrity | ✓ 5-case unit test, both decision sides |
| P6 Zero-Failure | ✓ full suite green before push |
| P10 Comprehensive-First | ✓ both init paths fixed |
| L1 (audit-driven) | ✓ closes verified Gap 1 |
| L6 Side-effects | ✓ sibling |
| L9 ELI16 | ✓ sibling |
| L10 Release notes | ✓ NEXT.md in PR |

No contradictions. Zero deferrals (Gap 6 is a distinct audit item, not a
deferral of this one).

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/core/IdentityRenderer.ts` — `renderNonClaudeIdentityShadows`.
3. `src/commands/init.ts` — call it at both CLAUDE.md write sites.
4. `tests/unit/renderNonClaudeIdentityShadows.test.ts` — 5 tests.
5. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-init-identity-shadows.md`.
