# Side-Effects Review — Unified trust initialises on a machine that joined via pairing

**Version / slug:** `joined-machine-unified-trust`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/joined-machine-unified-trust.md (approved under the operator's standing approval, 2026-10-08 14:49). Tracking: ACT-072. Tier 2 (identity keys are a safety surface).

## Summary of the change

`CanonicalIdentityManager.load()` (`src/identity/IdentityManager.ts`) threw `Unknown encryption method: undefined` on the canonical `identity.json` that the pairing installer (`installAgentIdentityFromPairing`) writes, because that file has no `privateKeyEncryption`, `canonicalId` or `displayFingerprint` field. `createUnifiedTrustSystem` calls that loader, so on every machine that joined via pairing the boot logged `Unified trust system init failed (non-fatal)` and the unified trust layer never started.

- **`src/identity/IdentityManager.ts`** — an ABSENT `privateKeyEncryption` field is read as `'none'`; `canonicalId` and `displayFingerprint` are derived from the public key when absent or empty. This change adds no write (the existing ACT-062 hex repair still runs first for any file).
- **`tests/unit/identity/IdentityKeyFile.test.ts`** — the PR #2150 test that pinned the refusal is replaced by both sides of the boundary.
- **`tests/integration/joined-machine-unified-trust.test.ts` (new)** — real seal → real installer write → `createUnifiedTrustSystem`.

No config key, route, hook, template section or state schema is added.

## Decision-point inventory

- Does the loader accept a canonical file with no declared encryption — **modify** — invariant: accept only when the field is absent AND the shared reader has validated a 32-byte plaintext seed whose public key matches. A present-but-unknown value (including `null`) is still refused.

---

## 1. Over-block

No issue identified. The change only removes a refusal; the refusals that remain (malformed key, mismatched pair, unknown declared method) are unchanged.

## 2. Under-block

- Could the widening admit a bad key? No: with the field absent, `readIdentityKeyFile` treats the file as plaintext and requires a 32-byte private seed whose derived public key equals the stored one, before the loader branch runs. A ciphertext key shipped without its label (an encrypted source identity handed over by pairing) is refused there. Unit and integration tests pin it.
- A stored non-empty `canonicalId` / `displayFingerprint` that disagrees with the public key is used as stored, exactly as before this change. Unchanged.
- A joined machine still has no `recoveryCommitment` / `recoverySalt` (the handover does not carry them), so recovery-phrase rotation is unavailable there. Pre-existing and unaffected.

## 3. Level-of-abstraction fit

The loader is the one reader that disagreed with every other reader of this file about an absent field (`readIdentityKeyFile`, `TelegramOriginBoot`, the window send-time guard all read absent as "not encrypted"). Fixing the loader fixes new and already-joined machines with no migration; changing the installer would have required a migration that rewrites private-key files.

## 4. Signal vs authority compliance

No blocking authority is added; a deterministic invariant on key bytes stays the arbiter. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No judgment-shaped decision point (all invariant).

## 5. Interactions

Unified trust now starts on joined machines, so they behave like the machine they joined. Concretely, the consumers of `ctx.unifiedTrust` in `src/server/routes.ts` that returned "no trust manager" before now get the real one on a joined machine:
- Threadline pairing list / verify / deny routes and the verified-pairing credential-share gate use the real trust manager instead of their no-trust-manager branch.
- A2A local-route trust (`threadline.localRouteTrust`, dev-gated, dry-run by default) now evaluates on a joined machine instead of counting "no trust manager". In dry-run it only logs and counts; enforcement remains the operator's explicit `dryRun: false`.
- MoltBridge (only when `moltbridge.enabled`) initialises with the agent identity — the same identity as the source machine.
These are the same behaviours the source machine already had; no new behaviour exists anywhere that did not exist on the first machine.

## 6. External surfaces

- Boot log on a joined machine: `Unified trust system initialized (identity: <displayFingerprint>)` replaces `Unified trust system init failed (non-fatal): Unknown encryption method: undefined`.
- No file is rewritten; no route, protocol or wire change.

## 6b. Operator-surface quality

No operator surface added.

## 7. Multi-machine posture (Cross-Machine Coherence)

The agent identity stays unified (moved only by the sealed pairing handover). This change removes a cross-machine incoherence: the trust layer existed on the first machine and not on joiners. Each machine reads its own canonical file (machine-local by the protected trust-anchor rule, spec marker `physical-credential-locality`); the derived identifiers are a pure function of the public key, so every machine computes the same values with no coordination. No user-facing notice, URL, topic binding or durable state is added.

## 8. Rollback cost

Revert the commit. The previous loader refuses the installer shape again (the pre-fix state). No file was rewritten, so nothing on disk needs repair.

## Conclusion

The build follows the spec. Ungated: it repairs a permanent failure and is inert for any machine whose canonical file declares its encryption (every minted identity does). Clear to ship.

## Evidence pointers

- `tests/unit/identity/IdentityKeyFile.test.ts` — "CanonicalIdentityManager.load — the pairing installer shape (ACT-072)": accepted with derived identifiers and file unchanged; the same shape stored as hex repaired then loaded with no field added; empty identifiers derived; declared unknown, `null` and empty methods refused; non-seed private key refused and file untouched; mismatched pair refused. The acceptance test was confirmed to fail on the previous loader.
- `tests/integration/joined-machine-unified-trust.test.ts` — real canonical identity → `readAgentIdentityForHandover` → `sealIdentityForJoiner` → `installAgentIdentityFromPairing` → `createUnifiedTrustSystem`: same public key, canonicalId and displayFingerprint as the source, file byte-identical, a signature with the loaded key verifies against the source key; a malformed installer-shaped file still throws `IdentityFileInvalidError` and is untouched. Confirmed to fail on the previous loader with `Unknown encryption method: undefined`.

## Class-Closure Declaration (display-only mirror)

Not applicable: no self-triggered controller and no agent-authored-artifact defect. The class is "one reader disagrees with the writer about an absent field"; every other reader of this file already read absent as plaintext.

## Second-pass review

**Reviewer:** independent adversarial/security reviewer subagent (read the spec, the diff and every reader of the canonical file; ran no tests). The codex GPT-tier spec review (`gpt-6-astra`) also ran; its findings are in the convergence report.
**Independent read of the artifact: concur**

Nothing material. Confirmed: the widening admits only a validated plaintext pair (the shared reader runs first; ciphertext without its label is 72 bytes and is refused); the `in` check survives a hex repair (the repair spreads the raw object and adds no encryption field); the derived identifiers equal what `create()`, `Migration.ts` and `KeyRotation.ts` compute, and the handover ships the source public key unchanged; no other reader needs these fields from disk (`AgentServer` reads only `publicKey`; `routes.ts` and `TelegramOriginBoot` already read absent as plaintext; MoltBridge reads the loaded identity).

Minor findings and what was done:
1. Empty stored identifiers passed through `??`. **Fixed:** empty is derived; test added.
2. No test for a hex-stored installer shape or a declared empty method. **Fixed:** both added.
3. Recovery data is not carried by the handover. **Recorded** in the spec and the under-block section (pre-existing).
4. MoltBridge (when enabled) now initialises on a joined machine under the same identity. **Recorded** in the spec's multi-machine posture and §5 (intended).
5. A stored non-empty `canonicalId` is not checked against the key. **Recorded** (pre-existing, unchanged).
