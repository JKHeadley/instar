# Side-Effects Review — Encrypt ordinary chat to invite-paired peers

**Version / slug:** `threadline-encrypt-to-pinned`
**Date:** `2026-10-16`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (requested on the PR)`

## Summary of the change

Step 9 (second half) of `docs/specs/threadline-standalone-pairing.md`: Instar now encrypts ordinary chat to a peer paired by invite, always, to the pinned identity key. `ThreadlineClient` gains `setEncryptToResolver`; `sendAuto` consults it first; `hasEncryptedSendPath` counts it. `ThreadlineBootstrap` wires it to the trust store: a key only for `mutual-verified` peers with no `sasFingerprint` (paired by invite).

## Decision-point inventory

- `ThreadlineBootstrap` resolver: which peers always get encryption (mutual-verified AND invite-paired).
- `ThreadlineClient.resolveEncryptTo`: a resolver key is used only if it belongs to the recipient (fp = first 16 bytes); a throwing resolver means "no".

## 1. Over-block

Nothing is blocked. The change only chooses encryption over plaintext for some sends.

## 2. Under-block

Peers paired by SAS still get plaintext when the relay has not supplied keys this session (unchanged from before). A peer paused after a leaked invite (Instar records no marker on the profile) gets the old rule.

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

## 7. Multi-machine posture

Per machine, from the local trust store (the same store the existing decrypt resolver reads). A pairing replicated to the agent's other machines (FD11) arrives there as `identity-verified`, with no record of whether it was an invite or SAS pairing, so on those machines the resolver returns nothing and the previous rule applies: safe (never unreadable), but not yet always-encrypted from a standby. Closing that needs the replicated record to carry the pairing method; it is the spec's open question §8.2.

## 8. Rollback cost

Revert the commit; sends go back to cache-dependent encryption. No state is written.

## Conclusion

Safe to ship behind the existing pairing state; exclusions protect the two cases where the peer could not decrypt.

## Second-pass review (if required)

Requested from Echo on the PR.

## Evidence pointers

- `tests/e2e/threadline/pairing-invite-production-path.test.ts` ("ordinary chat to a peer paired by invite is always encrypted…"): real relay, two Instar agents, caches cleared; before Finish delivered plaintext; after Finish encrypted both ways; SAS-marked pairing keeps the old rule.
- `tests/unit/ThreadlineClient-encrypt-to-pinned.test.ts` (4).
- Breakages: 6 tried, 6 caught (resolver ignored in sendAuto; fp binding removed; hasEncryptedSendPath ignoring it; resend flag dropped; bootstrap allowing invite-accepted; bootstrap ignoring sasFingerprint).

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure **n/a** (negative declaration). No repeated or self-triggered action is added; each send is caller-initiated, as before.
