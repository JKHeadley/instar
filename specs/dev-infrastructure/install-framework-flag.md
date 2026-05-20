---
title: "instar init --framework — install-time runtime choice (PR 1/4)"
slug: "install-framework-flag"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "install-framework-flag.eli16.md"
review-convergence: "2026-05-20T02:15:00Z"
review-iterations: 1
review-completed-at: "2026-05-20T02:15:00Z"
review-report: "docs/specs/reports/install-framework-flag-convergence.md"
approved: true
approved-by: "Justin (2026-05-20, autonomous-mode, explicit 'please proceed in autonomous mode and complete the install/wizard upgrade')"
approved-date: "2026-05-20"
approval-note: "PR 1 of the four-PR install/wizard portability series identified in the Codex-only install audit. Default behavior unchanged. Foundation for PRs 2-4."
lessons-engaged:
  - "P1 (Structure>Willpower): the flag is a real CLI option that writes a real config field; not a doc."
  - "P4 (Testing Integrity): 5-case unit test pinning the resolver across all flag values + default + fresh-array-per-call guarantee."
  - "P10 (Comprehensive-First): all three init paths (fresh, existing, standalone) write enabledFrameworks; no half-fix."
  - "L1-equivalent (audit-driven): closes the first verified blocker from the codex-only install audit (cli.ts had --framework only on `route`, not on `init`)."
  - "L6/L9/L10: siblings."
---

# instar init --framework — install-time runtime choice (PR 1 of 4)

## Problem

The Codex-only install audit identified four blockers preventing a fully
functional Codex-only `npx instar` install. Blocker 1: the `--framework`
flag existed only on the `route` command (`src/cli.ts:2270`), not on `init`
or `setup`. Even though every downstream layer (PostUpdateMigrator,
FrameworkParitySentinel, IdentityRenderer, FrameworkSessionStore) reads
`config.enabledFrameworks` and behaves correctly per runtime, the install
command had no UI for expressing the choice.

## Change

1. **New CLI option** on `instar init`: `--framework <claude-code|codex-cli|both>`. Allowed values are validated at parse time; an invalid value exits with a clear error.
2. **`InitOptions.framework`** added to the interface so all init paths receive the choice.
3. **`resolveEnabledFrameworks(choice)`** is a pure exported helper that maps the flag value to the persisted `enabledFrameworks` array. Default (`undefined`) returns `['claude-code']` — historical behavior, byte-identical for users who don't pass the flag.
4. **Three init paths write `enabledFrameworks`** to `config.json`: fresh project (`initFreshProject`), existing project (`initExistingProject`), and standalone agent (`initStandaloneAgent`). All three previously omitted the field.

## What this is NOT

- Not a gating change. `installClaudeSettings()` still runs unconditionally — that's PR 2.
- Not the setup-wizard flag. PR 3 adds the same flag to `setup`.
- Not the wizard routing. PR 4 routes the wizard through the chosen CLI.
- Not a change to the default behavior. Existing users who don't pass `--framework` get identical behavior, including the `.claude/` writes.

## Testing

`tests/unit/init-framework-flag.test.ts` — five cases:
- default (undefined) → `['claude-code']`
- explicit `'claude-code'` → `['claude-code']`
- `'codex-cli'` → `['codex-cli']`
- `'both'` → `['claude-code', 'codex-cli']`
- fresh array per call (no shared mutable state)

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ flag + real config field |
| P4 Testing Integrity | ✓ 5 cases covering every branch + invariant |
| P6 Zero-Failure | ✓ suite green |
| P10 Comprehensive-First | ✓ all three init paths fixed |
| L1 (audit-driven, verified) | ✓ closes audit blocker 1 |
| L6/L9/L10 | ✓ siblings |

No contradictions. No deferrals (PRs 2-4 are distinct blockers, not deferrals of this).

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/commands/init.ts` — `InitOptions.framework`, `resolveEnabledFrameworks()` helper, `enabledFrameworks` in all three config writes.
3. `src/cli.ts` — `--framework <name>` option on the `init` command with validation.
4. `tests/unit/init-framework-flag.test.ts` (NEW, 5 tests).
5. `upgrades/NEXT.md` (combined release notes for v1.0.15 = this + Gap 6).
6. `upgrades/side-effects/feat-install-framework-flag.md`.
