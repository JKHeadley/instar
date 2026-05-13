# NEXT — upcoming release notes

Entries here ship in the next release. Move them into the versioned upgrade
note (`upgrades/<version>.md`) at release-cut time.

---

## What Changed

### F-1 — RemediationKeyVault (Tier-1 foundation for Self-Healing Remediator)

- **Adds** `src/remediation/RemediationKeyVault.ts` — per-context, per-scope
  HKDF-SHA256 leaf-key derivation with a 4-backend secret store (OS keychain,
  hardware enclave stub, cloud KMS stub, env-passphrase + AES-256-GCM flatfile).
- Per amendments A20, A23, A39, A42, A51, A54, A58, A62 of
  `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`.
- **No runtime consumers yet.** F-2+ wires capability tokens, probe
  authentication, in-flight lockfiles, the cross-process attempt ledger, and
  the audit-token writer onto the leaf-key surface.
- **Operational notes.** On macOS and Linux+libsecret hosts the vault uses the
  OS keychain (entries under `ai.instar.remediation.*`). On headless or
  containerized hosts, set `INSTAR_REMEDIATION_KEY_PASSPHRASE` and the vault
  stores keys in an AES-256-GCM-encrypted flatfile at
  `<stateDir>/remediation-keys.age` (`.age` is forward-compat naming; the inner
  format is Node-native AES-GCM, NOT the `age` library).
- **Known follow-ups.** A39's per-binary-path keychain ACL
  (`SecAccessCreateWithOwnerAndACL`) is NOT applied in F-1 — entries use the OS
  default ACL. F-2 layers the scoped ACL via a native binding. Hardware-enclave
  and cloud-KMS backends are explicit stubs; F-2+ implements detection and
  key-wrapping for TPM 2.0 / Secure Enclave / AWS-KMS / GCP-KMS / Azure-Key-Vault.

## What to Tell Your User

Nothing user-visible yet. F-1 is plumbing for the Self-Healing Remediator —
later phases (F-2 through F-7) will surface user-facing capabilities (automatic
detection and repair of broken instar features). If a user asks "what does this
release do for me?" the honest answer is: "It lays the cryptographic foundation
so future self-healing features can prove which probe ran, which capability
detected a fault, and which agent attempted a repair — without those proofs
being forgeable."

Operators running on headless Linux without libsecret should set
`INSTAR_REMEDIATION_KEY_PASSPHRASE` in their environment before any F-2+ feature
ships. macOS users and Linux users with libsecret installed have nothing to do.

## Summary of New Capabilities

- **`RemediationKeyVault`** — programmatic API for deriving 32-byte HKDF-SHA256
  leaf keys scoped to one of five contexts (`capability`, `probe`, `inflight`,
  `ledger`, `audit`) and an opaque scope id. Same `(context, scopeId)` → same
  key, deterministically; rotating the install nonce or a context master
  invalidates the corresponding leaves.
- **4-backend secret store** — OS keychain (macOS `security`, Linux
  `secret-tool`) is preferred; hardware-enclave and cloud-KMS are stubbed for
  Tier-1; env-passphrase + AES-256-GCM flatfile at
  `<stateDir>/remediation-keys.age` is the fallback.
- **Install nonce** — 256-bit random anchor stored under
  `ai.instar.remediation.install-nonce`; auto-initialized on first boot,
  fail-closed if missing on an existing install.
- **No runtime wiring yet.** Module ships behind no callers — F-2 is the first
  consumer.
