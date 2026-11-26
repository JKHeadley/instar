# Side-Effects Review — Instar takes invite pairing from @sagemindai/threadline-core

**Version / slug:** `instar-uses-threadline-core`
**Date:** `2026-10-20` (drafted 2026-10-19, re-applied onto main at 8fb7e3a3b)
**Author:** `dawn`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review below)`

## Summary of the change

Rollout step 3 of `docs/specs/threadline-standalone-pairing.md`. Instar adds `@sagemindai/threadline-core` at the exact version `0.1.0` (registry, not a path: Instar's `tsconfig` includes only `src` and there is no workspace). The published 0.1.0 `dist/` was checked to be byte-identical to a build of `packages/threadline-core/src` on `main`.

- `src/threadline/PairingInvite.ts`, `PairingInviteFlow.ts`, `PairingInviteStore.ts`: now named re-exports of core, same paths and names (plus core's additions `INVITE_HOW_TO`, `classifyInviteText`, `FINISH_GRACE_MS`, `ApprovedAccept`).
- `src/threadline/ThreadlineCrypto.ts`: `generateIdentityKeyPair`, `generateEphemeralKeyPair`, `sign`, `ecdh`, `edPublicToX25519`, `isX25519BoundToIdentity` come from core (same code), and `derivePairingIdV2` now delegates to core's `derivePairingId` (same 32-byte length check, same byte-order sort, same HKDF info; the first draft kept it on a wrong premise that the length checks differed, caught in the second-pass review). `verify` stays: core's returns `false` on a malformed key where Instar's throws. SAS derivation, the word list and its file loading, `deriveRelayToken`, `computeChallengeResponse` and v1 pairing ids are Instar-only.
- `src/threadline/client/MessageEncryptor.ts`: `edPrivateToX25519`, `deriveX25519PublicKey`, `computeFingerprint` come from core (same code). The `MessageEncryptor` class stays: core's `EnvelopeCrypto.decrypt` first refuses an X25519 key not derived from the signer's identity key, which Instar's does not check, and the all-zero ECDH error text differs. Encryption output is the same format either way (the compat test checks both directions).
- `src/threadline/AgentTrustManager.ts`: `implements InviteTrust` (type only). The spec calls this port `TrustPort`; core 0.1.0 exports it as `InviteTrust` (`packages/threadline-core/src/trust.ts`), so the name follows the published package.
- `src/threadline/ThreadlineBootstrap.ts`: the invite store and engine are built inside a `try`, so a store that throws turns off invite pairing only.

Not done here: spec step 3 also says that when step 3 lands after step 6, the same PR deletes `src/threadline/encryptedSeenMark.ts` and its parity test. Step 6 has not landed on main (the file does not exist there), so that clause does not apply to this PR; it moves to whichever of the two lands second.

`@sagemindai/threadline-core` 0.1.0 is still the latest published version (checked with `npm view` on 2026-10-20), and `packages/threadline-core` has not changed on main since the draft, so the pin stays at 0.1.0.

## Decision-point inventory

Changed (all adopted from core, where they were made as review fixes):

- Recipient `handleFinish` (Echo's review of #2195): refuses a Finish with no approved-accept record for that iid, or from a different inviter, or for a different `exp`, or more than `FINISH_GRACE_MS` (24 h) after `exp`; a second Finish with a new nonce is refused, the same nonce is re-acked without re-marking. It also refuses a profile whose `via` starts with `paused:`, which never fires in Instar because `AgentTrustProfile` has no `via` field.
- `approveAccept`: a send that throws returns `{ ok: false }` and keeps the invite pending. Core would also call `trust.forget` to undo a pin it created; `AgentTrustManager` has no `forget`, so in Instar the `invite-accepted` pin stays, as it did before.
- Store load: corrupt JSON is moved aside and reported on stderr; a read error other than ENOENT throws.

Not changed: SAS pairing, the credential gate (`CredentialShareGate`), trust levels, the relay.

## 1. Over-block

A Finish for an invite approved before the upgrade is refused after it (no approved-accept record exists). The window is the invite's validity (default 1 h, at most 24 h); the person sends a new invite. A legitimate Finish arriving more than 24 h after the invite expired is refused; the inviter's retries run for about 10 minutes, so this needs an operator who waited more than a day to tap Finish.

## 2. Under-block

Core's `PinnedKeyStore` refuses small-order or non-canonical identity keys when pinning (`isAcceptableIdentityKey`, SEC-16). `AgentTrustManager.recordInviteAccepted` / `markInviteVerified` do not, and this change keeps it that way to stay behaviour-identical for the trust store. Follow-up: add the same check to `AgentTrustManager`'s pinning paths (invite and SAS).

## 3. Level-of-abstraction fit

Invite format, engine and store are protocol, so they belong in the shared package; Instar keeps the adapters (Telegram, dashboard, bootstrap wiring) and its trust store.

## 4. Signal vs authority compliance

No new authority. The Finish checks narrow what an inbound control message can do.

## 4b. Judgment-point check

No LLM judgment involved.

## 5. Interactions

- `pairing-invites.json` gains an `accepted` array. An older Instar reading it ignores the array and drops it on its next save; the only effect of a downgrade is the over-block in §1 for invites approved under the new version.
- Invite text changes for every Instar agent (spec D13); `findInviteToken` / `INVITE_PREFIX` recognition is unchanged, so Telegram, the message queue and the dashboard still keep invites out of logs and sessions.
- `cleanLabel` now NFKC-normalises and strips C1, bidi and zero-width characters from names the other agent chose (SEC-12). Display only; not part of the signed transcript.
- A core fix now reaches Instar only by publishing core and bumping the exact pin.

## 6. External surfaces

Invite message wording. Approving an invite from Telegram or the dashboard returns a refusal instead of an error when the relay is not connected. Wire formats unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

The invite store is machine-local, as before. The new approved-accept record is local too: a Finish must reach the machine whose operator approved, which is already where the pending invite and the pin are.

## 8. Rollback cost

Revert the commit; no migration. Files written by the new version load in the old one (§5).

## Conclusion

Instar and threadline-mcp now run one implementation of invite pairing. The behaviour changes are core's review fixes and the host-neutral invite text; the crypto functions that differ were left in Instar.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, 2026-10-20), required because the change narrows what an inbound control message (Finish) can do and touches the trust store's type.
**Independent read of the artifact: concern, then resolved**

The reviewer compared every function taken from core against the removed Instar code and `node_modules/@sagemindai/threadline-core/dist`. It found the re-exported crypto helpers identical, confirmed the `verify` and `MessageEncryptor` differences are real, found the store's corrupt-file and ENOENT handling matches core's, and found no re-exported name with a changed signature (`tsc --noEmit` clean). Concern raised: the first draft kept `derivePairingIdV2` in Instar on the premise that core's adds a 32-byte length check, but Instar's already throws through `sortedPair`, so the two were identical. Resolved: `derivePairingIdV2` now delegates to core's `derivePairingId`, and this artifact and the code comment were corrected.

## Spec amendment (wording only, after Echo's approval)

`docs/specs/threadline-standalone-pairing.md` is brought into line with what this PR does: the trust port is named `InviteTrust` (the name core exports) instead of `TrustPort`; step 3 lists the five core review fixes it adopts instead of calling itself behaviour-identical; and steps 3 and 6 say that whichever lands second deletes `src/threadline/encryptedSeenMark.ts` and its parity test, with step 6 importing the mark from core if it rebases onto step 3. No decision changes; `approved: true` stays.
