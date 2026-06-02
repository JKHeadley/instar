# Side-Effects Review — Apprenticeship Step 2: Gemini CLI Runtime Adapter

**Version / slug:** `APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `not required` (converged: 3 internal reviewers + codex gpt-5.5, 2 rounds)

## Summary of the change

Builds Step 2 of the Apprenticeship Program (umbrella #675) — the minimal-viable `gemini-cli`
runtime adapter (the keystone). Adds: the `GeminiCliIntelligenceProvider` class (the production
one-shot path via `buildIntelligenceProvider`), the `src/providers/adapters/gemini-cli/` registry
adapter (dormant parity-harness surface, mirroring codex), framework registration across the
hand-audited union sites, and — critically — the **framework-blind resolver fixes** the codex
onboarding had to make (so gemini doesn't silently re-open them).

## Decision-point inventory

- **Approval mode (two paths).** One-shot evaluation (`GeminiCliIntelligenceProvider`) hard-pins
  `--approval-mode default` (no tools) — the analog of `codex exec --sandbox read-only`. The
  **agentic session** (`geminiCliBuilder`) launches with `--yolo` — auto-approve, matching how the
  fleet launches Claude (`--dangerously-skip-permissions`) and codex
  (`--dangerously-bypass-approvals-and-sandbox`) agents. (Convergence follow-up fix: the initial
  build over-applied the one-shot lockdown to the agentic builder; corrected.)
- **Framework-blind resolvers** — `ThreadResumeMap.jsonlExists`, `RateLimitSentinel` +
  `CompactionSentinel` recovery-verification, and `frameworkProcessSignals`/`frameworkActivitySignals`
  now branch on gemini; a **drift canary** fails CI if a new `IntelligenceFramework` member lacks a
  resolver. These were the round-1 BLOCKING finding (the codex landmines from tasks #24/#26/#33).

## 1. Over-block

**What legitimate inputs does this reject?** The one-shot path refuses tool-taking modes (by design
— it's an evaluation). The drift canary fails the build if a framework is added without a
jsonl/rollout resolver — that's the intended forcing function. Nothing legitimate is over-blocked.

## 2. Under-block

**What does this still miss?** The CONDITIONAL primitives (`HookEventReceiver`/`gemini hooks`,
`CompactionLifecycle`, full `SessionResumeIndex` layout parsing) are NOT shipped — their live
contracts are uncharacterized, so they're tracked as `programNeeds` (incl. the native loop-driver,
`need-gem-002`, a Step-4 prerequisite) rather than half-built. The adapter's behavioral parity with
codex (~35 primitives) is explicitly ongoing apprenticeship work, not claimed here.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The production path is the `GeminiCliIntelligenceProvider` class (mirrors
`CodexCliIntelligenceProvider`) constructed by `buildIntelligenceProvider`; the registry adapter is
dormant (matches codex — server.ts registers none yet). Transport uses `spawn()` array-args (no
shell), an env-allowlist with unconditional billing-key delete (mirrors codexSpawn), an output cap,
and the canonical argv `gemini -m <model> --approval-mode default -p <prompt>`.

## 4. Testing (verified independently)

- **Unit:** `gemini-cli-adapter.test.ts` (argv/safety/config), `framework-resolver-drift.test.ts`
  (the drift canary — asserts the gemini resolver returns the CORRECT path for a synthetic fixture),
  plus the modified framework-union tests. **92 framework/gemini unit tests pass.**
- **Integration:** `gemini-cli-provider.test.ts` — `buildIntelligenceProvider({framework:'gemini-cli'})`
  returns the provider (6 pass).
- **E2E:** `gemini-cli-alive-lifecycle.test.ts` — the framework resolves through the production path,
  not 503/throw (2 pass).
- **Regression:** the framework-blind fixes verified — **128 sentinel/resume-map tests pass**
  (CompactionSentinel, RateLimitSentinel, TopicResumeMap incl. their codex variants). `tsc --noEmit`
  clean. Tests are hermetic (no live gemini spawn in the suite).

## 5. Migration Parity + Agent-Awareness

- **Migration Parity:** the parallel framework unions in `types.ts` (incl. `enabledFrameworks`),
  `Config.ts`, `PostUpdateMigrator.getEnabledFrameworks` (the filter that would silently drop
  gemini-cli) etc. are widened to include `'gemini-cli'`; `SUPPORTED_FRAMEWORKS` ships in code so
  existing agents accept it on the version bump. No new `.instar/config.json` default required.
- **Agent-Awareness:** `FRAMEWORK_SHADOW_FILES` already maps `gemini-cli → GEMINI.md`; the
  `--framework gemini-cli` CLI option is added to the `cli.ts`/`init.ts`/`setup.ts` allowlists and
  `route.ts`/`reflect.ts` resolvers.
- **Publish:** touches `src/` broadly → a `NEXT.md` fragment is added.

## 6. Rollback
Revert the commit; gemini-cli simply stops being an offered framework. No deployed state to undo
(no agent is configured gemini-cli until Step 3 installs one).
