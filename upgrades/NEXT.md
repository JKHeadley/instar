# NEXT — upcoming release notes

Entries here ship in the next release. Move them into the versioned upgrade
note (`upgrades/<version>.md`) at release-cut time.

---

## F-1 — RemediationKeyVault (Tier-1 foundation for Self-Healing Remediator)

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
