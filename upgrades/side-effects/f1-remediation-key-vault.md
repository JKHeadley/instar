# Side-Effects Review — F-1 RemediationKeyVault

**Version / slug:** `f1-remediation-key-vault`
**Date:** 2026-05-13
**Author:** echo (instar-developing agent)
**Second-pass reviewer:** not required

## Summary of the change

This change adds `src/remediation/RemediationKeyVault.ts`, the Tier-1 cryptographic
foundation for the Self-Healing Remediator (per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`,
amendments A20, A23, A39, A42, A51, A54, A58, A62). The module exposes a
per-context, per-scope HKDF-SHA256 leaf-key derivation surface backed by a
4-backend secret store (OS keychain → hardware enclave stub → cloud KMS stub →
env-passphrase + AES-256-GCM flatfile). It also adds
`tests/unit/RemediationKeyVault.test.ts` (20 tests).

Files touched: `src/remediation/RemediationKeyVault.ts` (new),
`tests/unit/RemediationKeyVault.test.ts` (new), `upgrades/NEXT.md` (release-note
entry), this artifact.

The module is **not yet consumed** by any runtime path. F-2+ wires the Remediator's
dispatch, probe, in-flight, ledger, and audit surfaces to derive leaf keys via this
vault. F-1 ships the foundation in isolation so it can be exercised in tests and
reviewed against the spec before downstream consumers depend on it.

## Decision-point inventory

- `RemediationKeyVault.forStateDir / selectBackend` — **add** — selects which secret
  backend (keychain / hardware-enclave / cloud-KMS / env-passphrase) the vault uses.
  This is a configuration decision, not a security gate: it does not block any
  inputs, it picks where keys live.
- `loadOrInitKeychain / loadOrInitFlatFile` — **add** — fresh-install vs.
  pre-existing-install branching. The fail-closed paths (partial-master,
  install-nonce-missing-on-existing-install) refuse to start the vault, which is
  authority. See section 4 for signal-vs-authority analysis.
- `deriveLeafKey` — **add** — pure function over (master, nonce, info). No
  decision-point surface; refuses only on `info.length > 1024` (Node HKDF cap).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- `RemediationKeyVault.forStateDir` with no keychain available and no env
  passphrase configured throws `no-backend-available`. Legitimate but
  mis-configured deployments (e.g., a fresh Docker container forgetting to set
  `INSTAR_REMEDIATION_KEY_PASSPHRASE`) will fail to start. This is intentional
  per A62 — the alternative is silently running with no secret store, which is
  worse — but the error message must guide the operator. The error explicitly
  names the missing requirement; downstream callers should surface this to the
  operator via existing alert paths.

- `partial master state` (some context masters exist, others don't) refuses to
  load. This will only fire if a manual keychain edit deleted some entries, or
  if a previous `rotateContext` crashed mid-write. Recovery is to delete the
  remaining entries and let the loader mint a fresh install. F-2 should add an
  `instar remediation reset` CLI; for F-1, the operator can use the `security`
  CLI directly.

## 2. Under-block

**What failure modes does this still miss?**

- F-1's keychain ACL is the OS default ("any process owned by user"), NOT the
  per-binary-path ACL described in A39. A39 specifies
  `SecAccessCreateWithOwnerAndACL` scoped to the agent binary path; this requires
  the macOS `Security.framework` native binding (not exposed via the `security`
  CLI). F-1 ships the multi-backend abstraction; F-2 layers the scoped ACL on top
  via a native module. Same-uid attacker can still read keychain entries on
  macOS with the default ACL. Documented as a follow-up in NEXT.md.

- The hardware-enclave and cloud-KMS backends are explicit stubs that return
  `false` from their availability probes. They never fire in F-1; everyone runs
  on keychain or env-passphrase. F-2+ implements detection + key wrapping for
  TPM 2.0 and the three cloud providers.

- The flatfile is named `<stateDir>/remediation-keys.age` for forward
  compatibility, but uses Node's built-in AES-256-GCM (scrypt KDF), NOT the `age`
  format. Operators expecting `age decrypt` to work on the file will be surprised.
  The file's JSON payload self-identifies (`version: 1, kdf: 'scrypt'`); the
  naming is documented in the source comment block.

- The fresh-install branch mints the install nonce unconditionally when no
  masters exist. A malicious deletion of all keychain entries would let an
  attacker force the vault to mint a NEW install nonce, invalidating all
  previously-signed tokens — but this is the documented A39/A51 recovery shape
  (rotate-install-nonce CLI), not a vulnerability. Callers that need to detect
  "this is supposed to be an existing install" pass `freshInstallGate: false`,
  which refuses to mint.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. This module is the cryptographic primitive layer — a pure HKDF derivation
over a deterministic secret store. It has no awareness of Remediator concepts
(runbooks, probes, surfaces). Higher-level F-PRs (F-2 capability-token issuer,
F-3 probe registry, F-4 in-flight lockfile authority) compose this primitive
into their own authority paths.

The 4-backend abstraction deliberately reuses the pattern from
`src/core/WorktreeKeyVault.ts` (per A39's prior-art note) rather than
introducing a parallel secret-storage system. The two vaults share the
keychain-CLI wrappers (`security` on macOS, `secret-tool` on Linux) and the
flatfile + scrypt + AES-GCM pattern, but are otherwise independent — they store
different key material under different keychain services
(`instar.parallel-dev` vs `ai.instar.remediation`).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic — STOP.

`RemediationKeyVault` is a cryptographic primitive. It does not classify
messages, gate dispatch, or filter actions. The only "refusals" it makes are:

1. Backend unavailable + no fallback configured → throw (operator-visible
   configuration error, not a signal-vs-authority decision).
2. Partial-master state → throw (state-integrity refusal; the keychain has been
   tampered with or a write crashed mid-flight).
3. Install-nonce missing on a pre-existing install → throw per A51 (this is the
   "fail-closed" leg of the documented recovery shape).

None of these are heuristic message classifiers; they are deterministic checks
on persisted state. The signal-vs-authority principle applies to higher-level
F-PRs that consume the derived leaf keys (capability-token verification,
probe-event signature verification, etc.). Those are out of scope for F-1.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** No existing path uses `ai.instar.remediation.*` keychain
  entries; this is a fresh namespace. The vault is a peer of, not a successor
  to, `WorktreeKeyVault`.
- **Race with adjacent cleanup:** `rotateInstallNonce` overwrites the in-memory
  nonce in place to keep references consistent. A concurrent
  `deriveLeafKey` call mid-rotation will observe either the old or new nonce
  (Node single-threaded JS — no torn reads on the Buffer copy). Downstream
  callers needing strict ordering must serialize their rotation through a
  promise lock at their level. F-2 owns this concern.
- **Heartbeat / lifecycle interaction:** None. The vault does not own any
  timers, intervals, or fs watchers.

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- **Keychain entries added:** `ai.instar.remediation.install-nonce`,
  `ai.instar.remediation.capability`, `ai.instar.remediation.probe`,
  `ai.instar.remediation.inflight`, `ai.instar.remediation.ledger`,
  `ai.instar.remediation.audit`. Six entries per machine. Users may see these
  in `Keychain Access.app`. They are only created when a downstream consumer
  (F-2+) instantiates the vault — F-1 alone does not seed them outside of test
  runs (tests use the env-passphrase flatfile via `tmpdir`).
- **Flatfile path:** `<stateDir>/remediation-keys.age` when env-passphrase mode
  is active. `0600` permissions. The `.age` suffix is forward-compat naming;
  the inner payload is Node-native AES-GCM.
- **Env var:** `INSTAR_REMEDIATION_KEY_PASSPHRASE`. Read at vault load time.
  Documented in the source.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

F-1 ships an unused module. No runtime path consumes it yet. Rollback is
`git revert` on the F-1 PR, no data migration, no agent state repair. The six
keychain entries (when minted by tests on a developer's machine) can be left
in place; they are inert without a consumer.

When F-2+ ships and consumers depend on the vault, rollback cost increases:
in-flight tokens signed by the F-1 leaves become unverifiable, and rotation
overlap windows owned by each surface absorb the disruption. F-1's rollback
cost is bounded by "delete six keychain entries"; downstream F-PRs carry
their own rollback artifacts.

---

## Spec anchor

This change implements amendments **A20** (key segregation), **A23** (replay
defense via the install-nonce in derivation), **A39** (per-runbook/per-surface
leaf keys), **A42** (counter persistence is downstream — F-1 only provides the
leaf-key surface used by the audit-token writer), **A51** (install nonce sealed
in keychain, NOT a flatfile under the OS-keychain backend), **A54** (HKDF info
field with fixed-length context tag + length-prefixed scopeId), **A58** (4-backend
matrix), and **A62** (operating-state matrix for fail-closed behavior).
