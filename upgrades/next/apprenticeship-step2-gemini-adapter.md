# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Instar can now run on a third framework: **Gemini CLI**. This is the apprenticeship Step 2 keystone — the runtime adapter ("the body") for `gemini-cli`, so the existing framework-agnostic agent layer ("the mind") runs on Gemini the same way it already runs on Claude Code and Codex CLI.

`gemini-cli` is now a first-class `IntelligenceFramework`. The live judgment path (`buildIntelligenceProvider`) constructs a new `GeminiCliIntelligenceProvider` that spawns the verified one-shot `gemini -m <model> --approval-mode default -p <prompt>` — a single pinned, canonical argv with the prompt as exactly one element. The body ships the MANDATORY floor only (one-shot transport + SessionId + HardKill), with an honest, minimal capability declaration; the richer primitives (native `gemini hooks`, compaction lifecycle, full session-resume index) are explicitly tracked as ongoing apprenticeship parity work, not shipped half-built.

Critically, this closes the *framework-blind* surfaces that a new framework silently breaks without a compile error: resume (`ThreadResumeMap`/`TopicResumeMap` `jsonlExists`), rate-limit + compaction recovery-verification, process/activity detection, and the transcript resolver all now have a real Gemini branch that resolves the correct `~/.gemini` session file. A new **drift canary** enumerates every framework and fails CI if any future framework lacks a correct resolver — turning a class of silent fleet-wide breakage into a test-forced one.

Security is pinned at the call site: the one-shot never reaches `--yolo`/`--approval-mode yolo`, the child env unconditionally hard-deletes the five Google/Gemini billing vars (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`) so Gemini stays on its cached-OAuth path and can't be silently billed, and captured output is byte-capped (improving on the codex adapter's unbounded buffer).

## What to Tell Your User

Nothing to do for existing Claude or Codex agents — they are completely unaffected. If you want to run an agent on Gemini CLI, install the Gemini CLI, sign in, and choose Gemini as the framework when you set up an agent (or bind a single topic to Gemini). The full Gemini agent experience — the multi-turn loop driver and the richer monitoring features — is still being built as ongoing apprenticeship work; this step is the foundation that makes Gemini runnable, not full feature parity yet.

## Summary of New Capabilities

- `gemini-cli` is a first-class `IntelligenceFramework`; `buildIntelligenceProvider({ framework: 'gemini-cli' })` returns a circuit-breaker-wrapped `GeminiCliIntelligenceProvider` (the live transport), and the registry adapter `src/providers/adapters/gemini-cli/` exists as the parity-harness surface.
- `--framework gemini-cli` is accepted by `instar init` / `instar setup` and `instar route`; a topic can be bound to `gemini-cli` (`SUPPORTED_FRAMEWORKS`).
- The framework-blind resolvers (resume, rate-limit/compaction recovery-verification, process/activity signals, transcript resolution) all handle Gemini's `~/.gemini/tmp/<projectHash>/chats/session-*.json[l]` layout; `PostUpdateMigrator.getEnabledFrameworks` no longer silently drops `gemini-cli`.
- A drift canary (`tests/unit/framework-resolver-drift.test.ts`) asserts every `IntelligenceFramework` resolves to its CORRECT transcript and fails CI if a future framework lacks a resolver.

## Evidence

- `npx tsc --noEmit` clean. New tests green across all three tiers: `tests/unit/gemini-cli-adapter.test.ts` (canonical argv + yolo-safety + the 5-var key-leak canary + output cap + wiring integrity, 17 tests), `tests/unit/framework-resolver-drift.test.ts` (the semantic drift canary, 6 tests), `tests/integration/gemini-cli-provider.test.ts` (registry resolve + the ALIVE `buildIntelligenceProvider` path, 6 tests), `tests/e2e/gemini-cli-alive-lifecycle.test.ts` (a REAL one-shot through the production provider returned the expected PONG smoke against gemini v0.25.2, 2 tests).
- Spec: `docs/specs/APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.md`. Two tracked `programNeeds` (parity gap `need-gem-001` + native loop driver `need-gem-002`) keep the remaining work open, not dropped.
