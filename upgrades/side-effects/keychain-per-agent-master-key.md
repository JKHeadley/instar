# Side-Effects Review — Secrets boot guard + orphan-proof stores

**Version / slug:** `keychain-per-agent-master-key`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `codex gpt-5.5 adversarial spec review (SHIP-WITH-CHANGES, all 8 required changes applied); re-scoped after PR #810 landed the SecretStore layer in parallel — surviving sections were part of the converged design`

## Summary of the change

Closes the remaining layers of the 2026-06-05 keychain master-key poisoning incident (Echo boot crash-loop, ~25 min Telegram mute) that PR #810 (vault-key-coherence) did not cover: `loadConfig` reports merge failures via DegradationReporter and fails the boot fast when `{secret:true}` placeholders survive in boot-critical fields; `GlobalSecretStore.initWithKeychain` refuses to generate over existing ciphertext; `SecretManager` local-store catches report instead of silently returning null/{}; `migrateSecrets` drops the `forceFileKey` write/read asymmetry.

## Decision-point inventory

- `Config.loadConfig` — modified — merge catch reports via DegradationReporter; `assertNoCriticalSecretPlaceholders` fails boot on surviving placeholders in ENABLED adapters' required secret fields (telegram token/chatId, slack botToken/appToken) or authToken when binding non-loopback.
- `GlobalSecretStore.initWithKeychain` — modified — generation guard over existing ciphertext (report + stay locked, never orphan); injectable exec for hermetic tests.
- `SecretManager.get/set/getAllFromLocal` — modified — failures reported via `reportLocalStoreFailure`, behavior (degrade) unchanged.
- `SecretMigrator.migrateSecrets` — modified — drops `forceFileKey: true` (writes resolve through the same key resolution as reads).

## 1. Over-block

The boot guard could block a boot that previously "worked" in a degraded state (placeholders present but the adapter happened to be broken anyway). That is intentional: the previous behavior was a 2-minute zombie boot ending in `tokenHash(Object)`. Scope is narrowed to enabled adapters' required fields + conditional authToken; disabled adapters and unknown fields never block (codex review changes #5/#6). Verified by integration tests on both sides of each boundary.

## 2. Over-permit

None added. The generation guard strictly REMOVES a permissive path (fresh key over existing ciphertext). The boot guard never relaxes any existing check.

## 3. Interplay with the parallel fixes (#810, #802, #789)

- **#810 (vault-key-coherence)** owns SecretStore: per-agent accounts (`master-key:<stateDir>`), keyId header, dual-key fallback, convergence-on-write. Its named wrong-key error flows verbatim into this PR's actionable boot failure — the two compose: #810 makes most key divergence self-heal; when nothing decrypts, this PR makes the failure fast and precise instead of a placeholder leak.
- **#802** guards the CONSUMER side (TelegramAdapter string-shape checks). This PR guards the PRODUCER side (config load). #802's PR body names this spec as the owner of the config layer.
- **#789/#810's VITEST guard** keeps test runs file-key-only; this PR's tests never touch the real keychain (GlobalSecretStore tests use the injectable exec / password-mode seeding; the real-keychain generation test is darwin-scoped `skipIf`).

## 4. Failure modes

- No key decrypts a store → #810 throws its named error → merge catch reports → boot guard throws the actionable message naming fields (never silent placeholders).
- Secrets genuinely absent (fresh agent, no migration) → no placeholders in config → guard never fires → zero change.
- GlobalSecretStore keychain entry vanishes with data present → store stays LOCKED with a report instead of silently orphaning data behind a fresh key.
- Loopback-only agent with an authToken placeholder → degrade-with-report (boot proceeds) — matches the existing non-loopback-only criticality condition.

## 5. Migration parity

No installed-file/config-shape changes — `PostUpdateMigrator` untouched by design. The boot guard activates purely from existing on-disk state.

## 6. Token/cost impact

None. No LLM calls; one config-tree scan at boot (microseconds).

## 7. Rollback

Revert the commit. All four changes are behavior-narrowing or report-only; no data format changes, nothing re-encrypted. Old behavior (silent catch, generate-on-miss) returns exactly as before.
