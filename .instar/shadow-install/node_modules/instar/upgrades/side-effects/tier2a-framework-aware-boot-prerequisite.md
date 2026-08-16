# Side-effects review — Tier 2.A framework-aware boot prerequisite

**Version / slug:** `tier2a-framework-aware-boot-prerequisite`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (pure-function helpers with exhaustiveness check + full branch coverage)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Audit dimension #1 named this as a hard lock: `Config.load()` threw `Claude CLI not found` unconditionally when claude wasn't installed. Every non-Claude install rejected at startup. This change replaces the unconditional check with a framework-aware one — codex-cli installs only need the codex binary; claude-code installs only need claude.

Implementation:

1. **`resolveConfiguredFramework(configValue, envValue)`** — pure function that picks the active framework. Priority: explicit config field (`sessions.framework`) → `INSTAR_FRAMEWORK` env (with `codex`/`codex-cli`/`claude`/`claude-code` aliases) → default `claude-code` for backwards-compat.

2. **`checkFrameworkPrerequisite({ configuredFramework, claudePathDetected, codexPathDetected })`** — pure function returning `{ satisfied: bool, error?: string }`. The error message is framework-specific and includes the install command.

3. **`Config.loadConfig()` boot path** — refactored to call the two helpers above. Throws if the configured framework's binary is missing; previously threw if Claude was missing regardless of framework.

For backwards-compat with existing spawn paths, the `SessionManagerConfig.claudePath` field now carries the configured framework's binary path. For claude-code installs that's the claude binary as always; for codex-cli installs it's the codex binary. SessionManager's spawn paths can keep reading `claudePath` unchanged; they'll be migrated to read a properly-named `frameworkBinaryPath` in a follow-up slice.

Files touched:
- `src/core/Config.ts` — new `resolveConfiguredFramework` and `checkFrameworkPrerequisite` exports; refactored `loadConfig` boot path to use them.
- `tests/unit/frameworkPrerequisite.test.ts` — new, 11 cases.

## Decision-point inventory

- **Framework selection** — `add`. New `resolveConfiguredFramework` function. Used by Config.load; will be reused by other components that need to know which framework the user picked.
- **Boot prerequisite check** — `modify`. Same authority (block startup when binary missing) but now framework-aware instead of always-Claude.
- **Error message content** — `modify`. Per-framework guidance in the error string.

## Signal vs authority

Pure-function helpers. The authority (`throw new Error`) still lives in `Config.loadConfig`; the helpers just compute the decision. Decoupling makes the boot logic unit-testable without spinning up the full filesystem-aware load flow.

## Over-block / under-block analysis

**Over-block (rejecting installs that should work):** None. Existing claude-code installs continue to require Claude; existing installs that DON'T have INSTAR_FRAMEWORK set still default to claude-code. No new rejection mode.

**Under-block (accepting installs that won't actually work):** A codex-cli install passes the boot check with only codex installed, but other code paths in SessionManager / reviewers / etc. still expect Claude. Those will surface ECC/claude-not-found errors at call-time. This is acceptable for v1.0.0 — boot succeeds, the failures are localized to the (small set of) Claude-specific code paths that the remaining tier-2 work will generalize.

## Level-of-abstraction fit

- Pure functions live alongside the existing detection helpers in `src/core/Config.ts`.
- Exhaustiveness check at the default branch of `checkFrameworkPrerequisite` makes "add a new framework to the union without wiring it" a TypeScript error.
- No new I/O paths, no new external dependencies.

## Interactions

- **`Config.loadConfig`** — calls the new helpers. Existing callers see the same throw behavior for claude-code installs; codex-cli installs now succeed where they previously failed.
- **`SessionManagerConfig.claudePath`** — still populated as a string. For codex-cli installs it now contains the codex binary path. Existing SessionManager spawn paths keep working (they read `claudePath` and exec it; on codex-cli installs they'll be execing codex). Real spawning behavior for codex flows through the openai-codex adapter; reviewers and direct claude-CLI calls in v1.0.0 may misbehave on codex-cli installs until reviewer/sentinel slices migrate them. That's tier 2.B/C/etc. work.
- **No existing tests broken** — checked.

## External surfaces

- New env var: `INSTAR_FRAMEWORK` (accepts claude-code/claude/codex-cli/codex, case-insensitive).
- New config field: `sessions.framework: 'claude-code' | 'codex-cli'` (optional, defaults to claude-code).
- New exports: `resolveConfiguredFramework`, `checkFrameworkPrerequisite`, `FrameworkPrerequisiteInput`, `FrameworkPrerequisiteResult`.

## Rollback cost

Trivial. `git revert` restores the unconditional Claude-required check.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/frameworkPrerequisite.test.ts` — 11/11 pass.
- Coverage: resolveConfiguredFramework (config-wins, env-alias, defaults, whitespace handling) and checkFrameworkPrerequisite (every combination of {claude-code|codex-cli} × {claude installed | claude missing} × {codex installed | codex missing}) plus the v1.0.0 unlock assertion that codex-cli doesn't require Claude.
- No real-API verification needed — pure logic.
- Live verification of boot path happens in Tier 4.B (boot test with INSTAR_FRAMEWORK=codex and no Claude installed).
