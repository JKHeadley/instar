# Side-Effects Review — WS5.2 Account Follow-Me, PR1 (shared security primitives + metadata kind)

**Version / slug:** `ws52-account-follow-me-pr1`
**Date:** `2026-06-17`
**Author:** Echo (autonomous)
**Second-pass reviewer:** REQUIRED (high-risk: credentials, mesh verb + RBAC, a replication JournalKind) — verdict appended below.
**Spec:** `docs/specs/ws52-account-follow-me-security.md` (converged 2026-06-13, approved)

## Summary of the change

PR1 of the WS5.2 build — the SHARED SECURITY PRIMITIVES, with **NO live-credential code path** (spec §9 build-order). It makes cross-machine account/quota sharing possible the ToS-safe way (re-mint per machine; no Claude OAuth token copied). Six primitives + the non-credential metadata kind:

Files added:
- `src/core/AccountCredentialShare.ts` — the distinct `account-credential-share` mesh verb + `AccountCredentialShareHandler` (RBAC gate BEFORE decrypt: recipient-match → mandate-verify → single-use-grant-consume → fail-closed AAD decrypt). Structurally separate from the permissive `secret-share`.
- `src/coordination/CrossMachineMandate.ts` — `signMandateIssuance`/`verifyMandateIssuance` (asymmetric Ed25519 issuance signature; the existing HMAC proof is machine-local).
- `src/core/PairingEpochManager.ts` — de-pair X25519 key-rotation + durable epoch anchor (`secretStoreKeyAnchor`, encrypted/keychain-backed, rollback-resistant).
- `src/core/AccountFollowMeGrants.ts` — single-use grant ledger + per-account sum-of-leases spend ceiling + failover re-derivation + epoch fencing.
- `src/core/SubscriptionAccountMetaReplicatedStore.ts` — the `subscription-account-meta` JournalKind schema (strict §6.1a whitelist + clamps), allowlist projection (`projectAccountToMeta` strips configHome + credentials), envelope builders, emit-seam interface, registration const.
- Unit tests: `account-credential-crypto`, `account-credential-share`, `cross-machine-mandate`, `pairing-epoch-manager`, `account-followme-grants`, `subscription-account-meta-store`, `ws52-account-follow-me-wiring` (61 new tests).

Files modified:
- `src/core/SecretStore.ts` — NEW `encryptAccountCredential`/`decryptAccountCredential` (AAD-bound, distinct HKDF info, fail-closed). Existing `encryptForSync`/`decryptFromSync` untouched.
- `src/core/SecretSync.ts` — `SecretShareHandler.handle` now refuses a non-`secret-share` command (credential-class data must use the distinct verb).
- `src/core/SubscriptionPool.ts` — R0 header correction + the meta emit seam (`setMetaReplicationEmitter` + emitPut on add/update + emitDelete on remove).
- `src/core/CoherenceJournal.ts` — `subscription-account-meta` added to JournalKind union, JOURNAL_KINDS, DEFAULT_RETENTION + the per-kind `Record<JournalKind>` literals.
- `src/commands/server.ts` — registers the kind; injects the accountFollowMe-gated store-flag; wires the emit adapter at SubscriptionPool construction.
- `src/config/ConfigDefaults.ts` + `src/core/devGatedFeatures.ts` — `multiMachine.accountFollowMe` dev-gated (live-on-dev, dark-on-fleet); `credentialTransport` default empty; `maxFollowMachines` 5.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — awareness section (Agent Awareness + Migration Parity).

## The eight side-effect questions

1. **Over-block — what legitimate inputs does this reject that it shouldn't?**
   The `subscription-account-meta` schema rejects ANY non-whitelisted key (incl. a future `SubscriptionAccount` field). That's deliberate (allowlist), but it means a NEW account field won't replicate until added to both the source-of-truth and this whitelist — a documented, bounded maintenance cost (mirrors every other `*-record` kind). The `SecretShareHandler` now throws on a non-`secret-share` command; the only caller is the legacy secret-sync path which only ever sends `secret-share`, so no legitimate caller is blocked.

2. **Under-block — what failure modes does this still miss?**
   PR1 ships no live-credential path, so Mechanism A's at-rest plaintext residual (the framework's own config-home token, gap 6) is NOT yet addressed — it is explicitly a later-PR concern (active wipe + TTL + provider rotation). The grant ledger's `now()` is injectable but a wall-clock-only TTL can't defend a machine with a tampered clock (accepted; the AAD epoch + single-use grant are the primary defenses, not the TTL).

3. **Level-of-abstraction fit.**
   Correct layers: crypto in `SecretStore` (where the sync crypto lives), the mesh verb + handler as a standalone module (parallel to `SecretSync`, not folded into it — the spec's structural-separation mandate), the JournalKind as a `ReplicatedKindRegistry` store (matching the 8 existing kinds), the emit seam on `SubscriptionPool` (the registry owner). No logic placed above/below where it belongs.

4. **Signal vs authority compliance.**
   The RBAC gate in `AccountCredentialShareHandler` is an AUTHORITY (it gates a credential write), but it is NOT brittle: it delegates the actual authorization to injected seams (`verifyMandate` = the operator-mandate gate; `consumeGrant` = the single-use ledger), and FAILS CLOSED on every uncertainty. It never fabricates an allow. The cross-machine mandate verification is deny-by-default. No brittle check holds blocking authority.

5. **Interactions.**
   Adding a JournalKind cascades to every `Record<JournalKind>` map — all updated (caught by tsc + the existing CoherenceJournal getOwnAdvert test, which was updated). The emit gate reuses the existing `_stateSyncStoresResolved` map (injected entry) so it shares the generic emitter's dark-by-default discipline. The new verb is structurally disjoint from `secret-share` (no shared handler/decryptor). No double-fire: emit fires once per mutation after `save()`.

6. **External surfaces.**
   No new HTTP route. No new outbound egress in PR1 (the emit path is dark on the fleet; live only on a dev agent, and even then only emits the non-credential metadata projection). The metadata projection includes `email` (operator/provider PII, "never a secret") which lands at-rest in same-operator peers' plaintext journal replicas — disclosed in the spec §6.1 and the code comment. configHome + every credential field are stripped by allowlist construction.

7. **Multi-machine posture (Cross-Machine Coherence).**
   This feature IS the multi-machine work. Posture: **replicated** (the `subscription-account-meta` kind over the WS2 journal). The credential itself is **machine-local BY DESIGN** (re-mint per machine; never replicated). Authorization is **operator-rooted, not peer-quorum** — holds at pool size 1/2/N. Single-machine agents are a strict no-op (no peers; the emit gate + dark default). Cross-machine mandate auth uses the asymmetric Ed25519 path (works over the relay where the local HMAC cannot).

8. **Rollback cost.**
   Low. Everything is dark on the fleet (gate `multiMachine.accountFollowMe`, default off via the dev-gate). The JournalKind addition is additive + forward-compat (an old peer that doesn't know the kind drops it; the receive validator is present so a known peer never suspect-flags). Back-out = revert the PR; no data migration (no live credential ever written), no agent-state repair. The R0 header change is documentation-only.

## What's NOT in PR1 (tracked, not deferred-orphan)

Per spec §9, PR1 is the primitives + the metadata kind ONLY. The following are the spec's own subsequent build-round items, tracked in the WS5.2 spec + the autonomous task list (topic 13481):
- Mechanism B enroll-drive (re-mint per machine, operator-mandate-gated) — the live account path.
- The router `locallyExecutable` gate + revocation (R12) + the offline-wipe escalation.
- The `?scope=pool` offline-fallback read that surfaces the durable replicated meta when a peer is offline (the live `?scope=pool` HTTP fan-out already serves online peers; the meta is correctly received + stored now).
- The live-channel proof (a real operator message answered FROM the Mini using an account the Mini enrolled itself).

## Second-pass review

**Verdict: Concur with the review.** (Independent reviewer subagent, 2026-06-17.)

The reviewer independently read all eight files, ran the seven WS5.2 test files (63/63 pass) and `tsc --noEmit` (clean), and verified the four security focus areas:
- **(a) No credential decrypt/store without mandate + consumed grant** — the RBAC gate runs strictly before any crypto (type → expiry → recipient-match → verifyMandate deny-by-default → consumeGrant single-use → fail-closed decrypt); every denial returns `{accepted:false}`, never fail-open. The crypto pair is genuinely domain-separated (distinct HKDF info; AAD bound via setAAD with a timing-safe pre-compare; throws on absent/mismatched AAD); a secret-sync blob cannot decrypt as a credential or vice-versa; `SecretShareHandler` refuses credential-class commands; the cross-machine mandate uses an asymmetric Ed25519 signature binding the issuer fingerprint.
- **(b) configHome / OAuth token cannot cross via the metadata kind** — `projectAccountToMeta` is a strict build-by-copy 7-key allowlist; the receive validator independently rejects non-whitelisted keys (exempting only RESERVED_ENVELOPE_FIELDS). Enforced both ends.
- **(c) Dark/fleet default genuinely inert** — `resolveDevAgentGate(undefined, fleetConfig)` is false ⇒ no store-flag entry, emitter not constructed, registration inert, `storeCredential` unwired in PR1.
- **(d) No fail-open bugs** — every security check defaults to deny/throw-into-deny.

Two non-blocking observations (both safe-direction, acceptable for the PR1 primitive layer): a forged-AAD payload that ALREADY passed the mandate gate burns its single-use grant on the fail-closed decrypt (a self-limited DoS that requires first passing the operator-mandate gate); and `rotateOnDepair` is load-then-save without an explicit lock (serial single-machine de-pair). Both are noted for the live-path PRs; neither blocks PR1.
