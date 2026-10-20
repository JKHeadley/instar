# Side-Effects Review — Encrypt ordinary chat to invite-paired peers

**Version / slug:** `threadline-encrypt-to-pinned`
**Date:** `2026-10-16`, rebased onto main after step 3 (#2226) and its follow-ups (#2229) `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (requested on the PR)`

## Summary of the change

Rollout steps 5 and 5b of `docs/specs/threadline-standalone-pairing.md` (approved r5.2; D9, D11): Instar now encrypts ordinary chat to a peer paired by invite, always, to the pinned identity key. `ThreadlineClient` gains `setEncryptToResolver`; `sendAuto` consults it first; `hasEncryptedSendPath` counts it. `ThreadlineBootstrap` wires it to the trust store through `encryptToPinned.ts`: a key only for `mutual-verified` (or, from step 5b, inherited `identity-verified`) peers whose `pairingMethod` is `invite`. Since step 3, `AgentTrustManager` implements core's `InviteTrust`; core's invite flow calls `recordInviteAccepted` / `markInviteVerified`, which is where `pairingMethod: 'invite'` is set.

## Revision (spec D9 / rollout step 5)

- Invite peers are identified by an explicit `pairingMethod` on the trust profile (set by the invite, SAS and inheritance paths; backfilled on load for `mutual-verified` profiles), not by the absence of a SAS fingerprint.
- Behind the live switch `threadline.encryptToPinned` (off | watch | enforce; dev-gated like `relayUnknownSenderTrust`, `dryRun` default true). Only enforce changes a send.
- In enforce, a pinned send that fails throws; it never falls through to plaintext.
- Receive side, enforce only: plaintext ordinary chat under an invite-paired peer's fingerprint is delivered with a fixed server notice and its trust level capped at `verified`. Nothing is refused. This IS a behaviour change for such a sender's plaintext (it no longer gets `trusted` handling); acks and probes are untouched.

## Revision (Echo's review of #2231): every chat path, and fail closed

- **Every send path.** The pinned check now lives where every plaintext send funnels (`sendPlaintextTyped`) for `type: 'chat'`, and in `send()`. A caller that used `sendPlaintext` directly (CollaborationRedriveEngine's nudge) to an invite-paired peer in enforce now sends ENCRYPTED to the pin instead of plaintext; before, it bypassed D9 and, once the peer enforces `refuseDowngrade`, every nudge would have been refused. Acks and invite-control ops keep their plaintext envelopes. A test enumerates every `send*` method on the prototype and fails on an unclassified one.
- **Fail closed in enforce (Echo's decision).** A trust lookup that throws returns `ENCRYPT_TO_LOOKUP_FAILED` (not null); the client turns that, a resolver throw, or a pinned key that is not 32 bytes / not the recipient's into `EncryptToPinnedSendError` (relay-send 502, nothing recorded as sent), and `hasEncryptedSendPath` reports no encrypted path. Watch and off keep today's behaviour. Counters: `lookupErrors`, `resolverErrors`, `malformedPinnedKey` (sends only).
- **Over-block (new, by design).** In enforce, a broken trust store blocks ordinary chat to EVERY peer (the lookup cannot tell an invite peer from any other) until it is repaired. That is the fail-closed choice; the counters show it on `/health`.
- **Redrive.** CollaborationRedriveEngine increments `redriveCount` before sending. A nudge refused with `EncryptToPinnedSendError` is now NOT a redrive: the increment, `lastRedriveAt` and `lastRedriveText` are restored, the commitment is skipped as `encrypted-send-refused`, and it is tried again on a later tick. Any other send error keeps the existing rule (counted).
- **a2a redelivery.** The server's redeliver callback (now `createOutboxRedeliver`) returns false — not redelivered — on `EncryptToPinnedSendError`; the entry stays awaiting-ack.

## Decision-point inventory

- `ThreadlineBootstrap` resolver: which peers always get encryption (mutual-verified AND invite-paired).
- `ThreadlineClient.resolveEncryptTo`: a resolver key is used only if it belongs to the recipient (fp = first 16 bytes); a throwing resolver means "no".

## 1. Over-block

Nothing is blocked. The change only chooses encryption over plaintext for some sends.

## 2. Under-block

Peers paired by SAS still get plaintext when the relay has not supplied keys this session (unchanged from before). A peer paused after a leaked invite (`demoteInvitePairing`: back to `invite-accepted` with `invitePausedReason`, since #2229) gets the old rule until its pairing is confirmed again, and the pause's revoke reaches the other machines through 5b.

## 3. Level-of-abstraction fit

The client stays trust-agnostic (it takes a resolver, as it already does for decryption with `setPinnedKeyResolver`); the trust decision lives in the bootstrap beside the existing resolver.

## 4. Signal vs authority compliance

No new authority. The pinned key already authorises credential sends; this reuses it for confidentiality of ordinary chat.

## 4b. Judgment-point check

None. The rule is mechanical and keyed on stored pairing state.

## 5. Interactions

- Receive path: a peer that can be invite-paired runs 1.3.1352+, which resolves the pinned key when its cache is empty (`setPinnedKeyResolver`, 1.3.1345+) and decrypts. Verified on the production path with both caches cleared.
- The inviter before Finish holds no key for the acceptor. The bootstrap excludes `invite-accepted`, so the acceptor keeps sending as before and nothing is lost (tested).
- `hasEncryptedSendPath` now true for pinned peers: the credential-share gate's "encrypted path exists" check passes for them, which is correct (credentials already go via `sendCredentialToPinned`).
- threadline-mcp (standalone) receives encrypted messages from a pinned sender; its `plaintextFromPairedPeer` case now becomes rare for Instar senders.

## 6. External surfaces

Wire format unchanged (same envelope, same encryption). Peers see encrypted envelopes where they used to see plaintext.

## 6b. Operator-surface quality

No operator surface changes.

## 7. Multi-machine posture (step 5b, D11)

- `pairingMethod` replicates as an optional sixth field of the `threadline-pairing-record`. On receive an unknown value is treated as absent (counted as a dropped field, never a rejected record); a missing value means `sas`; the merge returns `invite` if any honoured view with the same single pinned key says `invite` (`addPairingMethodWitnesses` lets the merge see other origins' same-key records the union hides, so a later record from an older machine never downgrades `invite`).
- Inheritance runs on merge (`pairingReplicationWiring.ts`, from the journal applier's commit observer for `threadline-pairing-record`, and once at startup after the upgrade migration that re-sends local invite pairings). Local authority wins: a local `mutual-verified`, `verification-failed` or `invite-accepted` profile is never overridden, a local SAS pairing is not upgraded, a known `invite` is never downgraded.
- Revokes: tombstones may carry the revoked `peerIdentityPub`; `revokedPairings()` resolves revokes in force by the union's own ordering (a newer put wins; an open conflict including a tombstone fails closed); `revokeInheritedVerification` forgets only an inherited (`identity-verified`) profile pinned to the revoked key (any key for an unkeyed tombstone from an older machine), clamps level to `verified`, and leaves it re-inheritable by a newer record.
- Everything here is gated on `multiMachine.stateSync.threadlinePairing.enabled` (default off, unchanged); with it off nothing is read, inherited or re-sent. A multi-machine agent with `encryptToPinned` at enforce and replication off logs a warning at start. The `dryRun` field of that switch is still not read (spec D11).

## 8. Rollback cost

Set `threadline.encryptToPinned` to off; sends go back to cache-dependent encryption. Cost (spec step 5): a `threadline-mcp` peer that has seen encrypted chat then refuses Instar's plaintext until the two unpair and re-pair, which is why the fleet starts at off. `pairingMethod` stays on profiles and replicated records; older code ignores it.

## Conclusion

Safe to ship behind the existing pairing state; exclusions protect the two cases where the peer could not decrypt.

## Second-pass review (if required)

Requested from Echo on the PR.

## Evidence pointers

- `tests/e2e/threadline/pairing-invite-production-path.test.ts` ("ordinary chat to a peer paired by invite is always encrypted…"): real relay, two Instar agents, caches cleared; before Finish delivered plaintext; after Finish encrypted both ways; SAS-marked pairing keeps the old rule.
- `tests/unit/ThreadlineClient-encrypt-to-pinned.test.ts` (6).
- `tests/unit/threadline/encrypt-to-pinned-switch.test.ts` (17): off / watch / enforce, backfill, the receive-side label, the relay-send 502.
- `tests/unit/threadline/pairing-replication-merge.test.ts` (35, step 5b): the real journal, applier, commit observer, emitter and stream reader; a record lands, the inherited pin appears and in enforce the send is encrypted to it; a revoke removes it and credentials to that peer are refused; mixed-version pair; local authority wins; the startup warning.
- Review fix: `tests/unit/ThreadlineClient-no-plaintext-chat-to-pinned.test.ts` (every public send method, pin resolved and four unresolvable shapes), the fail-closed end-to-end cases in `encrypt-to-pinned-switch.test.ts`, redrive and redeliver tests; 13 mutations of the fix, 13 killed.
- Breakages (run on the pre-rebase branch, not re-run after the rebase onto step 3): 6 tried, 6 caught (resolver ignored in sendAuto; fp binding removed; hasEncryptedSendPath ignoring it; resend flag dropped; bootstrap allowing invite-accepted; bootstrap ignoring sasFingerprint).

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure **n/a** (negative declaration). No repeated or self-triggered action is added; each send is caller-initiated, as before.
