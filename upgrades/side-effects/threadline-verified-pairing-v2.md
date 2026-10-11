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

---

## 1. Over-block

- **Credential-share to an agent whose X25519 key is not the standard derivation.** `IdentityManager.loadFromLegacy` can carry a stored `x25519PublicKey` that differs from the derived one. Such a peer is now refused credentials even when verified, which is the intended fail-closed outcome. Ordinary messages are not affected.
- **Start when the peer's key is not cached** returns 409 ("exchange a Threadline message first"). This is a usability cost, not a security one. It is the only way to bind the relay-observed key rather than a caller-chosen key.
- **A denied match cannot be retried without the PIN.** This is intended (spec §3.2), because static words would show the same mismatch again.
- **Receipts from a sender whose clock is more than 5 minutes off** are dropped. The receipt is optional (FD8), so the only cost is a missing `peerAcked`.

## 2. Under-block

- **The words are only as good as the comparison.** If an operator confirms without comparing, nothing here helps (unchanged from v1, §3.9).
- **2^66 is a work bound, not impossibility.** A relay with enormous compute could still search. 12 words was chosen over scrypt-stretched 6 words because it reaches this bound with no memory cost.
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

No operator surface file is changed (no dashboard markup). Not applicable.

## 7. Multi-machine posture

**machine-local BY DESIGN for the pending record and words; replicated for the result**, as in v1 §3.8. The start route returns 503 on a machine that does not hold the relay identity, because the words bind that machine's identity key. No notices are emitted except the existing denied-match attention item.

## 8. Rollback cost

Pure code revert. The only new persistent field (`pairingRecordedAt`) is optional and ignored by older code. Feature remains dark behind `threadline.verifiedPairing.enabled`.

---

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
- Deliberate breakages, each failing at least one test: X25519 binding check removed; own-rotation check removed; gate ignores binding; denied resets to pending; fingerprint check removed; unsorted key pair. The remaining breakages run in a scratch worktree and are recorded on the PR.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was missing runtime wiring plus a hollow E2E (`threadline-verified-pairing-alive` hand-seeded the pending state). The new relay-agents E2E starts the pairing only through the real route, which is the guard against that recurring here.
