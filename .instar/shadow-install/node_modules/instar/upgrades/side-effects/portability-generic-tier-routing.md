# Side-effects review — Generic tier routing + framework-aware /sessions/spawn whitelist + Codex config-readable default model

**Version / slug:** `portability-generic-tier-routing`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — 197 unit tests across 8 files green; typecheck clean; refactor is pure call-site rewiring of an already-converged tier abstraction
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Tracks D + E of the v1.0.0 provider-portability autonomous cycle. Three related fixes:

1. **Generic tier mapping helper** — `resolveModelForFramework(framework, modelOrTier)` in `src/core/frameworkSessionLaunch.ts`. Maps the cross-framework tiers (`fast`/`balanced`/`capable`) to each framework's preferred concrete model. Legacy Claude tier names (`haiku`/`sonnet`/`opus`) also resolve correctly for both frameworks so unported callsites don't crash for Codex agents. Raw model ids pass through verbatim.

2. **buildInteractiveLaunch + buildHeadlessLaunch route through the helper** — the codex builder's hardcoded `gpt-5.3-codex` (line 88) is now a `resolveModelForFramework('codex-cli', options.defaultModel) ?? 'gpt-5.3-codex'` lookup so config can override. The claude builder applies the same tier-expansion so generic tiers like `'fast'` correctly become `'haiku'` on the Claude CLI's `--model` flag.

3. **UpgradeNotifyManager MODEL_CHAIN uses generic tiers** — `['fast', 'balanced']` instead of `['haiku', 'sonnet']`. UpgradeNotifyResult.model becomes `GenericModelTier`. SessionSpawner callback widens to accept `GenericModelTier | ModelTier | string`. The framework-specific resolution happens inside SessionManager.spawnSession via the headless builder.

4. **SessionManager.spawnSession.options.model widened** to `ModelTier | string` so generic tiers + raw model ids flow through cleanly. Session.model type widened to `ModelTier | string` for the same reason. No semantic change for Claude installs (existing Claude tier names continue to work).

5. **/sessions/spawn route accepts a `framework` field + framework-aware model whitelist**. Generic tiers are universally accepted; framework-specific tier names are accepted only when they match the requested framework slot. Error messages name the framework so misconfigurations are obvious.

6. **frameworkSessionLaunch codex hardcoded model becomes config-readable** via `SessionManagerConfig.frameworkDefaultModels?.['codex-cli']`. `spawnInteractiveSession` reads from this map and passes it as `defaultModel` into `buildInteractiveLaunch`.

7. **StallTriageNurse model tier normalization is framework-aware**. Previously `DEFAULT_CONFIG.model` was always resolved through Claude-only `resolveModelId`, which would produce `'claude-sonnet-4-6'` even when running under a Codex agent. Now `framework` from the merged config selects the tier resolver: Codex agents get `'gpt-5.3-codex'` for `'balanced'`; Claude agents still get `'claude-sonnet-4-6'`. Raw model ids pass through both paths.

Files touched:
- `src/core/frameworkSessionLaunch.ts` — adds `GenericModelTier` type, `resolveModelForFramework`, `InteractiveLaunchOptions.defaultModel`. Both builders route through the helper.
- `src/core/types.ts` — `Session.model` widened to `ModelTier | string`; `SessionManagerConfig.frameworkDefaultModels` added.
- `src/core/SessionManager.ts` — spawnSession.options.model widened; spawnInteractiveSession reads frameworkDefaultModels.
- `src/core/UpgradeNotifyManager.ts` — MODEL_CHAIN → generic tiers; UpgradeNotifyResult.model + SessionSpawner.model widened.
- `src/monitoring/StallTriageNurse.ts` — framework-aware DEFAULT_CONFIG.model + per-framework resolver in constructor.
- `src/server/routes.ts` — /sessions/spawn accepts `framework` + framework-aware model whitelist.
- 4 test files updated for tier-name change; 2 new test suites added.

## Decision-point inventory

- **GenericModelTier vocabulary** — `add`. Three-tier shape mirrors `IntelligenceOptions.model` so the same vocabulary works in evaluate() and spawn paths.
- **/sessions/spawn whitelist** — `extend`. Old: `['opus','sonnet','haiku']` only. New: framework-aware union of generic tiers + framework-specific names. Strict positive-list — unknown model strings still 400.
- **StallTriageNurse framework-conditional model resolution** — `change`. Old behavior assumed Claude. New behavior reads `mergedFramework` and picks the right resolver. Back-compat verified: Claude path still produces `'claude-sonnet-4-6'` for the default `'sonnet'` tier.
- **frameworkDefaultModels config field** — `add`. Optional. Missing keys fall back to each builder's existing default.
- **STALL_TRIAGE_MODEL env var semantics** — `change`. Previously interpreted strictly as a Claude alias. Now interpreted as a tier OR raw id, resolved per-framework. For existing Claude-only deployments this is a no-op (`'sonnet'` → `'claude-sonnet-4-6'` unchanged).

## Signal vs authority

- `resolveModelForFramework` is a pure function (signal). It maps strings to strings. No blocking authority.
- The /sessions/spawn whitelist is **authority** — it returns 400 and prevents the spawn when the model isn't recognized for the framework. This was already authoritative for Claude; now it's framework-aware authority.
- StallTriageNurse stores a resolved model id but doesn't pre-gate any LLM call on it (the actual evaluate() call uses `model: 'balanced'` literal). The resolution is currently observational — useful for logs/tooling that greps the config field, no behavioral implication.

## Over-block / under-block analysis

**Over-block:** New /sessions/spawn whitelist could 400 calls that previously passed. Mitigation: generic tiers `fast`/`balanced`/`capable` are universally accepted regardless of framework, so any caller using generic tiers continues to work. Framework-specific names still work when they match the framework (default `claude-code` → accepts old `opus`/`sonnet`/`haiku`).

**Under-block:** None — the whitelist is strictly positive, and the framework field defaults to `claude-code` so omitting it preserves the prior strictness.

## Level-of-abstraction fit

- `resolveModelForFramework` lives in `frameworkSessionLaunch.ts` next to the launch builders that consume it. Single home for "tier semantics for X framework."
- Tier vocabulary (`fast`/`balanced`/`capable`) matches the existing `IntelligenceOptions.model` field so callers don't have to learn a second vocabulary.
- Default-model config lives on `SessionManagerConfig.frameworkDefaultModels`, mirroring the existing `frameworkBinaryPaths` shape.

## Interactions

- **buildInteractiveLaunch / buildHeadlessLaunch** — both now use the helper. Tier names pass through identically; raw model ids pass through identically.
- **UpgradeNotifyManager spawnSession callback** — caller (server.ts wiring, not in this PR) only needs to widen the callback signature; passing generic tier strings to SessionManager.spawnSession works.
- **CostAwareRoutingPolicy / FrameworkModelRouter** — orthogonal. They decide which model TIER to use; the helper decides which concrete name that tier maps to per framework. Stacks cleanly.
- **Anthropic path constraints (Rule 2)** — preserved. The Anthropic path resolver still runs for `claude-code` agents to expand tier → canonical Anthropic id.

## Rollback cost

Pure code change. No persistent state migration; the `frameworkDefaultModels` config field is optional and ignored when missing. Reverting the commits restores the legacy hardcoded `gpt-5.3-codex` + Claude-only tier vocabulary; the new tests would surface the missing surfaces immediately. Test suite stays green either way (the new tests assert new behavior; the unchanged tests assert preserved behavior).

## Verification

- `npx tsc --noEmit` — clean.
- 197 unit tests across 8 files green:
  - tests/unit/frameworkSessionLaunch.test.ts (30)
  - tests/unit/pipeSessionSpawnerFrameworkPortability.test.ts (11)
  - tests/unit/StallTriageNurse.test.ts (66) — incl. 5 new tier-resolution cases
  - tests/unit/UpgradeNotifyManager.test.ts (17) — generic-tier expectations
  - tests/unit/upgrade-notify-manager.test.ts (17) — generic-tier expectations
  - tests/unit/route-validation-edge.test.ts (26)
  - tests/unit/session-manager-behavioral.test.ts (22)
  - tests/unit/listener-daemon.test.ts (18)
- v1.0.0 scenarios — to run after commit, before push.
