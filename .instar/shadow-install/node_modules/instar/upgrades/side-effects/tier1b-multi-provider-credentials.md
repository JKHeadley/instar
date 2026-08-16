# Side-effects review — Tier 1.B multi-provider credentials

**Version / slug:** `tier1b-multi-provider-credentials`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive shape with backwards-compat migration, complete branch coverage in unit tests)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (the spine of multi-provider — was previously locked to a single `anthropicApiKey` field)

## Summary of the change

The audit identified `config.sessions.anthropicApiKey` as the spine of single-provider lock-in: every spawn path threaded that one field through, and there was no shape for "I have an OpenAI key for Codex AND an Anthropic OAuth token for Claude."

This change adds the multi-provider credentials structure without breaking existing installs:

1. **New types** in `src/core/types.ts`:
   - `ProviderCredentialKind = 'oauth-token' | 'api-key'`
   - `ProviderCredential = { kind, value, baseUrl? }`
   - `SessionManagerConfig.credentials?: Record<string, ProviderCredential>` (keys = provider ids)
   - `anthropicApiKey` / `anthropicBaseUrl` marked `@deprecated` but still readable for backwards-compat.

2. **New helpers** in `src/core/Config.ts`:
   - `buildCredentialsMap(sessionsConfig)`: migrates legacy fields into the new map at load time.
   - `getProviderCredential(config, providerId)`: lookup that consults the map first and falls back to the legacy field for 'anthropic' so existing installs keep working.
   - `buildProviderEnvFlags(providerId, credential)`: maps a credential to the right env vars for tmux spawn. Knows Anthropic (oauth-token vs api-key with mutual exclusion + base-URL), OpenAI/Codex (api-key only — Codex uses auth.json for OAuth), Google/Gemini. Unknown providers return empty (safe no-op).

3. **Config loader** now populates `credentials` at load time via migration.

Existing SessionManager spawn paths still reference `this.config.anthropicApiKey` directly — they will be migrated to use `getProviderCredential('anthropic')` and `buildProviderEnvFlags('anthropic', cred)` in a subsequent slice. The new helpers are in place; consumers swap over incrementally so no spawn-path behavior changes today.

Files touched:
- `src/core/types.ts` — new `ProviderCredentialKind`, `ProviderCredential` types; `SessionManagerConfig.credentials` field + deprecation notes on legacy fields.
- `src/core/Config.ts` — `buildCredentialsMap`, `getProviderCredential`, `buildProviderEnvFlags`. Loader populates `credentials` from legacy fields.
- `tests/unit/providerCredentials.test.ts` — new, 14 cases.

## Decision-point inventory

- **Credential lookup** — `add`. New surface: `getProviderCredential(config, providerId)`. Existing callers that read `config.anthropicApiKey` directly keep working — they read the legacy field. New code uses the helper.
- **Env-var injection mapping** — `add`. New surface: `buildProviderEnvFlags(providerId, cred)`. Existing inline mapping in SessionManager (lines 684-686 and 1279-1281) keeps working — they'll be migrated in the next slice.
- **Config schema** — `extend`. New optional `credentials` field. Legacy fields preserved with deprecation notice.

## Signal vs authority

These are utility functions and a data shape. No authority surface. SessionManager remains the spawn-time authority; this slice gives it cleaner data to consult.

## Over-block / under-block analysis

**Over-block:** None. The legacy fields still flow through as before. New code that hasn't migrated yet doesn't see any change.

**Under-block:** Migration is incremental. Until SessionManager's spawn paths consume `getProviderCredential` + `buildProviderEnvFlags`, the single-provider lock-in is structurally unchanged for spawned subprocesses — the change is purely additive infrastructure. The credentials helper exists but isn't called from any production path yet. Documented in the JSDoc.

## Level-of-abstraction fit

- Provider ids are strings (e.g. `'anthropic'`, `'openai'`, `'google'`). Matches the existing `ProviderId` brand used in `src/providers/`. No new id system.
- Credential kind (oauth-token vs api-key) is the minimum discriminator that drives different env-var behaviors. Adding more kinds (PAT, JWT) is additive — `ProviderCredentialKind` is a union, extend it.
- Provider-specific env mapping lives in one switch statement in `buildProviderEnvFlags`. New providers: add a case branch.

## Interactions

- **`SessionManagerConfig` consumers** (SessionManager, Config loader, server.ts, tests) — unchanged signatures. New `credentials` field is optional.
- **SessionManager spawn paths** at lines 684-686 and 1279-1281 — UNCHANGED in this slice. Migration to the new helper happens in a follow-up to avoid breaking behavior under load.
- **`buildCredentialsMap` legacy migration** — fires at every config load. Idempotent (only fills in if not explicitly set).
- **No existing source files MODIFIED except the additive ones** noted above.

## External surfaces

- New exports: `ProviderCredentialKind`, `ProviderCredential` (types); `getProviderCredential`, `buildProviderEnvFlags` (functions).
- New optional `credentials` field on `SessionManagerConfig`.
- The legacy `anthropicApiKey` / `anthropicBaseUrl` fields are still part of the public type but now JSDoc-marked `@deprecated` with v1.0.0 migration guidance.

## Rollback cost

Trivial. `git revert` removes one new test file + the additions to types.ts / Config.ts. No production callsites consume the new helpers yet; nothing breaks.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providerCredentials.test.ts` — 14/14 pass.
- Coverage: legacy migration (3 cases), credentials-map-wins-over-legacy, oauth-detection from `sk-ant-oat` prefix, baseUrl propagation, unknown-provider null, env-flag building for anthropic (oauth + api-key + baseUrl), openai api-key, openai oauth (no env emitted), google api-key, unknown-provider safe-no-op.
- No real-API verification needed — pure type + utility surface.
