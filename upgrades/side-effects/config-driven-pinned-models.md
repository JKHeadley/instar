# Side-Effects Review — Config-driven pinned-model callsites (routing-registry risk items #3/#5/#6/#7)

**Version / slug:** `config-driven-pinned-models`
**Date:** `2026-07-02`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no gate/sentinel/lifecycle surface — pure config plumbing with behavior-preserving defaults)

## Summary of the change

Migrates the hardcoded-model callsites catalogued as "Risk items" #3, #5, #6, #7 in the LLM Routing Registry audit (2026-07-01, operator-directed) to overridable configuration with **behavior-preserving inline defaults** — with no config/env set, every callsite behaves byte-for-byte as before. Files touched: `src/core/types.ts` (new `intelligence.pinnedModels` block, inline-defaulted per the documented codexExecJson/swapAttemptTimeoutMs precedent), `src/core/DispatchExecutor.ts` (optional `agenticModel` ctor option, default 'haiku'), `src/commands/server.ts` (threads `pinnedModels.dispatchAgentic` + `pinnedModels.anthropicCredentialProbe` into the two construction sites), `src/commands/setup-wizard/model-constants.ts` (env-overridable resolvers `INSTAR_WIZARD_CODEX_MODEL` / `INSTAR_WIZARD_GEMINI_MODEL` — env not config because the wizard runs before `.instar/config.json` exists), `src/commands/setup.ts` (duplicate const replaced with import/re-export from model-constants — single source of truth), `src/providers/adapters/anthropic-headless/config.ts` + `control/authCredentialInjection.ts` (new `credentialProbeModel` field; default now sourced from `ANTHROPIC_MODELS.haiku` in `src/core/models.ts` instead of a free-floating string literal), and `tests/unit/pinned-model-callsites.test.ts` (15 new tests).

**Honest scope note:** risk item #4 (mentor loop → opus) required NO code change — it was already config-driven via `mentor.autonomousFix.model` (default 'opus'); the registry row was imprecise. A canary test now pins that fact.

## Decision-point inventory

No decision point is added, modified, or removed. Model *selection inputs* to five existing callsites become configurable; the callsites' logic, gating, and control flow are untouched. All five are pass-through surfaces:

- `DispatchExecutor.runAgentic` — pass-through — spawned-session model tier now `options.agenticModel ?? 'haiku'`.
- `setup-wizard codex narrative spawn` — pass-through — model const now env-resolvable, default unchanged.
- `setup-wizard gemini narrative spawn` — pass-through — same.
- `anthropic-headless credential probe` — pass-through — ping model now `config.credentialProbeModel ?? ANTHROPIC_MODELS.haiku`.
- `server.ts boot wiring` — pass-through — threads the two config keys when present; spreads nothing when absent.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (No input is ever rejected by this change; a nonsense model value in config flows to the underlying spawn/API call, which fails with that layer's existing error surface — same as a nonsense value in any other model config key like `subscriptionPath.model`.)

## 2. Under-block

No block/allow surface — under-block not applicable. One adjacent honest note: this change does NOT validate configured model ids against a known-models list. That is deliberate and consistent with every existing model config key (`sessions.frameworkDefaultModels`, `subscriptionPath.model`, `mentor.autonomousFix.model` — none validate); inventing validation only here would be a new inconsistent behavior surface.

## 3. Level-of-abstraction fit

Right layer. The change follows the established three-layer pattern already used by every other model-selection surface: config type (`types.ts`) → boot threading (`server.ts`) → inline default at the consumption site. The wizard deviation (env var instead of config key) is a deliberate fit-to-layer choice: the wizard runs pre-config by definition, so a config key would be unreadable at its runtime — an env var is the only honest override surface there, and the config docblock documents the split. The credential-probe default moving to `ANTHROPIC_MODELS.haiku` removes a string literal that could silently drift from the tier map (registry risk item #8's concern).

## 4. Signal vs authority compliance

Compliant — trivially. No signal is produced, no authority is held, no brittle check is added anywhere. (Reference: docs/signal-vs-authority.md.)

## 5. Interactions

- **Tier maps / escalation:** `dispatchAgentic` feeds `SessionManager.spawnSession({model})` exactly as the literal did; tier escalation and topic-profile resolution operate on spawned *conversation* sessions, not this job-slugged dispatch session — no new interaction.
- **componentFrameworks routing:** untouched — these callsites were router-bypasses before and remain framework-pinned; only the *model value* became configurable. (Making them router-routed was considered and rejected for this change: dispatch/wizard/probe are structurally tied to their frameworks. The v2 bench routing pass may revisit.)
- **Canary tests:** `setup-codex-model-canary.test.ts` still passes unmodified — the const-shape contract (`-m WIZARD_CODEX_MODEL` on every codex spawn; pinned to a subscription-supported model) is preserved by computing the const through the resolver at module load.
- **No double-fire / shadow / race surface:** nothing fires.

## 6. External surfaces

None. No user-visible output changes, no API shape changes, no cross-agent surface. The probe ping still sends 4 max_tokens to the same endpoint with the same default model id.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** `intelligence.pinnedModels` lives in `.instar/config.json`, which deliberately does not sync across machines (same posture as every other `intelligence.*` key — each machine's operator tunes its own routing). The wizard env vars are process-local by nature. No durable state, no user-facing notices, no generated URLs.

## 8. Rollback cost

Trivial. Remove the config key / env var → shipped defaults apply immediately (next boot for config, next wizard run for env). Reverting the commit restores literals with zero data migration — no persisted state depends on the new keys (inline-defaulted precisely so absence is the default state; nothing was added to ConfigDefaults/migrateConfig, so no migration parity work is owed).

## Test evidence

`tests/unit/pinned-model-callsites.test.ts` — 15 tests: both sides of every boundary (absent ⇒ shipped default, present ⇒ override wins, whitespace ⇒ absent) for all three migrated surfaces, wiring canaries asserting server.ts actually threads both config keys, and the mentor already-config-driven canary. Plus `setup-codex-model-canary.test.ts` (5 tests) unmodified and green. `npx tsc --noEmit` clean.
