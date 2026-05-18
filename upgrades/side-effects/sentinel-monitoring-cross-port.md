# Side-effects review — Sentinel + monitoring cross-port

**Version / slug:** `sentinel-monitoring-cross-port`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — 64 tests across InstructionsVerifier + PromptGate green; typecheck clean.
**Driving spec:** `specs/provider-portability/00-functional-map.md` (D: Session health / stall / recovery; F: Interactive prompt detection).

## Summary of the change

Closes three of the four sentinel-cross-port residuals identified in the prior autonomous-cycle final report. The fourth (setup wizard) is explicitly documented as out-of-scope — Claude Code's skill system is Claude-specific and porting requires its own design pass.

1. **InstructionsVerifier — framework-aware default expected pattern**
   - Adds `framework?: 'claude-code' | 'codex-cli'` to `InstructionsVerifierConfig`.
   - When framework is set, the default `expectedPatterns` resolves per-framework: `['CLAUDE.md']` for Claude Code, `['AGENTS.md']` for Codex.
   - When framework is unset (migration-safe default), the verifier accepts EITHER `CLAUDE.md` OR `AGENTS.md` — passes if any one of them loads. This prevents false alarms during framework swaps where both files may transiently coexist.
   - Explicit `expectedPatterns` still overrides everything (back-compat).

2. **PromptGate — Codex CLI UI prompt detection**
   - Confirmation pattern extended to detect both Claude's `"Esc to cancel · Tab to amend"` AND Codex's `"Ctrl+C to cancel"` / `"Press Ctrl-C to cancel"` variants.
   - LLM gate prompt rewritten to mention Codex's UI tokens (`Ctrl+C to interrupt`, `> ` prompt, `Update Plan`, `Step N`, `Apply patch?`, `Run command?`) so the Haiku-class classifier doesn't false-positive Codex's status bar as a blocking prompt.
   - First sentence widened from "Claude Code session" to "AI agent session (Claude Code OR OpenAI Codex CLI)".

3. **Lifeline doctor session — framework-aware refusal for Codex**
   - `spawnDoctorSession` now checks `INSTAR_FRAMEWORK`. For `codex-cli` it throws a typed error with explicit fallback messaging. The existing catch in `recoverWithSupervisor` already forwards the error to the user-facing topic, so Codex users see a clear "diagnostic spawn not supported, falling back to circuit-breaker reset" message instead of a silent crash loop.
   - The doctor session uses Claude-specific flags (`--message -` stdin prompt, `--allowedTools` tool restriction) that have no direct Codex equivalent. Rather than building a half-port, v1.0.0 makes the Claude-only scope explicit and tracks the Codex doctor as Phase 6+ work.

4. **Setup wizard — documented as Claude-only by design (no code change)**
   - The wizard spawns Claude Code with `/setup-wizard` and `/secret-setup` skills. Those skills are part of Claude Code's skill system, not Instar's. Building Codex equivalents requires defining a new skill system in the Codex CLI, which is upstream territory. Documented in the v1.0.0 release notes as a residual.

Files touched:
- `src/monitoring/InstructionsVerifier.ts` — adds `framework` field, per-framework default resolution, cross-framework fallback.
- `src/monitoring/PromptGate.ts` — extends confirmation regex + rewrites LLM gate prompt.
- `src/lifeline/TelegramLifeline.ts` — adds framework guard to `spawnDoctorSession`.
- `tests/unit/instructions-verifier.test.ts` — 7 new framework-aware cases (29 total green).
- `tests/unit/PromptGate.test.ts` — 2 new Codex confirmation cases (35 total green).

## Decision-point inventory

- **InstructionsVerifier cross-framework fallback** — `add`. When the verifier doesn't know which framework is active (e.g., during a swap), accept either identity file. Prevents false-alarm churn.
- **PromptGate Codex pattern variants** — `add`. `Ctrl+C to cancel` and `Press Ctrl-C to cancel` both captured.
- **Lifeline doctor refusal for Codex** — `add`. Typed error reaches the catch, user sees a clear message instead of a confusing fallback.
- **Setup wizard left Claude-only** — `deliberate non-action`. Cross-porting requires upstream Codex CLI changes (skill system), not Instar code changes.

## Signal vs authority

- All three components stay at their existing level. Verifier emits a signal; PromptGate emits detected-prompt events for downstream consumers; Lifeline doctor is authoritative for its own spawn decision (it now refuses for Codex instead of silently failing).

## Over-block / under-block analysis

**Over-block:** None. InstructionsVerifier's cross-framework fallback is strictly more permissive than the old default (anyone-of vs all-of). PromptGate's added Codex pattern can't fire on Claude output (Claude doesn't print `Ctrl+C to cancel`).

**Under-block:** None new. The Codex doctor refusal is honest — recovery still proceeds via circuit-breaker reset, just without a diagnostic session.

## Level-of-abstraction fit

- All three changes are localized to their owning module. No cross-module refactor.
- `framework` field on InstructionsVerifierConfig matches the convention used elsewhere (StallTriageNurseConfig already has the same field).
- PromptGate's pattern union is the existing extension point — adding a new framework's UI strings is a single-line regex addition.

## Interactions

- **`spawnInteractiveSession` framework dispatch** — orthogonal. The spawn paths are framework-aware; the verifier observes what they loaded.
- **StallTriageNurse framework field** — same pattern. Both now share the `framework: 'claude-code' | 'codex-cli'` convention.
- **Doctor session caller (`recoverWithSupervisor`)** — preserved behavior. The catch already forwards the error message to the user-facing topic.

## Rollback cost

Pure code change. Revert any single file independently. No persistent state migrations, no schema changes.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/instructions-verifier.test.ts` — 29/29 green.
- `npx vitest run tests/unit/PromptGate.test.ts` — 35/35 green.
- Manual: Codex framework env var triggers the doctor refusal path with the expected error message.
