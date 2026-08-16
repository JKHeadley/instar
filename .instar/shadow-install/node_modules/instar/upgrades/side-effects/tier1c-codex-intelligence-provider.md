# Side-effects review — Tier 1.C CodexCliIntelligenceProvider + factory

**Version / slug:** `tier1c-codex-intelligence-provider`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (mirrors ClaudeCliIntelligenceProvider's shape exactly; factory is a simple switch with exhaustiveness check)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

The audit named this as the single most load-bearing missing piece: until v0.x, `ClaudeCliIntelligenceProvider` was the ONLY `IntelligenceProvider` implementation, so every reviewer / sentinel / canary / JobReflector that depends on the abstraction ran `claude -p` exclusively. "Supports Codex" was a runtime promise we couldn't keep.

This change adds the sibling implementation plus the factory that picks between them:

1. **`CodexCliIntelligenceProvider`** in `src/core/CodexCliIntelligenceProvider.ts`:
   - Same interface as ClaudeCliIntelligenceProvider (`evaluate(prompt, options) → Promise<string>`).
   - Routes through `codex exec --model <tier> --sandbox <mode> --cd <wd> <prompt>`.
   - Reuses Codex adapter's `resolveCliModelFlag` so `fast`/`balanced`/`capable` tiers map correctly (`gpt-5.2` / `gpt-5.3-codex` / `gpt-5.4`).
   - Strips the same `CLAUDECODE` / `CLAUDE_SESSION_ID` env markers as the Claude provider (defense-in-depth — Codex itself doesn't care, but consistent hygiene means nested-session quirks can't leak across providers).
   - Closes stdin explicitly to avoid the EOF-hang bug we already fixed once in the Codex adapter's transport layer.

2. **`buildIntelligenceProvider(options)` factory** in `src/core/intelligenceProviderFactory.ts`:
   - `framework: 'claude-code' | 'codex-cli'` (default `claude-code`).
   - Optional `binaryPath` override; falls back to `detectClaudePath()` / `detectCodexPath()`.
   - Returns null when the required binary can't be located. Caller decides what to do.
   - Exhaustiveness check at the default branch — extending `IntelligenceFramework` without adding a switch case is a type error.

3. **`frameworkFromEnv(env)`** helper:
   - Parses `INSTAR_FRAMEWORK` env var. Accepts `claude-code` / `claude` / `CLAUDE`, `codex-cli` / `codex` / `CODEX`.
   - Returns null for unset, empty, or unknown values — caller applies the default.

Files touched:
- `src/core/CodexCliIntelligenceProvider.ts` — new, 92 LOC.
- `src/core/intelligenceProviderFactory.ts` — new, 88 LOC.
- `tests/unit/intelligenceProviderFactory.test.ts` — new, 10 cases.

## Decision-point inventory

- **IntelligenceProvider selection** — `add`. The composition root (not yet wired) will call `buildIntelligenceProvider({ framework: configuredFramework })`. Today every reviewer/sentinel constructs an IntelligenceProvider directly via `new ClaudeCliIntelligenceProvider(path)`; that wiring migrates to the factory in the server-composition-root slice.
- **Codex evaluate() shape** — `add`. New surface mirrors Claude's contract exactly. Errors reject (not collapse), so callers can fall back the same way they do for Claude.

## Signal vs authority

Both providers are signal producers (return text). They have no blocking authority. The reviewer/sentinel/canary above them is the authority that decides what to do with the response.

## Over-block / under-block analysis

**Over-block:** None. The factory adds a new path; the existing direct-construction path keeps working.

**Under-block:** Until the composition root migrates to use the factory, the only IntelligenceProvider running in production is still ClaudeCli. Codex installs can't get LLM-backed reviewer/sentinel benefits yet. This is the next slice's job.

## Level-of-abstraction fit

- The two implementations are siblings in `src/core/`. Adding Gemini, DeepSeek, etc. follows the same pattern.
- The factory takes a framework name and returns a provider. No provider-specific options leak to the caller.
- Model-tier resolution is delegated to per-adapter helpers — same separation of concerns that already existed.

## Interactions

- **`ClaudeCliIntelligenceProvider`** — unchanged. Both providers can coexist; the factory picks one per agent.
- **Codex adapter `models.ts:resolveCliModelFlag`** — consumed by the new provider. No changes to the adapter.
- **`detectClaudePath` / `detectCodexPath`** (Tier 0 work) — consumed for binary detection fallback.
- **No existing source files modified** except for the additive new ones.

## External surfaces

- New exports: `CodexCliIntelligenceProvider`, `CodexCliIntelligenceProviderOptions`, `buildIntelligenceProvider`, `BuildIntelligenceProviderOptions`, `IntelligenceFramework`, `frameworkFromEnv`.
- New env var recognized: `INSTAR_FRAMEWORK` (claude-code / claude / codex-cli / codex, case-insensitive).
- No new CLI command, no new config field shipped yet — the framework selection is env-driven for v1.0.0 and will get a config-file field in Phase 7 (migration design).

## Rollback cost

Trivial. `git revert` removes three new files. No production callsite consumes the factory yet.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/intelligenceProviderFactory.test.ts` — 10/10 pass.
- Coverage: framework selection (claude-code, codex-cli, default), binary-path override propagation, workingDirectory propagation for Codex, INSTAR_FRAMEWORK parsing (all aliases + case insensitivity + unset + unknown).
- No real-API verification yet — the live `codex exec` round-trip happens in the E2E test slice (Tier 4.C).
