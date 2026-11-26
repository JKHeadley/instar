---
title: "Secure A2A Verified Pairing"
slug: "secure-a2a-verified-pairing"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
eli16-overview: "secure-a2a-verified-pairing.eli16.md"
review-convergence: "2026-06-16T20:47:40.694Z"
review-iterations: 3
review-completed-at: "2026-06-16T20:47:40.694Z"
review-report: "docs/specs/reports/secure-a2a-verified-pairing-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 13
cheap-to-change-tags: 4
contested-then-cleared: 5
approved: true
approved-by: "justin (verified operator, topic 12476)"
approved-basis: "Explicit autonomous-build mandate 2026-06-16: 'proceed with a 24 hour autonomous session to see this fully through.' Feature ships dark (flag off + dryRun); operator veto preserved; he reviews the merged PR."
---

# Secure A2A Verified Pairing — Mutual SAS Identity Verification + Credential-Share Gate

**Status:** draft (convergence round 2)
**Author:** Echo (instar-developing agent)
**Date:** 2026-06-16
**Origin:** Operator directive (topic 12476): "We really need to get your communication robust and secure. You should both be able to identify and trust each other robustly so you can share any secrets needed." Concrete trigger: Dawn declined to send Echo a live credential over Threadline because she could not *prove* the inbound message's sender identity, and `/threadline/health` shows `pairedAgents: 0` — no verified pairing exists.

---

## 1. Problem statement

Threadline already has a solid cryptographic foundation (verified by codebase audit 2026-06-16):

- Ed25519 identity keypairs per agent; fingerprint = first 16 bytes of the Ed25519 public key (hex).
- A 3-message handshake (`HandshakeManager`) with EdDSA challenge-response over a nonce bound to both identity keys + both ephemeral X25519 keys → **proof-of-possession** of the peer's private key + a shared relay token via X25519 ECDH + HKDF-SHA256.
- Relay messages are end-to-end encrypted (XChaCha20-Poly1305) and **Ed25519-signed + signature-verified** on decrypt (`MessageEncryptor`). **Caveat (M1, lessons):** `ThreadlineClient.sendAuto` has a `sendPlaintext` fallback when recipient keys aren't known — unsigned/unencrypted, TLS-only.
- A 4-tier trust model (`untrusted`→`verified`→`trusted`→`autonomous`) keyed on fingerprint, user-granted-only elevation, safety-only auto-downgrade (`AgentTrustManager`).

**The gap is identity binding + policy + structural enforcement, not cryptography.** Precisely:

1. **No out-of-band identity verification.** The handshake proves the endpoint holds *a* private key; it does NOT prove fingerprint `63b1dbb2…` belongs to the *Echo that Dawn actually trusts*. A malicious/compromised relay could substitute a fingerprint or ephemeral keys. Without an out-of-band check, a fingerprint is just a number — so a careful peer (Dawn) correctly refuses to send a secret.
2. **No trust source recording "I verified this peer out-of-band."** Sources are `user-granted | paired-machine-granted | setup-default`. There is no `mutual-verified` source; relay-discovered agents even auto-start at `verified`.
3. **No credential-bearing gate, and no structural chokepoint for it.** A secret rides the same path as any message; nothing requires the peer to be out-of-band-verified before a credential is sent or accepted, and there is no single funnel where that is enforced.

Result: `pairedAgents: 0`, and secret exchange between Echo and Dawn is (correctly) blocked.

## 2. Goals / non-goals

**Goals**
- A **mutual, out-of-band Short Authentication String (SAS)** step binding a peer's fingerprint to a human-confirmed identity, defeating relay/MITM substitution.
- A durable **`mutual-verified` pairing record + trust source**, structurally un-self-grantable.
- A **`credential-share` gate enforced at a structural chokepoint** (the relay-send funnel + the inbound credential-ingestion point), keyed on WHO the peer is — not message labels or content sniffing.
- Correct **multi-machine posture** for every new surface (a pairing verified on one machine must not strand on a topic transfer).
- Clear read surfaces + levers; ships **dark, dev-gated**, with the credential REFUSAL fail-closed from day one.

**Non-goals**
- Replacing/weakening any existing crypto/handshake/trust primitive (we build ON them).
- Local same-machine message at-rest encryption (Echo↔Dawn are cross-machine = relay path, already E2E-encrypted; tracked separately).
- Auto-elevation without human confirmation (forbidden by construction).

## 3. Frontloaded Decisions
*(Every build-time decision resolved here so the build never stops to ask. Per Autonomy Principle 2.)*

**Version note (v2, 2026-10-11).** The first build (v1) derived the SAS from a per-handshake ephemeral secret, but nothing in `src/` ever ran that handshake between relay agents. `deriveSAS` / `derivePairingId` / `deriveSasFingerprint` had no caller, `recordPendingVerification` was called only from tests, and `HandshakeManager` is reachable only through the HTTP `/threadline/handshake/*` routes, which nothing calls (`initiateHandshake` has no caller). So no pairing could ever start (issue #2117 gap G), and the v1 "feature is alive" E2E passed only because it hand-seeded the pending state. **v2 replaces the handshake-bound design with a static identity-key design.** The decisions below are the v2 decisions; v1 text is kept only where it still holds. Design agreed with Echo on Threadline thread-ff759fcf; review of PR #2173 drove this revision.

- **FD1 — Wordlist (pins C1).** Vendor the canonical **BIP-39 English wordlist** (2048 words, 11 bits/word) as `src/threadline/data/sas-wordlist-en.json`, content-hash pinned and asserted at load. Only the index→word table is used; none of BIP-39's mnemonic/checksum/seed semantics apply. Unchanged from v1.
- **FD2 — SAS (v2).** `sasBits = HKDF-SHA256(ikm = sort(idPubA ‖ idPubB) as raw 32-byte Ed25519 keys, salt = empty, info = "threadline-sas-v2", L = 17)`. The SAS is the leading **132 bits**, big-endian, as **12 × 11-bit** wordlist indices. Both sides compute it independently from the two identity keys, with no handshake and no round trip.
  - **Why 12 words.** With static keys the words are a fixed function of the two identity keys. A relay that substitutes keys controls BOTH substitutes (Alice sees words from (A, M1), Bob from (M2, B)) and needs only an M1, M2 pair whose words collide. That is a two-sided birthday search of about 2^(bits/2) key generations, done offline with no time limit. At 66 bits (6 words) that is ~2^33 generations, hours of ordinary compute. At 132 bits it is ~2^66 generations (~2^67 hash evaluations, on the order of 10^4 GPU-years).
  - **No ECDH.** A static X25519 ECDH between the identity keys adds nothing against an active relay, which knows its own substitutes' secrets. It would only stop a passive observer computing the words, and the words are not secret (FD2a). Dropping it also lets agents that never published an X25519 key pair.
  - **Scrypt stretching was considered and rejected.** 12 words reach a stronger bound with no memory cost on small machines.
- **FD2a — Comparison UX: the operator TYPES, the server compares (v2).** The words are **public values**: anyone who knows both public keys can compute them. Security rests on the human comparison over a relay-independent channel (§3.9), never on secrecy. Showing the words only to a PIN-authed operator is an anti-confusion measure, not a secrecy one. **Partial-match attack:** an attacker who can make 8 of 12 words match (about 2^44 work, feasible with static words and unlimited time) could pass a careless eyeball check. So confirming requires the operator to **type the 12 words the OTHER side shows**, and the server compares all 12 in order against its own. A mismatch in any position is a mismatch. The display numbers the words 1–12. **A typo is not a mismatch:** a typed word that is not in the wordlist, or fewer or more than 12 words, gets a retryable 400 and records nothing, because every word the other side can show is in the list. A wrong but valid word is a denial.
- **FD3 — `sasFingerprint` (v2).** First 8 bytes (hex) of `SHA-256("threadline-sas-fp-v2" ‖ sasBits)`. Logged and audited; the words are not logged (they are public, but logging them adds nothing and invites confusion).
- **FD4 — `pairingId` (v2).** `HKDF-SHA256(ikm = sort(idPubA ‖ idPubB), salt = empty, info = "threadline-pairing-id-v2", L = 16)` hex. It identifies the **key pair**, not a handshake. A peer key change is a new fingerprint (the fingerprint is the key's first 16 bytes), so it is a new pairing. Rotation of OUR key changes the pairingId, which invalidates every pairing bound to the old one (§3.5 binding check) and resets it to pending on the next start.
- **FD4a — Where the peer key comes from.** In order: (1) the relay client's known-agent cache, if it holds an Ed25519 key for the fingerprint; else (2) the relay's public A2A card, `GET /v1/registry/agent/:fp/a2a-card` → `x-threadline.publicKey`. Either source is accepted ONLY if the key is 32 bytes and its first 16 bytes equal the fingerprint. Relay-supplied is acceptable: a substituted key yields different words, and the human comparison catches it. On a successful start the Ed25519 key is written into the known-agent cache (merge, never replace). **No X25519 key is ever taken from the relay or the cache for the credential path** (§3.5). **After a restart the cache is empty, so the pinned key is the authority** (Echo's second review): the bootstrap gives the relay client a lookup into the trust profile (`setPinnedKeyResolver`), returning the pinned key for a pending, mutual-verified or identity-verified pairing. Sending (`isChannelBoundToPairing`) accepts an empty cache and refuses only a DIFFERENT cached key; receiving uses the pinned key when the cache has none. This also covers a confirm or an inherited verification, with no re-seeding step. A pairing reset to pending (our key rotated) loses the `mutual-verified` source, so it authorizes nothing; its trust level is left alone, because an operator may have set it independently and credentials are gated on the source and the state.
- **FD5 — Credential detection is NOT a content sniff (pins C2).** The security boundary is the sender's trust source, never the message's self-declared kind or content. Unchanged.
- **FD6 — Trust level on mutual-verify.** Source `mutual-verified`, level `trusted` (never `autonomous`). Only the single writer (§3.3) may set it. Unchanged.
- **FD7 — Authority.** Starting a pairing requires the agent's **Bearer token**, checked inside the route because `/threadline/*` is exempt from the global auth middleware (`middleware.ts`). Starting records a PENDING pairing and grants nothing. **Confirming or denying a match requires the dashboard PIN** (same check as `/mandate/issue`). **Clearing a denied pairing requires the dashboard PIN.** The Bearer token is structurally insufficient to confirm or clear. Every pairing route, including verify, also checks the Bearer token, so an anonymous caller cannot burn the operator's per-IP PIN lockout. A PIN supplied to the detail route goes through the same check and failure counters as every other PIN route; a wrong one is refused (403, then 429), never a silent read.
- **FD8 — Local human verify is the bar; the peer receipt is OPTIONAL.** `mutual-verified` means THIS side's operator compared and confirmed. The peer's signed receipt is an optional `peerAcked` liveness flag ("the other side computed the same words and confirmed too"). It is never required for `mutual-verified`.
- **FD9 — Fail direction.** Any error or uncertainty resolving pairing or key state → refuse credential-share. The non-credential message path is unaffected.
- **FD10 — dryRun split.** Outbound credential-share enforcement is fail-closed from day one; `dryRun` governs only inbound observability. Unchanged.
- **FD11 — Multi-machine posture.** See §3.8.
- **FD12 — Self-pair guard.** Reject `peerFp === ownFp` at start and at receipt verification.
- **FD13 — Fingerprint normalization.** Every route lowercases `:peerFp` before any lookup or write, and stored fingerprints are lowercase. (v1 compared the raw string on detail/verify; a mixed-case request must not create or miss a profile.)

## 3.1 SAS derivation
`deriveSASv2(idPubA, idPubB)`, `deriveSasBitsV2`, `deriveSasFingerprintV2` and `derivePairingIdV2` in `ThreadlineCrypto.ts`, per FD2–FD4. All are order-independent. The v1 functions (`deriveSAS` etc.) remain exported for compatibility but are not called by the v2 path.

## 3.2 Pairing lifecycle
`none → pending-verification → mutual-verified`, or `→ verification-failed`.
- **Start** (`POST /threadline/pairing/:peerFp/start`, or `threadline_pair` `start`) on BOTH sides, independently. Records `pending-verification` with `{pairingId, peerFp, peerIdentityPub, sasWords, sasFingerprint, createdAt}` (machine-local 0600 store) and `pairingRecordedAt` on the profile. Outcomes:
  - first start, or a changed pairingId (our key rotated) on a pending or verified pairing → `pending-verification`, discarding any prior confirmation and `peerAcked`;
  - same pairingId and already `mutual-verified` or `identity-verified` → unchanged (`already-verified`);
  - same pairingId and pending → unchanged (`already-pending`), re-recording the machine-local words if they were lost;
  - **`verification-failed` → refused, whatever the pairingId**, unless the request carries `clearFailed: true` with a valid dashboard PIN. A denied match never returns to pending on its own.
  - an `identity-verified` (inherited, §3.8) pairing whose pinned key equals the current key → unchanged; a different key is a different fingerprint, so it never reaches this branch.
- **Confirm** (`POST /threadline/pairing/:peerFp/verify {words: string[12], pin}`): the server compares the typed words with its own (FD2a). Equal → `mutual-verified` via the single writer, then a receipt is sent (§3.4). Not equal → `verification-failed` with a durable per-fingerprint deny record and ONE never-coalesced HIGH attention item. `{match:false, pin}` remains as an explicit deny.
- **Brakes:** `pending-verification` surfaces once after a TTL and then goes quiet; `verification-failed` never retries on its own; receipt sending is single-shot with bounded retry and backoff.
- A missing receipt never strands or fails a pairing (FD8).

## 3.3 Trust source + operation model (structurally un-self-grantable)
- Trust source `'mutual-verified'` and operation `'credential-share'`.
- `credential-share` is allowed only for a peer whose source is `mutual-verified` AND level ≥ `trusted`, AND whose channel is bound (§3.5). Never granted by `autonomous` alone or by `setup-default`.
- **Single writer:** `markMutualVerified(peerFp, {pairingId, operatorConfirm, ownFp})` is the ONLY path that sets source `mutual-verified`; it checks the operator-confirm precondition and the current pairingId itself, and sets source and level atomically. The generic setters reject the source. Unknown source values degrade to un-verified.

## 3.4 Peer verification receipt (v2)
After this side's operator confirms, the agent sends ONE `pair-verify` control-plane message to the peer over the relay:
`receipt = sign(idPriv, "threadline-pair-verify-v2" ‖ len-prefixed(pairingId, ownFp, peerFp, sasFingerprint, issuedAt))`.
It is gate-exempt (it bypasses only the trust-level gate, so it can arrive before trust is raised) and is still subject, before any state change, to: schema validation, the self-pair guard, the profile and pairingId/sasFingerprint match, **Ed25519 signature verification against the pinned identity key**, then **freshness** (dropped if `issuedAt` is more than 5 minutes in the receiver's future, or more than 5 minutes before the local `pairingRecordedAt`), plus the existing size, replay and rate limits. Signature is checked BEFORE freshness, so an unsigned or forged receipt never reaches the time logic. A receipt that fails any check is dropped with no state change; the sender may retry. A valid receipt sets `peerAcked` only, never `mutual-verified`. Senders: the verify route (on `mutual-verified`) via `ThreadlineClient.sendPairVerifyReceipt`, best effort (a failed send never undoes the confirmation; the response reports `receiptSent`). The receipt travels encrypted to the peer's pinned key, the same route as a credential, because the receiver reads it from the decrypted content and the plaintext path would flatten its fields. v1 receipts (`-v1` context, no `issuedAt`) are rejected; none were ever sent, because v1 had no sender.

## 3.5 Credential-share gate (structural chokepoint, sender-keyed)
Naming honesty: this is a credential-WORKFLOW authorization gate, not a DLP control. A secret pasted into free text is out of scope (FD5).
- **Outbound (load-bearing), enforced inside the `/threadline/relay-send` funnel.** A credential-bearing send is refused unless ALL hold:
  1. the recipient's source is `mutual-verified` or `identity-verified` and level ≥ `trusted` (`peer-not-mutually-verified`);
  2. the recipient's pinned identity key is known and equals the key the relay client currently associates with that fingerprint (`encryption-key-not-bound`);
  3. for a `mutual-verified` pairing, the pairingId recomputed from OUR current identity key and the pinned key equals the recorded one, so a rotation of our key since verification refuses until re-verified (`encryption-key-not-bound`). An inherited `identity-verified` pairing has no local pairingId; it binds on the pinned key alone.
  The credential is then **encrypted to `edPublicToX25519(pinnedIdentityKey)`** — the RFC 7748 birational map of the pinned key. The relay- or cache-supplied X25519 key is never used on this path. An Ed25519 key's X25519 counterpart is a fixed function of it (our X25519 private key is the clamped first half of SHA-512 of the Ed25519 seed), so a relay cannot substitute the encryption key without also substituting the identity key, which changes the words. A peer whose listener cannot decrypt (for example one that publishes no X25519 key and never decrypts) cannot receive credentials; that fails closed.
  Implemented as `ThreadlineClient.sendCredentialToPinned` (it throws, sending nothing, if the pinned key's fingerprint is not the recipient's). A credential never takes the localhost relay-agent route, which is plaintext: a credential addressed to a co-located agent is judged by the gate and then goes over the relay. The receiver opens it with the key derived from the sender's identity key when it holds only that key; an envelope that does not open that way (every plaintext envelope) goes exactly where it went before, the unknown-sender path, so ordinary messaging is unchanged. Why not the cached key: the production-path E2E shows the real clients never cache an X25519 key for each other (a start caches the identity key only, and relay discovery is keyless), so a gate that required one refused every credential between two fully verified agents.
  Any exception while checking the binding refuses with `encryption-key-not-bound`, not `peer-not-mutually-verified`, so the logs name the real cause.
- **Inbound:** an agent never persists or acts on an inbound payload as a credential unless the resolved sender source is `mutual-verified` or `identity-verified`. Enforced at the credential-ingestion chokepoint. Unchanged.
- The general (non-credential) message path keeps using the cached X25519 key; binding it there is tracked separately (#2117 gap I) because it can break peers that cannot decrypt.

## 3.6 Surfaces
- `POST /threadline/pairing/:peerFp/start` — Bearer (checked in-route); `{clearFailed: true, pin}` clears a denied pairing. 503 when the flag is off or this machine does not hold the relay identity.
- `GET /threadline/pairing` (+ `?scope=pool`) — Bearer (checked in-route); never returns words.
- `GET /threadline/pairing/:peerFp` — Bearer; the 12 words are included only while pending AND with a valid dashboard PIN.
- `POST /threadline/pairing/:peerFp/verify` — `{words, pin}` to confirm by typed comparison, or `{match:false, pin}` to deny.
- MCP tool `threadline_pair` — `start`, `status`, `verify`/`deny` (the last two return the PIN-gated path; the agent cannot confirm). In the stdio MCP process, `status` reads through the server's HTTP route, never its own in-process trust manager, which would be stale after a `start`.
- `GET /threadline/health` — `mutualVerifiedCount`.
- **Dashboard pairing panel (required, Mobile-Complete).** A Threadline-tab panel that lists pairings, shows a pending pairing's 12 numbered words after PIN entry, has 12 inputs for the other side's words with Confirm and Deny, and a PIN-gated Clear for a denied pairing. Works at phone width. The operator never curls a route.

## 3.7 Performance
Unchanged from v1: the trust profile is resolved once per inbound evaluation with an O(1) fingerprint index; the gate reads in-memory state only; SAS and key derivation run once per start or verify, never per message. `edPublicToX25519` runs once per credential send (one modular inversion, sub-millisecond).

## 3.8 Multi-machine posture (FD11)
- **Pending record and words → machine-local by design.** They bind the machine's own identity key, so verification is driven on the machine that holds the relay identity. A machine without it answers 503 on start (it is a relay standby; see `docs/specs/a2a-backup-routes.md`).
- **The `mutual-verified` result → replicated** as before (`multiMachine.stateSync.threadlinePairing`, dark by default), carrying only `{peerFp, peerIdentityPub, state, verifiedAt, verifiedOnMachine}` — never words. A receiving machine records it as **`identity-verified`, pinned to `peerIdentityPub`**.
- **Inherited `identity-verified` and credential-share.** It satisfies the identity half of §3.5. The channel half binds on the pinned key alone (step 2), and the credential is encrypted to the key derived from it, so no local pairingId is needed. A start on that machine for the same key leaves it `identity-verified` (it does not demote it). A revoke or `verification-failed` propagates as a tombstone and wins.
- `GET /threadline/pairing?scope=pool` merges machines as before.

## 3.9 OOB channel assumption
The security of the comparison rests on a channel that is integrity-protected and independent of the relay: a human reading each side's locally rendered words, and typing the other side's words into their own panel. Not acceptable: an automated agent-to-agent word exchange; words relayed by the agent being verified into a channel the operator then trusts as that agent's; any setup where the dashboard and the relay share one compromised host. The words are not secret; the channel's independence is the requirement.

## 3.10 Flagging / rollout
- `threadline.verifiedPairing.enabled` (default off on the fleet, on for development agents). Off → every pairing route answers 503 and no gate applies.
- `threadline.verifiedPairing.dryRun` (default true) governs inbound observability only.
- `threadline.verifiedPairing.credentialShareEnforced` is read live at the gate.
- **Rollback.** Turning the flag off restores legacy behaviour. Reverting the code leaves v2 profiles (`pairingId` v2, `pairingRecordedAt`) in place; v1 code ignores the unknown field, and its weaker gate (no binding check) would then allow credential-share to v2-verified peers, so a code rollback must also turn the flag off. No v1 pairing records exist to migrate, because v1 could never create one.

## 3.11 Decision points touched
- **Start route refusals** — `self-pair`, `fingerprint-mismatch` (cached or card key does not match the fingerprint), `no-key` (neither source has a key), `refused-failed` (denied, no PIN clear), `no-relay-identity` (503), unauthenticated (401). All are exact predicates or authority checks; no heuristic.
- **Verify** — typed words must equal the server's 12 in order; PIN required.
- **Credential gate** — new refusal `encryption-key-not-bound` (§3.5 steps 2–3). A deterministic cryptographic check on an irreversible action (sending a secret): it is a safety guard by design, not a judgment point.
- **Receipt** — `signature-invalid` (checked first), then `receipt-from-future` / `receipt-stale`; each drops with no state change.

## 4. Security threat model
- **Key substitution by the relay:** a substituted identity key changes the words, and the humans catch it. With 12 words, a two-sided collision costs ~2^66 key generations (FD2). A partial collision (8 of 12 words, ~2^44) is defeated by typed full comparison (FD2a).
- **Encryption-key substitution:** the credential path never uses a relay-supplied X25519 key; it derives it from the pinned identity key (§3.5).
- **Our key rotated after verification:** the pairingId no longer matches and the credential gate refuses; the next start resets to pending.
- **Unauthenticated start:** refused (Bearer checked in-route, FD7). A start grants nothing even if it succeeded.
- **Re-opening a denied pairing:** requires the PIN (`clearFailed`); a changed pairingId does not reopen it.
- **Self-grant of `mutual-verified`:** impossible; only the single writer sets it, behind an operator PIN and the typed comparison.
- **Receipt forgery, replay or staleness:** signature first, then pairingId/sasFingerprint binding, then freshness; replay protection and rate limits as before. A receipt only ever sets `peerAcked`.
- **Label or content evasion:** the gate is sender-keyed (FD5).
- **Compromised peer after verification:** existing auto-downgrade drops `mutual-verified` and propagates a tombstone.
- **What the words reveal:** nothing secret. They are public values; showing them only to a PIN-authed operator prevents confusion, not disclosure.

## 5. Migration parity
- **Config:** unchanged keys (`threadline.verifiedPairing.{enabled, dryRun, credentialShareEnforced}`, `multiMachine.stateSync.threadlinePairing`), existence-checked.
- **MCP tool:** `threadline_pair` gains `start`, via the always-overwrite built-in path.
- **CLAUDE.md:** the template describes v2 only (12 words, start, typed comparison). For existing agents, the migration REPLACES the v1 section in place (matched on its heading, idempotent) instead of appending a second, contradicting block. Site docs that say 6 words are updated in the same change.
- **Profiles:** `pairingRecordedAt` is an additive optional field.
- **Rollback:** see §3.10.

## 6. Testing (all three tiers + wiring)
- **Unit:** v2 derivation (12 words, symmetric, sensitive to either key, pinned wordlist); `edPublicToX25519` against `deriveX25519PublicKey` on 200 random keys; start rules (first start, already-pending, already-verified, own-key rotation resets, **denied stays denied even when the pairingId changed**, `clearFailed` reopens, inherited stays inherited); receipt checks in order (signature before freshness), both sides of each 5-minute bound; typed-word comparison (all 12 equal passes; any one wrong fails; reordered fails); fingerprint normalization; binding-check exception reports `encryption-key-not-bound`.
- **Integration (HTTP):** start without Bearer → 401; start on a machine without the relay identity → 503; verify without PIN rejected; verify with typed words; detail never shows words without the PIN; `clearFailed` without PIN rejected.
- **E2E ("feature is alive"), through the REAL boot path.** Two agents built by the production bootstrap (not a hand-built relay client or a hand-filled key cache), connected to an in-process RelayServer. Both start; the start fetches the peer key from the relay's A2A card and fills the cache; both reach pending with the same 12 words; the operator on one side types the other side's words and confirms; a receipt arrives at the peer and sets `peerAcked`; a credential-share to the verified peer is allowed and decrypts on the receiving side; one to an unverified peer is refused. Also: a substituted key gives different words. **No collaborator in this test is constructed by hand where production builds it.**
- **Wiring:** the gate's trust manager is the real one; the verify route mutates via the single writer; the receipt path verifies signatures; the relay-send funnel invokes the gate.
- **Multi-machine:** a replicated result is honored as `identity-verified`, allows credential-share on the pinned key, and is not demoted by a start; a tombstone un-verifies pool-wide.
- **Breakage checks:** each safety check above is disabled once in a scratch worktree, and at least one test must fail.

## 7. Open questions
- **Binding the X25519 key on the ordinary message path** (#2117 gap I) is out of scope here because it can break peers that cannot decrypt. It needs its own change.
- **Dawn's portal listener** cannot decrypt and publishes no X25519 key. It can pair (it computes the same 12 words, `the-portal/.claude/scripts/threadline-pairing-words.cjs`) but cannot receive credentials until it decrypts.

## 8. Completion criteria (for the build)
Merged to main via the instar-dev cycle; all three tiers, wiring, multi-machine and breakage checks green; tsc and lints clean; ships dark behind `threadline.verifiedPairing.*` with outbound enforcement fail-closed; and a REAL pairing completed between two live agents on the relay (Dawn and Scout), with a human typing the other side's 12 words, `mutualVerifiedCount ≥ 1`, and a receipt received.
