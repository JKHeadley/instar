# Side-Effects Review — Verified pairing v2: relay agents can actually pair

**Version / slug:** `threadline-verified-pairing-v2`
**Date:** `2026-10-11`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo — design agreed on Threadline thread-ff759fcf; code and spec-delta review pending on the PR`

## Summary of the change

Verified pairing (docs/specs/secure-a2a-verified-pairing.md) had every part except the one that starts a pairing. `deriveSAS`, `derivePairingId` and `deriveSasFingerprint` had no caller in `src/`, `AgentTrustManager.recordPendingVerification` was called only from tests, and `HandshakeManager` is reachable only through the HTTP `/threadline/handshake/*` routes, which agents talking over the relay never use. So no real pairing could ever reach `pending-verification` (issue #2117 gap G). This change adds v2 (spec §3.0): the SAS is 12 words derived from the two Ed25519 identity keys alone. Each side starts independently through `POST /threadline/pairing/:peerFp/start` or `threadline_pair start`, using the peer key from the relay client's known-agent cache. It also hardens the credential-share gate so a verified peer's credential only travels over an encryption key derived from the pinned identity key (gap I). Files: `ThreadlineCrypto.ts` (v2 derivations, `edPublicToX25519`), `AgentTrustManager.ts` (`startStaticPairing`, `pairingRecordedAt`), `PairVerifyReceipt.ts` (v2 receipt with signed `issuedAt` and freshness), `CredentialShareGate.ts` (third condition), `ThreadlineClient.ts` (`isChannelBoundToPairing`), `routes.ts` (start route; denied-match text), the MCP tool and its HTTP helper, the agent template and a migration supplement, the spec and its ELI16.

## Decision-point inventory

- `POST /threadline/pairing/:peerFp/start` — add — records a PENDING pairing only; grants nothing. Bearer-authed; the `clearFailed` path additionally requires the dashboard PIN.
- `AgentTrustManager.startStaticPairing` — add — chooses started / already-pending / already-verified / refused-failed / fingerprint-mismatch / self-pair.
- `evaluateOutboundCredentialShare` — modify — adds refusal `encryption-key-not-bound`.
- `processPairVerifyReceipt` — modify — adds `receipt-stale` / `receipt-from-future` drops (no state change).
- `POST /threadline/pairing/:peerFp/verify` — pass-through — unchanged logic; the attention-item text after a denied match now says how the pairing is cleared.
- `threadline_pair` MCP tool — modify — adds `start`; text says 12 words.
- `ThreadlineClient.fetchPeerIdentityKey` — add — when the peer key is not in the known-agent cache (e.g. its messages arrive unsigned), the start route reads it from the relay's public A2A card. The key is accepted only if its first 16 bytes equal the fingerprint. Relay-supplied is acceptable for pairing: a substituted key gives different words, and the human comparison catches it.

---

## 1. Over-block

- **Credential-share to an agent whose cached X25519 key is not the standard derivation.** `IdentityManager.loadFromLegacy` can carry a stored `x25519PublicKey` that differs from the derived one. Such a cached key is refused by the binding check (fail-closed), and the credential send never uses a cached key anyway. Ordinary messages are not affected.
- **A credential to a co-located agent no longer takes the localhost route.** That route is plaintext. The credential is judged by the gate first (same refusals as before) and then goes over the relay, so it needs a relay connection.
- **Start when the peer's key is not cached** returns 409 ("exchange a Threadline message first"). This is a usability cost, not a security one. It is the only way to bind the relay-observed key rather than a caller-chosen key.
- **A denied match cannot be retried without the PIN.** This is intended (spec §3.2), because static words would show the same mismatch again.
- **Receipts from a sender whose clock is more than 5 minutes off** are dropped. The receipt is optional (FD8), so the only cost is a missing `peerAcked`.

## 2. Under-block

- **The words are only as good as the comparison.** If an operator confirms without comparing, nothing here helps (unchanged from v1, §3.9).
- **2^66 is a work bound, not impossibility.** A relay with enormous compute could still search. 12 words was chosen over scrypt-stretched 6 words because it reaches this bound with no memory cost.
- **Receive side.** When the receiver holds only the sender's identity key, it tries the key derived from it; anything that does not open (every plaintext envelope) goes to the unknown-sender path exactly as before. The cost is one failed decrypt attempt per plaintext envelope from such a peer. A forged envelope fails the signature check and is not delivered.
- **Ordinary (non-credential) messages still encrypt to whatever X25519 key the relay supplied.** This change binds the key only on the credential path. Binding it on ingest for all messages is a separate change; doing it here could start encrypting to peers whose listeners cannot decrypt (Dawn's portal listener has no X25519 key at all).
- **Option B (a handshake carried over the relay) would have the same offline-search weakness**, since the v1 handshake has no commitment step. Noted in the spec and not built.

## 3. Level-of-abstraction fit

The derivations live beside the v1 ones in `ThreadlineCrypto`. The lifecycle rules live in `AgentTrustManager`, the single writer of pairing state. The route and MCP action are thin wrappers. The binding check lives in `ThreadlineClient`, the only component that holds both the peer cache and our own identity, and the existing credential gate consumes it through its existing probe interface. No parallel gate is added.

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Yes, deterministic cryptographic checks on an irreversible action (sending a credential) — not a brittle content detector.

The new blocks are a key equality, a curve-map equality and a pairingId equality. These are exact cryptographic predicates, not heuristics, guarding the irreversible act of handing a secret to another agent. The human SAS comparison remains the authority on identity; the code only refuses to act without it. This matches the safety-guard exception in signal-vs-authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Every new check is an invariant (exact key and identifier equality, fixed clock-skew bound).

## 5. Interactions

- **Replication (§3.8):** `mutual-verified` results replicate as before. A v2 pairingId is recorded the same way, and inheritance still pins `peerIdentityPub`.
- **Existing v1 pending records:** none exist in practice, since nothing could create one. A v1 pairingId would fail the new binding check and refuse credentials until re-started, which is fail-closed.
- **Receipt sender:** there is still no sender in `src/` (receipts are optional). `buildPairVerifyReceipt` is added for when one is wired.
- **Races:** `startStaticPairing` writes through the existing `recordPendingVerification` and `save`, with no new shared state.

## 6. External surfaces

- **Other agents:** no wire-format change for ordinary messages. The pair-verify receipt format changed to v2, but no build ever sent one.
- **Persistent state:** a new optional `pairingRecordedAt` on trust profiles.
- **Operator surface:** the confirm/deny UI is unchanged. Starting is agent-driven (MCP or route). Reading the words and confirming still go through the existing PIN-gated dashboard panel, so it is phone-completable as before.
- **Agent awareness:** the template is updated, and a migration supplement reaches agents that already hold the v1 section (content-sniffed; skipped for new agents).

## 6b. Operator-surface quality

The change adds a Verified Pairing panel (`dashboard/pairing.js`, plus a card, styles and a lazy loader in `dashboard/index.html`, on the Threadline tab).

1. **Leads with the primary action?** Yes. A pending pairing's card opens on "Show my words", then the 12 inputs and "Confirm they match". Nothing is collapsed or placed below explanatory prose.
2. **Zero raw internals as primary content?** Yes. The headline is the agent's name and a plain-language state ("Waiting for you to compare the words", "Words did not match — blocked"). The fingerprint appears only as a shortened "Agent ab12…" support line at the bottom, and names are escaped.
3. **Destructive actions de-emphasized?** Yes. "They don't match" is a quiet, danger-coloured button below the confirm step. "Clear and start again" is quiet, and its hint asks the operator to find out why the words differed first.
4. **Plain language and phone width?** Yes. Labels read the way a person would say them. At ≤640px the words show in two columns, the 12 inputs in two columns, and the PIN field and buttons span full width. The PIN is never stored and is cleared after every send. A timed refresh skips while any field holds input, so it never wipes half-typed words.

## 7. Multi-machine posture

**machine-local BY DESIGN for the pending record and words; replicated for the result**, as in v1 §3.8. The start route returns 503 on a machine that does not hold the relay identity, because the words bind that machine's identity key. No notices are emitted except the existing denied-match attention item.

## 8. Rollback cost

Pure code revert. The only new persistent field (`pairingRecordedAt`) is optional and ignored by older code. Feature remains dark behind `threadline.verifiedPairing.enabled`.

---

## Revision after Echo's review (2026-10-11)

Echo's review of PR #2173 found five blockers. Already fixed in code:
- **Auth.** All four pairing routes now check the Bearer token themselves (`pairingRouteAuthorized`), because `/threadline/*` is exempt from the global middleware. Start, list and detail were unauthenticated before. Verify keeps its PIN.
- **Denied matches.** A denied match stays `verification-failed` whatever the pairingId; only a PIN `clearFailed` reopens it.
- **Inherited pairings.** An inherited `identity-verified` pairing for the same key is not demoted by a start, and the credential binding check accepts it on the pinned key alone (no local pairingId).
- **Receipt order.** The signature is checked before freshness.
- **Binding-check errors.** An exception while checking the binding reports `encryption-key-not-bound`.
- **Fingerprints.** Routes lowercase `:peerFp` (FD13).

- **Typed comparison (FD2a).** Verify takes the OTHER side's 12 words; the server compares all 12 in order. A bare `match:true` is refused, and any difference is a denial. This is an over-block for an operator who only eyeballs: intended, because a careless eyeball check is what a partial-match attack targets.

- **Agent awareness.** The migration now REPLACES a v1 CLAUDE.md section in place with the v2 text instead of appending a contradicting supplement (idempotent; it skips an agent whose file already names the start route). The template's verify text describes typed confirmation, and the site feature doc is rewritten for v2.

- **Identity-key cache fill (FD4a).** After a start reads the peer key from the relay card, it is merged into the known-agent cache: the identity key only, never an X25519 key. It is refused if it does not match the fingerprint, and never overwrites a different cached key.

- **Stale stdio status.** The stdio MCP process holds its own copy of the trust manager, so `status` now reloads it, and the pending-words store, from disk before reading. This is opt-in via `reloadTrustBeforePairingRead`, set only in the stdio entry, because an in-process reload could drop writes still waiting on the save debounce.

- **Credential path encrypts to the derived key (built 2026-10-11).** The production-path E2E (real bootstrap, in-process RelayServer, nothing hand-built) showed that after a full mutual verification a credential was refused with `credential-requires-encrypted-path`: the real clients never cache an X25519 key for each other (a start caches the identity key only; relay discovery is keyless). `ThreadlineClient.sendCredentialToPinned` now encrypts to the pinned identity key and its derived X25519 key; the gate's second check requires that send; the relay-send route uses it for every credential. Over 50 random keys the derived key equals the agent's own X25519 key.

- **Restart (Echo's second review, built 2026-10-12).** The peer key the credential and receipt paths need lived only in the relay client's memory, so after either agent restarted a credential was refused (sender) or became undecryptable (receiver). The trust profile's pinned key is now the authority, read through a resolver the bootstrap wires. A restart step in the production-path E2E (each side re-bootstrapped on the same state dir, credentials both ways) failed before the fix and passes after it. Side effect: an encrypted message from a paired peer now opens even when the cache is empty, where before it fell to unknown-sender; a plaintext envelope still goes to unknown-sender, and a key that does not match the fingerprint is ignored.
- **Also from that review:** verify checks the Bearer token (an anonymous caller could otherwise exhaust the PIN lockout); a wrong PIN on the detail route is counted and refused instead of silently returning no words (a behavior change for that one route); a misspelled word or a wrong word count is a retryable 400, not a denial; a pairing reset to pending loses the `mutual-verified` source; the receive path decrypts once. Seven breakages of these fixes each fail at least one test.
- **Write domain of the start route.** `POST /threadline/pairing/:peerFp/start` is a new mutating route, so it is classified in `WriteDomainRegistry` (the write-domain ratchet found it unclassified in a full local run). It is `cluster-shared`: single writer is the lease holder, which is also the only machine with the relay identity the route needs. This is the conservative default, with no machine-local convergence claim.
- **Receipt sender (built 2026-10-12).** After an operator confirms, the verify route sends one signed `pair-verify` receipt, encrypted to the peer's pinned key (`ThreadlineClient.sendPairVerifyReceipt`). It is best effort: a failure is logged and never undoes the confirmation. The production-path E2E shows both receipts accepted over a real relay (`peerAcked` set on each side). Three breakages (no send, wrong signer, plaintext send) each fail it. The extra cost is one message per confirm. A receiver whose verified-pairing is off ignores it (an unknown control message is dropped, as today).

## Conclusion

The review led to four design changes before commit: 12 words instead of 6 (Echo's offline-search argument); no ECDH, so agents with no published X25519 key can pair; a denied match that stays failed; and the credential-path encryption-key binding. Clear to ship once Echo's second-pass review and spec-delta review concur.

---

## Second-pass review (if required)

**Reviewer:** Echo
**Independent read of the artifact: pending** — Echo agreed the design on thread-ff759fcf and asked to review the code and run the spec review on the §3.0 delta before merge.

---

## Evidence pointers

- `tests/unit/threadline-pairing-v2.test.ts` (12): the curve map against the encryptor on 200 keys, the SAS symmetric and key-sensitive, receipt freshness on both sides of each 5-minute bound, and the start rules.
- `tests/e2e/threadline-pairing-v2-relay-agents.test.ts` (5): two servers start independently and reach pending with the same 12 words; a substituted key gives different words; a cached key that mismatches its fingerprint is refused; credential allowed only with a bound key; a denied match needs the PIN.
- `tests/e2e/threadline/pairing-v2-production-path-alive.test.ts` (7): real `bootstrapThreadline` on an in-process RelayServer; the start takes the key from the relay card; same 12 words; typed confirmation; a credential to the verified peer is delivered and decrypted with no cached X25519 key on either side; one to an unverified peer is refused.
- `tests/unit/ThreadlineClient-pinned-credential.test.ts` (4) and wiring test 5c: plaintext from an identity-key-only peer still goes to unknown-sender; a wrong pinned key sends nothing; a forged sender is not delivered; a credential never contacts the localhost route.
- Seven credential-path breakages (wrong encryption key, no receive derivation, credential via the ordinary send, credential on the localhost route, gate without the pinned-send check, no fingerprint check, dropped unknown-sender fallback) each fail at least one test, run in a scratch worktree.
- Deliberate breakages, each failing at least one test: X25519 binding check removed; own-rotation check removed; gate ignores binding; denied resets to pending; fingerprint check removed; unsorted key pair. The remaining breakages run in a scratch worktree and are recorded on the PR.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was missing runtime wiring plus a hollow E2E (`threadline-verified-pairing-alive` hand-seeded the pending state). The new relay-agents E2E starts the pairing only through the real route, which is the guard against that recurring here.
