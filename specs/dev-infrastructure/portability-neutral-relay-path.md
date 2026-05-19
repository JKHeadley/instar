---
title: "Framework-neutral telegram-reply path (portability Gap 4)"
slug: "portability-neutral-relay-path"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-neutral-relay-path.eli16.md"
review-convergence: "2026-05-19T20:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T20:00:00Z"
review-report: "docs/specs/reports/portability-neutral-relay-path-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode, 'finish making all the fixes based on the audit and get them deployed' + 'proceed as you best see fit')"
approved-date: "2026-05-19"
approval-note: "Gap 4 of six. Ships v1.0.10, second of the v1.0.9-v1.0.14 hardening series."
lessons-engaged:
  - "P1 (Structure>Willpower): the neutral script is installed structurally by the migrator; the appendix points at it — not a doc telling agents which path to guess."
  - "P3 (Migration Parity): existing agents get the .instar/scripts/ mirror on next update via migrateScripts; idempotent install-if-missing + SHA-migrate."
  - "P4 (Testing Integrity): 4-case migrator test + updated IdentityRenderer assertion (both decision sides — neutral path present, fallback note present)."
  - "P10 (Comprehensive-First): appendix + migrator mirror both ship here; SessionStart hook already had the dual-path preference, now its preferred path actually exists."
  - "L1-equivalent (audit-driven): closes verified Gap 4 — the appendix hardcoded .claude/scripts/ with no fallback; the neutral path it should prefer was never installed."
  - "L6/L9/L10: sibling side-effects + ELI16 + NEXT.md."
---

# Framework-neutral telegram-reply path (portability Gap 4)

## Problem

`telegram-reply.sh` was installed ONLY under `.claude/scripts/`. The
SessionStart hook (`PostUpdateMigrator.ts:3309-3314`) already preferred the
framework-neutral `.instar/scripts/telegram-reply.sh` with a `.claude/scripts/`
fallback — but the neutral copy was never created, so the preference never
resolved. Worse, the `IdentityRenderer` persistent relay appendix
(`IdentityRenderer.ts:176`) hardcoded `.claude/scripts/telegram-reply.sh` with
no fallback. A Codex/Gemini install (no `.claude/scripts/`) was instructed via
its AGENTS.md to run a script that did not exist. Verified Gap 4 of the
v1.0.0 cross-framework portability audit.

## Change

1. **IdentityRenderer appendix** now points at `.instar/scripts/telegram-reply.sh`
   (exists for every runtime) and documents the `.claude/scripts/` fallback for
   older installs.
2. **PostUpdateMigrator.migrateScripts** additionally mirrors the same generated
   script content to `.instar/scripts/telegram-reply.sh`, with identical
   install-if-missing + SHA-migrate semantics to the existing `.claude/scripts/`
   copy. The neutral preference at line 3309 now resolves for all frameworks.

The Claude-Code SessionStart hook template (`PostUpdateMigrator.ts:1822`) is
intentionally left on `.claude/scripts/` — that hook only runs under Claude
Code (Codex has no SessionStart hook; that is precisely why the AGENTS.md
appendix carries the relay convention for Codex). The dual-path resolver at
3309-3310 handles the neutral preference for the hook path.

## What this is NOT

- Not a change to `buildTelegramRelayBlock` (the per-message bootstrap helper)
  — that is a separate function/code path, untouched, tests still green.
- Not a removal of the `.claude/scripts/` copy — it stays for backward
  compatibility with Claude-Code hooks/scripts that reference it.

## Testing

`tests/unit/PostUpdateMigrator-neutralRelayPath.test.ts` — 4 cases: installs
at BOTH locations with identical content; neutral copy executable; idempotent;
no-op when Telegram unconfigured. `tests/unit/IdentityRenderer.test.ts`
assertion updated to the neutral path + fallback note (both decision sides).
Regression-checked: `telegramRelayPrompt`, `telegram-autospawn-history`,
`verify-deployed-templates`, `UpgradeNotifyManager` all still green.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ migrator installs neutral copy structurally |
| P3 Migration Parity | ✓ existing agents get the mirror on update, idempotent |
| P4 Testing Integrity | ✓ 4 new + 1 updated, regression-swept |
| P6 Zero-Failure | ✓ full suite green before push |
| P10 Comprehensive-First | ✓ appendix + migrator both fixed |
| L1 (audit-driven) | ✓ closes verified Gap 4 |
| L6/L9/L10 | ✓ siblings |

No contradictions. Zero deferrals.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/core/IdentityRenderer.ts` — appendix neutral path + fallback note.
3. `src/core/PostUpdateMigrator.ts` — `.instar/scripts/` mirror in migrateScripts.
4. `tests/unit/PostUpdateMigrator-neutralRelayPath.test.ts` (NEW, 4 tests).
5. `tests/unit/IdentityRenderer.test.ts` — updated assertion.
6. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-neutral-relay-path.md`.
