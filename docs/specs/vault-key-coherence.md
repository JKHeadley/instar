---
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
review-convergence: "rev-1 — the CMT-1038 root-cause fix for the recurring secret-invisibility disease (2026-06-05 incident: a machine-global keychain entry shared by every agent, silently overwritable by any fresh-stateDir SecretStore, bifurcated the vault into keychain-readers seeing 'empty' and file-readers seeing data). Three surgical layers: per-agent keychain accounts with legacy adoption; a key-id header (v2 format, v1 reads preserved) making wrong-key vs corruption diagnosable; dual-key read fallback with loud degradation and natural convergence on the next write. Crypto unchanged (AES-256-GCM); no defaults weakened; keychain ops made injectable so the logic is testable without touching a real keychain."
approved: true
approved-by: "operator (Justin) — standing mandate to fix the recurring secret loss (2026-06-04 topic 13481: 'this issue of dropping the secret has happened MANY MANY TIMES and we need to fix this') + the 2026-06-05 12h autonomous mandate; follow-up commitment CMT-1038 opened with his knowledge in the PR #789 report"
approved-at: "2026-06-05T06:51:00Z"
---

# Vault Key Coherence — one agent, one key, diagnosable always

**Status:** Approved 2026-06-05. Implementing.
**Author:** Echo
**Companion:** vault-key-coherence.eli16.md
**Trigger:** CMT-1038. The 2026-06-05 incident: `instar-secret-store`/`master-key`
is MACHINE-GLOBAL — one keychain slot shared by every agent and process on the
box — while the file fallback key is per-agent. Any SecretStore constructed
against a fresh stateDir generated a new key and silently OVERWROTE the global
slot, instantly making every keychain-resolving reader see its vault as
"empty" while file-key readers still saw the data. PR #789 made tests unable
to trigger it; this PR removes the disease.

## The three layers

### 1. Per-agent keychain accounts (+ legacy adoption)

`KEYCHAIN_ACCOUNT` becomes per-agent: `master-key:<stateDir>` (the absolute
stateDir path — readable, unique, debuggable in Keychain Access). Resolution
order on read:
1. the per-agent entry;
2. the LEGACY global entry (`master-key`) — if present, it is ADOPTED: copied
   into the per-agent account (the global entry is left in place for other
   not-yet-migrated agents; it is never written again by this code);
3. the per-agent file key.

Generation (no key anywhere) writes the per-agent account — never the global
one. Combined with the #789 test guard, no code path writes the global slot
again.

### 2. Key-id header — v2 store format (v1 reads preserved)

New writes: `'ISv2' (4) | keyId (8 = sha256(key)[0..8]) | iv (12) | tag (16) | ciphertext`.
Reads:
- v2 file → try the resolved candidate keys; only a key whose sha256 prefix
  matches `keyId` is attempted; no candidate matches → a PRECISE error
  ("encrypted with key id <hex>; available keys: <hexes>") — wrong-key is now
  diagnosable and distinct from corruption (GCM auth failure with the
  MATCHING key = corruption).
- v1 file (no magic) → legacy path + layer 3 fallback.

### 3. Dual-key read fallback + loud degradation + natural convergence

`MasterKeyManager.getCandidateKeys()` returns `[primary, ...alternates]`
(alternates = the other source, read-only — NEVER generates). `read()` tries
the primary, then alternates; success via an alternate emits a
DegradationReporter report ("vault decrypts with the <source> key but primary
resolution is <source> — key sources diverged") and surfaces
`lastReadKeySource` for observability. Convergence happens naturally: the next
`write()`/`set()` re-encrypts v2 with the PRIMARY key — after which both
sources agree (per-agent adoption makes the primary stable).

`GET /secrets/sync-status` distinguishes decrypt-failure from empty: a read
that throws yields `vaultStatus: 'decrypt-failed'` + the precise error instead
of silently reporting `localKeyPaths: []` (the masking that hid the incident).

## Testability seam

Keychain ops (`read/write` per account) become injectable
(`SecretStoreConfig.keychainOps`) so adoption/per-agent logic is unit-tested
against a fake — the #789 VITEST file-key guard still forces file mode
whenever keychainOps is NOT injected, so no test can ever touch the real
keychain.

## Backward compatibility

- v1 files read forever; v2 written on the next write. Echo's live vault
  (file-key, v1) reads unchanged; first write upgrades it to v2.
- Agents still on the legacy global keychain entry adopt it on first read —
  no operator action, no migration step (resolution-time adoption).
- `forceFileKey` (config + tests) behavior unchanged.

## Tests (unit — the crypto/resolution layer is pure given the seam)

v2 roundtrip; v1 blob reads; v2 wrong-key error names the key ids; corruption
with the matching key still throws GCM auth error; dual-key fallback both
directions + degradation surfaced + lastReadKeySource; write-after-fallback
converges to primary (v2, primary keyId); per-agent account preferred; legacy
adoption copies to per-agent + never writes global; generation writes
per-agent only; keychainOps-absent test runs stay file-key (the #789 guard).
Integration: sync-status decrypt-failed vs empty. <!-- tracked: CMT-1038 -->
