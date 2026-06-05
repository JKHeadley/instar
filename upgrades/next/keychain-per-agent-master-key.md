<!-- bump: patch -->

# Secrets boot guard + orphan-proof stores

## What to Tell Your User

Nothing user-visible in normal operation. The remaining layers of the 2026-06-05 secrets incident are closed: an undecryptable secret store now stops the boot immediately with a precise, actionable error (instead of a confusing crash-loop minutes later), and the shared secret vault can no longer orphan existing data by generating a fresh key over it.

## Summary of New Capabilities

- Boot fails fast with an actionable message when secrets cannot be resolved for boot-critical fields (enabled messaging adapters' tokens; authToken when binding non-loopback) — never a placeholder-driven type-error crash minutes later.
- `mergeConfigWithSecrets` failures are reported through DegradationReporter instead of an empty catch.
- The user-global secret store refuses to generate a new key over existing encrypted data it would orphan; it reports and stays locked instead.
- Local secret-store failures in SecretManager are reported instead of silently returning empty results.
- `migrateSecrets` writes with the same key resolution the boot read path uses (no manufactured key divergence).

## What Changed

`Config.loadConfig` (loud merge failure + critical-placeholder boot guard `assertNoCriticalSecretPlaceholders`), `GlobalSecretStore.initWithKeychain` (generation guard, injectable exec), `SecretManager` (reported degradations), `SecretMigrator` (drops `forceFileKey`). Complements #810 (vault-key-coherence — per-agent keychain slots, keyId header, dual-key reads), which owns the SecretStore layer. Spec: `docs/specs/keychain-per-agent-master-key.md`.
