---
status: approved
parent-principle: "Structure beats Willpower"
review-convergence: "codex gpt-5.5 adversarial review, 2026-06-05: SHIP-WITH-CHANGES with 8 required changes — all folded in (marked ◆). Re-scoped 2026-06-05 after PR #810 (vault-key-coherence) landed the SecretStore core in parallel; the surviving sections below were part of the converged design and are unchanged in substance."
approved: true
approved-by: "Echo under Justin's standing build-and-ship preapproval (fleet-critical incident fix: the 2026-06-05 keychain poisoning boot crash-loop; incident + fix plan reported to topic 13435 before build)"
approved-at: "2026-06-05T07:15:00Z"
---

# Secrets Boot Guard + Orphan-Proof Stores (keychain-incident complement)

> **Status:** Converged spec (Tier-2), RE-SCOPED. The original design covered the full incident; mid-build, a parallel session shipped **PR #810 (`docs/specs/vault-key-coherence.md`)** — per-agent keychain accounts (`master-key:<stateDir>`), a self-describing v2 vault format with keyId header, dual-key read fallback, and convergence-on-write — which owns the `SecretStore`/`MasterKeyManager` layer. This spec now covers ONLY the complementary layers #810 did not touch. PR #802 (consumer-side placeholder guards) names this spec as the owner of the config layer.
> **Tracks:** task #74 — the 2026-06-05 keychain master-key poisoning incident (Echo boot crash-loop, ~25 min Telegram mute).
> **Earned from:** a machine-global keychain entry (`instar-secret-store`/`master-key`) created at 06:33:09Z with a freshly-generated key shadowed Echo's per-agent file key; AES-GCM decryption of Echo's secret stores failed; an empty catch swallowed the failure; `{secret:true}` placeholders leaked into the runtime config; the server crash-looped on `tokenHash(Object)` two minutes after the real failure point.
> **Trigger confirmed (via #789, independently diagnosed):** a TEST RUN constructed a `SecretStore` against a fresh stateDir, hit generate-on-miss, and wrote the fresh key into the shared slot.

## Division of labor across the incident's fixes

| Layer | Fix | PR |
|---|---|---|
| Keychain slot collision + wrong-key reads | per-agent accounts, keyId header, dual-key fallback, convergence | **#810** (parallel session) |
| Test runs touching the real keychain | VITEST file-key guard (injected-fake exemption) | **#789** + #810 |
| Consumer-side placeholder crash (Telegram adapter) | string-shape guards, no crash-loop / 404-zombie | **#802** |
| **Silent merge failure → placeholder leak → late crash** | **loud merge failure + critical-placeholder boot guard** | **this spec** |
| **GlobalSecretStore generate-on-miss orphaning** | **generation guard over existing ciphertext** | **this spec** |
| **SecretManager silent decrypt catches** | **report-then-degrade** | **this spec** |
| **Migrator write/read key asymmetry** | **drop `forceFileKey` from `migrateSecrets`** | **this spec** |

## Problem (remaining, post-#810)

1. **The merge failure is silent and the symptom is far from the cause.** `loadConfig` wraps `mergeConfigWithSecrets` in an empty catch ("non-fatal"). When decryption fails — for ANY reason, including ones #810's dual-key fallback cannot save (no candidate key decrypts, corrupted store, unreadable file) — `{secret:true}` placeholder objects flow into runtime config and the process crashes minutes later on an unrelated-looking type error (`tokenHash(Object)`, `Invalid Telegram chatId "[object Object]"`), or worse, limps along with broken messaging.

2. **`GlobalSecretStore.initWithKeychain` generates over existing data.** When the keychain entry is missing but `global.secrets.enc` exists, it generates a FRESH key — silently orphaning the existing ciphertext (the self-poisoning variant of the incident).

3. **`SecretManager`'s decrypt catches are silent.** Local-store failures return `{}`/null with no report — indistinguishable from "no secrets stored."

4. **`migrateSecrets` writes with `forceFileKey: true`** while boot reads resolve keychain-first — manufacturing key-source divergence at migration time. Post-#810 this is self-healing but still noisy (a degradation report per read until a write converges); not manufacturing the divergence is strictly better.

## Design

### 1. Loud merge failure (kill the silent placeholder leak)

`loadConfig`'s `mergeConfigWithSecrets` catch:

- Always report the failure through `DegradationReporter` (component `secret-merge`), never an empty catch.
- ◆ After the merge attempt, scan the merged config for REMAINING `{secret:true}` placeholders in a **narrow, known-critical set**: for each **enabled** messaging adapter only, the fields that the adapter constructor requires as strings (telegram: `token`, `chatId`; slack: `botToken`, `appToken`). `authToken` is critical only when the server binds non-loopback (the existing Config.ts warning condition) — loopback-only agents degrade-with-report instead. Disabled adapters and unknown/optional fields NEVER fail the boot; they report.
- If a critical placeholder remains: **fail the boot immediately** with an actionable message naming the fields and the decrypt error (e.g. `Secrets cannot be resolved for boot-critical config fields: messaging[0].config.token … See docs/specs/keychain-per-agent-master-key.md#recovery.`). A fast, clear boot failure beats a 2-minute zombie boot that crashes on a type error. #810's named wrong-key error (`encrypted with key id …; the vault is NOT empty`) flows into this message verbatim.

### 2. GlobalSecretStore generation guard ◆

`GlobalSecretStore`'s default store (`~/.instar/secrets/global.secrets.enc`) is **deliberately user-global** — one shared cross-agent registry, so its single keychain account (`instar-global-secrets`/`master-key`) maps 1:1 to one store and is NOT the per-agent flaw. Its real gap is **generate-on-miss orphaning**: `initWithKeychain` generates a FRESH key when the keychain entry is missing — even when `global.secrets.enc` already exists. THIS spec adds: (a) a generation guard — never generate when an encrypted store exists and the available key fails to authenticate it; report loudly and stay LOCKED instead; (b) an injectable keychain exec for hermetic tests. Per-agent account scoping is explicitly NOT applied here (would break the shared-store design).

### 3. SecretManager report-then-degrade

`SecretManager.get/set/getAllFromLocal` failures route through a `reportLocalStoreFailure` helper (DegradationReporter under the hood); the degrade behavior (return null/`{}`) is unchanged — the failure is just no longer invisible.

### 4. Migrator write/read symmetry

`migrateSecrets` drops `forceFileKey: true` — writes resolve through the same key resolution as reads (#810's). In test runs the VITEST guard keeps it file-only regardless.

## Non-goals

- Anything in `SecretStore`/`MasterKeyManager` itself — owned by #810 (vault-key-coherence).
- Cross-machine key sync; re-encrypting existing stores; rotating compromised keys.

## Testing (3-tier)

- **Unit (`tests/unit/global-secret-store.test.ts`):** the generation guard — no fresh key over existing ciphertext (reported + locked); generate-on-true-first-run only (darwin-scoped where the real keychain path is exercised); orphan-guard seeded via `initWithPassword` (platform-independent).
- **Integration (`tests/integration/config-critical-secret-placeholders.test.ts`):** green-path roundtrip (migrate → boot → strings); the incident shape (undecryptable store → actionable throw naming fields); disabled adapter never throws; authToken loopback/non-loopback boundary; placeholder-free config never trips the guard.
- **E2E (`tests/e2e/secret-key-resolution-lifecycle.test.ts`):** the production `loadConfig` boot path over an init-shaped project with real migrated secrets — boots healthy; with a sabotaged key fails FAST with the actionable message (assert the message, not a type-error crash); recovers immediately when the key is restored.

## Recovery (operator notes)

If an agent fails boot with the secrets-cannot-be-resolved error: the per-agent file key (`<stateDir>/machine/secrets-master.key`, hex) is the usual truth — delete the per-agent keychain entry (`security delete-generic-password -s instar-secret-store -a "master-key:<abs stateDir>"`) and reboot; #810's resolution falls back to the file key and re-adopts. Keychain values are base64; file values are hex.

## Blast radius

`Config` load path (every agent boots through this) + `GlobalSecretStore`/`SecretManager` (vault paths). Mitigations: the boot-guard only fires when placeholders actually remain in critical fields (agents without secrets see zero change); the generation guard only changes behavior in the data-losing case (existing ciphertext + missing key); SecretManager behavior is report-only. No migration entry needed (no config-shape change).
