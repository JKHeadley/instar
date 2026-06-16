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

- **FD1 — Wordlist (pins C1).** Vendor the canonical **BIP-39 English wordlist** (2048 words, 11 bits/word) as a checked-in file `src/threadline/data/sas-wordlist-en.json`, content-hash pinned in this spec and asserted at load (`sha256` recorded in the file header + a unit test). 6 words = **66 bits** (matches the design intent). Big-endian extraction. A wordlist change forces a new `info` version (`-v2`). Rationale: BIP-39 is audited, offline, exactly 11 bits/word, and widely vendored. **(codex finding 5):** ONLY the fixed 2048-word English array is reused as an index→word table — NONE of BIP-39's mnemonic/checksum/seed/normalization semantics apply (no checksum bits, no PBKDF2, no NFKD mnemonic rules); it is a plain wordlist, chosen for being audited and exactly 11 bits/word.
- **FD2 — SAS bit extraction.** `sasBits = HKDF-SHA256(ikm=sharedSecret, salt=sort(idPubA‖idPubB), info="threadline-sas-v1", L=12 bytes)`. Take the leading 66 bits, big-endian, split into 6 × 11-bit indices into the wordlist.
- **FD2a — SAS comparison UX (codex round-2 finding 2).** BIP-39 gives the entropy but was not designed for live verbal comparison, so the DISPLAY guards against operator mis-match: render the 6 words **numbered 1–6 in fixed order**, in large high-contrast monospaced text, on a **copy-disabled, never-logged** surface (the dashboard pairing panel — §3.6), and require the operator to confirm exact words in exact order. Order matters (a reordered set is a mismatch). This is a UX requirement on the verify panel, not a protocol change. (A future curated verbal-comparison wordlist may replace BIP-39 behind the `-v2` info bump if verbal channels become common; BIP-39 stands for the dashboard-eyeball flow Echo↔Dawn use.)
- **FD3 — `sasFingerprint` (pins C3).** `sasFingerprint = first 8 bytes (hex) of SHA-256("threadline-sas-fp-v1" ‖ sasBits)`. Both sides compute identically; it is the value logged/audited and bound into the receipt — the SAS WORDS are never logged.
- **FD4 — `pairingId` (epoch binding, pins receipt-freshness + C9).** `pairingId = HKDF-SHA256(ikm=sharedSecret, salt=sort(idPubA‖idPubB), info="threadline-pairing-id-v1", L=16)` hex. Identifies THIS handshake instance. `deriveSAS` + `pairingId` are computed **inline at handshake completion** (the live shared secret is in memory then); the raw shared secret is NOT persisted. The pending-verification record persists `{pairingId, peerFp, peerIdentityPub, sasWords, sasFingerprint, createdAt}` to a machine-local 0600 store so the operator can re-read the SAS after a restart; it is discarded on transition. **Any new handshake (new ephemeral keys → new pairingId) resets the pairing to `pending-verification` and discards the prior confirmation + receipt.**
- **FD5 — Credential detection is NOT a content sniff (pins C2).** The security boundary is the SENDER's trust source, never the message's self-declared kind or its content. An explicit `kind:'credential-share'` exists only as a fast-path courtesy + an outbound caller hint; it is NEVER the inbound security input. "Detected as credential-bearing" is removed as a gate input.
- **FD6 — Trust level on mutual-verify.** Set source `mutual-verified` and raise level to `trusted` (never `autonomous`). Only the dedicated single-writer path (FD7) may set this source.
- **FD7 — Verify authority = verified operator (pins F3/route-auth).** `POST /threadline/pairing/:peerFp/verify` requires **dashboard-PIN operator authority** (same bar as `/mandate/issue`); the agent's Bearer token is structurally insufficient to confirm a pairing. The local human SAS-comparison is the load-bearing gate.
- **FD8 — Local human verify is the bar; the peer receipt is OPTIONAL (codex round-2/3 finding, simplified).** `mutual-verified` means **THIS side's operator SAS-confirmed the peer's identity key** (FD7) + the key-pin — that human check is the entire load-bearing security event and is sufficient to authorize credential-share. The peer's signed receipt proves only key-possession + SAS-agreement (which the handshake already proved) — it does NOT prove a human looked, so it is NOT required for `mutual-verified`; it is tracked as an OPTIONAL `peerAcked` liveness flag on the record (nice-to-have: tells you the peer's side computed the same SAS and is live). Making the receipt optional removes a race/strand surface (a lost receipt never blocks a human-verified pairing — see the receipt-liveness note in §3.2). A peer that auto-acks gains nothing: OUR acceptance of THEIR credentials depends on OUR human having SAS-compared, which a peer cannot do for us.
- **FD9 — Fail direction (pins M4).** Under enforcement, ANY error/uncertainty resolving pairing state → **refuse** (fail-closed) for credential-share. The non-credential message path is unaffected (fail-open relative to this feature).
- **FD10 — dryRun split (pins dryRun-soak).** Outbound credential-share enforcement is **fail-closed from day one** — a secret-leak gate must not have an allow-by-default soak. `dryRun` governs ONLY inbound observability + attention verbosity, never the outbound refuse decision.
- **FD11 — Multi-machine posture (pins M1/M5).** See §3.8.
- **FD12 — Self-pair guard.** Reject `peerFp === ownFp` at pairing creation and receipt verification.

## 3.1 SAS derivation
`deriveSAS(sharedSecret, idPubA, idPubB)` per FD1/FD2 — deterministic, identical on both ends, computed inline at handshake completion. Never transmitted; displayed locally per side; the humans compare out-of-band (§3.9).

## 3.2 Pairing lifecycle
`none → handshook (relay token derived) → pending-verification → mutual-verified` (or `verification-failed`).
- After the handshake, the pairing is recorded `pending-verification` with `{pairingId, peerFp, peerIdentityPub, sasWords, sasFingerprint}` (machine-local, 0600).
- Becomes `mutual-verified` when this side's **operator** (FD7) confirms the SAS matches (bound to the current `pairingId`) — that human check is sufficient. A valid inbound peer receipt, if/when it arrives, sets the optional `peerAcked` flag (FD8) but is NOT required for the transition. Without the operator confirm it stays `pending-verification`.
- `verification-failed` = the operator asserts the SAS does NOT match → discard the token, force the peer to `untrusted`, write a durable **per-fingerprint deny record** (suppresses auto-`verified` re-creation + refuses new pairing until an operator clears it), and raise ONE never-coalesced HIGH attention item. **Distinguish** an operator-asserted mismatch (real-MITM → punish) from a derivation/render error (→ retry, do NOT punish the peer or write a deny record).
- **P19 brakes (pins M3):** receipt send is single-shot with bounded retry + backoff; `pending-verification` has a TTL that surfaces ONCE then goes quiet; `verification-failed` never auto-retries the handshake.
- **Receipt liveness coupling — never silently strands (codex round-2 finding 3).** The receipt adds little security (FD8 — it is a liveness ACK), so its ABSENCE must not strand verification: if the inbound receipt never arrives within the bounded retry/TTL, the pairing simply stays `pending-verification` (the safe state — credential-share stays denied) and surfaces ONCE so the operator can re-drive, rather than wedging silently or being treated as failed. A missing receipt is NOT a `verification-failed` (that is reserved for an operator-asserted SAS mismatch). The local operator-confirm + key-pin already establishes the `identity-verified` floor; the receipt only upgrades the record to fully `mutual-verified`.

## 3.3 Trust source + operation model (structurally un-self-grantable)
- Add trust source `'mutual-verified'` and operation `'credential-share'`.
- `credential-share` is in the allowed-operation set ONLY for a peer whose trust source is `mutual-verified` AND level ≥ `trusted`. Never granted by `autonomous` alone, never by `setup-default`/auto-handshake.
- **Single-writer (pins F-trust-source/F4):** a dedicated `markMutualVerified(peerFp, {pairingId, operatorConfirm, peerAcked?})` is the ONLY code path that may set source `mutual-verified`; it verifies the **operator-confirm precondition** (PIN-authed, current `pairingId`) itself and sets source+level atomically. `peerAcked` (the optional verified receipt) is recorded if present but is not a precondition. The generic `applyTrustLevel`/`setTrustLevelByFingerprint` **rejects** `source==='mutual-verified'` as input (returns false). Wiring test asserts the generic path rejects it. **Unknown/forward-incompat source values degrade to un-verified (never elevated)** so a downgrade-rollback can't silently grant credential-share.

## 3.4 Peer verification receipt
`receipt = sign(idPriv, "threadline-pair-verify-v1" ‖ pairingId ‖ ownFp ‖ peerFp ‖ sasFingerprint)`, delivered as a **gate-exempt control-plane message kind** (`pair-verify`, like `probe`) processed BEFORE the trust gate (pins C4 bootstrap-ordering) and never subject to credential-share enforcement. When a receipt arrives, the receiver verifies: signature against the identity pubkey **bound into the live handshake state for that `pairingId`** (not merely the relay-supplied fingerprint); `pairingId` + `sasFingerprint` match the local pending record; pairing is in `pending-verification` or already `mutual-verified` (a late receipt just sets `peerAcked`). **Anti-confabulation (pins m2):** the flip to `mutual-verified` requires a real PIN-authed operator confirmation, and `peerAcked` is set ONLY by a real signature-verified INBOUND receipt — never a self-asserted/narrated one.

**Control-plane exempt ≠ security-exempt (codex finding 2, MATERIAL).** `pair-verify` being gate-exempt means it bypasses ONLY the *trust-level/credential* gate (so the bootstrap message can arrive before trust is raised). It is still subject, BEFORE any state mutation, to: strict schema validation (reject malformed payloads), Ed25519 signature verification, the `pairingId`/`pending-verification` lookup above, payload size limits, replay protection (the existing `seenMessageIds`), and per-peer rate limits. A `pair-verify` message that fails any of these is dropped with no effect on pairing state.

## 3.5 Credential-share gate — the "credential workflow gate" (structural chokepoint, sender-keyed)
**Naming honesty (codex round-3 finding 3):** this is a **credential-workflow authorization gate**, not a universal secret-exfiltration-prevention control. It guarantees the *sanctioned* credential path requires a verified peer; it does not claim to stop a secret pasted into free text (that is the ExternalOperationGate/DLP family). The sanctioned credential path is the ONLY affordance offered to skills/agents for sharing a credential, so "use the gate" is the path of least resistance, not an extra step to remember.
- **Outbound (load-bearing, pins M2/F1/M1-plaintext):** enforced INSIDE the `/threadline/relay-send` funnel as a gate sibling to the existing send gates — NOT a voluntary helper. A credential-bearing outbound (caller passes `kind:'credential-share'`, or the agent calls the funnel's credential path) is **refused unless the recipient peer is `mutual-verified`**, AND refused if the only available send path is `sendPlaintext` (a credential must traverse the encrypted+signed path only). Fail-closed (FD9). `assertCanShareCredential(peerFp)` remains as an agent-facing READ, but the guarantee lives at the funnel.
- **Inbound (pins F1/C1):** the boundary is on the RECEIVER acting: an instar agent must never persist/act on an inbound payload **as a credential** unless the source peer is `mutual-verified`. Enforced at the credential-ingestion chokepoint, keyed on the resolved sender trust source — independent of the message's self-declared kind. A fast-path `kind`-based refusal is courtesy only, explicitly NOT the security boundary.
- Keys on WHO the peer is (trust source), never on message meaning — consistent with the single-negotiator principle.
- **Honest scope (codex finding 3, MATERIAL):** this gate protects the *sanctioned* credential-sharing path — the `kind:'credential-share'` send and the credential-ingestion chokepoint. It is NOT a DLP/exfiltration detector: an agent that pastes a secret into an ordinary free-text message is not caught structurally by THIS gate (catching that is content-classification, which FD5 deliberately rejects as a security boundary). The guarantee is precise: "a credential sent through the credential path, or accepted as a credential, requires a `mutual-verified` peer" — not "no secret can ever appear in any message." Free-text exfiltration is the ExternalOperationGate/DLP family's concern, separate and composed-with.
- **ExternalOperationGate layering (pins m3):** credential-share is also an external mutation; this gate is the Threadline-specific arm and composes with (does not replace) the ExternalOperationGate family.

## 3.6 Surfaces
- `GET /threadline/pairing` (+ `?scope=pool`, §3.8) → pairings `{ peerFp, peerName, state, verifiedAt?, trustSource, machineId? }`. **SAS words shown only via `GET /threadline/pairing/:peerFp` to a dashboard-PIN-authenticated operator request while `pending-verification`.**
- `POST /threadline/pairing/:peerFp/verify { match: true|false }` → operator (PIN, FD7) confirms/denies.
- MCP tool `threadline_pair` (`status`/`verify`/`deny`).
- `GET /threadline/health` adds `mutualVerifiedCount` (per-machine; pool read via `?scope=pool`).
- **Dashboard:** a Threadline-tab pairing panel renders pending SAS + the verify/deny buttons (Mobile-Complete Operator Action — the operator never curls a SAS).
- All routes require Bearer auth; the verify route additionally requires the dashboard PIN.

## 3.7 Performance (pins F1/F2/F5)
- Resolve the trust profile **once** per `InboundMessageGate.evaluate()` and thread trust-level/allowed-ops/trust-source through it; add a `fingerprint→profile` Map index so the lookup is O(1) (removes the existing 3× O(N) scan the gate would otherwise compound).
- The gate reads pairing/trust-source from **in-memory** state only — never a per-message disk read. Persist on transition, debounced.
- **Single source of truth:** store the pairing state ON the trust profile (single file, single atomic writer) so there is no cross-file torn state; write order is receipt-verified → record written → **trust source set LAST**, so a partial failure fails closed.
- SAS/HKDF + receipt sign/verify are one-shot per handshake/verify, never per message; `sasFingerprint` is stored, never re-derived on the message path.
- Credential check sits at/after the existing replay+size+rate cheap rejections; `verification-failed` re-attempts hit existing `untrusted` rate limits (5/hr) so a re-handshake storm can't loop fast; the failure attention item dedups per `(peerFp)` episode with cooldown.

## 3.8 Multi-machine posture (FD11)
The agent runs on multiple machines. Posture per surface:
- **SAS state + `pending-verification` record + the shared secret** → **machine-local BY DESIGN.** The SAS is bound to the machine-local handshake's ephemeral shared secret (machine A and B derive different secrets/SAS for the same peer). Verification must be driven on the machine holding the live handshake. The relay token + identity keys are already machine-local (`scope: machine-local, transport: none`).
- **The `mutual-verified` RESULT** (the human's identity decision) → **replicated**, since Dawn's identity is Dawn's identity regardless of which Echo machine compared SAS. Add `multiMachine.stateSync.threadlinePairing` (ships dark: `enabled:false, dryRun:true`) replicating ONLY `{ peerFp, peerIdentityPub, state:'mutual-verified', verifiedAt, verifiedOnMachine }` — **NEVER the SAS, shared secret, or relay token.** Rides the SAME hardened machinery as the WS2 PII stores: type-clamp on receive (`verifiedAt` ISO-8601-only), untrusted-envelope, fingerprint-keyed identity, tombstone on revoke. Machine B treats a replicated `mutual-verified` record as an **identity-binding fact it does NOT re-derive/re-verify** (it cannot — it lacks the secret); a `verification-failed`/revoke propagates as a tombstone so an un-verify sticks pool-wide.
  - **Identity-key pinning (codex finding 1, MATERIAL):** machine B honors a replicated `mutual-verified` record ONLY by pinning the record's `peerIdentityPub`. Any handshake on B for that `peerFp` whose presented identity key does NOT match the pinned `peerIdentityPub` is refused the inherited verification and **downgraded to `pending-verification`** (re-verify on B) — never silently `untrusted`-but-honored and never auto-`mutual-verified`. The replicated grant binds to the exact identity key the human verified; a different key on B means the inheritance does not apply. (The `peerFp` is itself the first 16 bytes of that key, so a mismatch is a fingerprint-collision/substitution attempt and is logged as such.)
  - **Inherited = `identity-verified`, NOT channel-ready (codex round-2 finding 1).** The replicated record asserts only that *this identity key was SAS-verified by a human somewhere* — call this inherited state `identity-verified`. Before machine B may actually open the `credential-share` operation to that peer, B must additionally have its OWN live, machine-local, **encrypted+signed** handshake channel to it (which B needs anyway to send a credential — never the plaintext fallback, §3.5). The replicated record removes the need to RE-SAS on B (the human's identity decision is honored, key-pinned); it does NOT by itself imply B's channel is ready. So credential-share on B = inherited `identity-verified` (key-pinned) AND B's own live encrypted channel. This keeps the guarantee honest: "this identity key was human-verified" + "this machine has a real encrypted path to it," never "replicated state alone = go."
- **`/threadline/pairing` + `mutualVerifiedCount`** → **proxied-on-read** via `?scope=pool` (merged, dark-peer-tolerant), so "is my channel to Dawn verified?" gives one consistent answer regardless of fronting machine. Completion criterion asserts `≥1` on the verifying machine + the replicated read on a peer machine.
- **Coherence registry (pins M2):** add entries for `threadline/trust-profiles.json` and the pairing store with explicit `scope` (machine-local for SAS/pending; the replicated result via the stateSync transport). Today `trust-profiles.json` is unregistered — this feature makes it credential-gating, so the gap is closed deliberately.
- **Attention dedup** for `verification-failed` coalesces pool-wide (P17), not once-per-machine.

## 3.9 OOB channel assumption (pins F-OOB/F8/m4; codex finding 4)
SAS verification's security rests on the comparison channel being **integrity-protected and INDEPENDENT of the threatened Threadline relay** — NOT on the SAS being secret. Operationally, an **acceptable OOB channel** is one where a HUMAN compares the SAS rendered LOCALLY at each endpoint (the dashboard pairing panel on each side, or each agent's own surface), over a channel **not mediated by the Threadline relay nor by either unverified peer agent**. The operator reading both agents' locally-rendered SAS with their own eyes satisfies this. **Explicitly NOT acceptable:** (a) an automated agent-to-agent SAS exchange (a MITM that swapped keys also swaps the words); (b) SAS words emitted by the very agent being verified into a channel the operator then trusts as that agent's; (c) any path where the dashboard/Telegram surface and the Threadline relay share a single compromised host such that the same attacker controls both. The load-bearing requirement is local rendering + human eyes over a relay-independent surface.

## 3.10 Flagging / rollout
- `threadline.verifiedPairing.enabled` (default false fleet; dev-live). Off → new routes 503, no gate applied, byte-identical legacy behavior.
- `threadline.verifiedPairing.dryRun` (default true): governs inbound observability + attention verbosity ONLY (per FD10; outbound refusal is always live when enabled).
- `threadline.verifiedPairing.credentialShareEnforced`: read live at the gate chokepoint (no restart) — arms inbound enforcement.

## 4. Security threat model
- **Relay fingerprint/ephemeral-key substitution / MITM:** defeated by SAS — a substitution yields a different shared secret → different SAS words → the humans catch the mismatch. Core threat.
- **Single-party fake "mutual":** the peer receipt is a liveness ACK only (FD8); OUR acceptance of THEIR credentials depends on OUR operator's SAS comparison (FD7), which a peer cannot perform for us.
- **Self-grant of `mutual-verified`:** impossible — only `markMutualVerified` sets it, gated on operator-confirm + verified receipt; the generic setter rejects the source (§3.3).
- **Receipt replay / stale-SAS / cross-pairing:** the receipt binds `pairingId` (epoch) + `sasFingerprint`; a new handshake resets state and invalidates prior receipts; receipts for non-`pending-verification` pairings are rejected; self-pair (`peerFp==ownFp`) rejected.
- **Label/content evasion:** the gate is sender-keyed, not label/content — mislabeling cannot smuggle a credential past an unverified peer (FD5); a credential cannot leave over the plaintext fallback.
- **Verify-route auth bypass:** verify requires operator PIN, not the agent Bearer token (FD7).
- **Compromised peer post-verification:** covered by existing auto-downgrade (crypto-failure/circuit-breaker) which drops `mutual-verified`→`untrusted` and revokes credential-share + propagates a tombstone; plus a `verifiedAt` staleness re-verify policy (mirrors the 90-day trust staleness).
- **Suppressed MITM alert:** `verification-failed` is never-coalesced HIGH, durable, and its write failure is itself surfaced (not swallowed).
- **No secret material on any read surface:** SAS words shown only to a PIN-authed operator while pending; never logged (only `sasFingerprint`); shared secret/relay token never replicated or served.

## 5. Migration parity (complete enumeration)
- **Config:** `migrateConfig` existence-checks add `threadline.verifiedPairing.{enabled:false, dryRun:true, credentialShareEnforced:false}` and `multiMachine.stateSync.threadlinePairing.{enabled:false, dryRun:true}` (only missing keys).
- **MCP tool:** register `threadline_pair` in the Threadline MCP server via the always-overwrite built-in path so existing agents get it on update (confirm not install-if-missing).
- **CLAUDE.md awareness (P5):** `generateClaudeMd` gains a Verified-Pairing section ("is my channel to <peer> mutually verified? → `GET /threadline/pairing`; to pair: drive `threadline_pair`/the dashboard verify; never send a peer a secret until `mutual-verified`"); `migrateClaudeMd` adds it to existing agents via a content-sniff guard.
- **Coherence registry:** add the entries from §3.8.
- **Enum forward-compat:** the new `source`/operation are additive; old binaries treat unknown `source` as un-verified (never elevated). `verification-failed` recovery (re-pair) is documented; confirm the relay-token discard does not strand a live thread (and if it could, the user is told).
- Pure-code otherwise; idempotent migrations.

## 6. Testing (all three tiers + wiring)
- **Unit:** `deriveSAS` determinism (both sides identical; different secret → different SAS; identity-key order-independence; wordlist content-hash asserted); `sasFingerprint`/`pairingId` derivation; receipt sign/verify incl. wrong-pairingId/wrong-pair rejection; pairing state machine incl. failure + new-handshake-reset; `markMutualVerified` is the sole writer + generic setter REJECTS the source; unknown-source degrades un-verified; credential-share allowed iff `mutual-verified`+`trusted`; self-pair rejected; profile resolved once / O(1) index.
- **Integration (HTTP):** `/threadline/pairing*` — 503 when flag off; list/detail/verify(true via PIN)/verify(false) when on; verify WITHOUT PIN rejected (401/403); SAS not shown without PIN; credential-share refusal reason `peer-not-mutually-verified` surfaced; `?scope=pool` merged read.
- **E2E ("feature is alive"):** prod init path → flag on → two in-process agents handshake → both verify matching SAS (operator-PIN path) → reaches `mutual-verified` → a credential-share to that peer is allowed; a non-verified peer's credential-share is refused (fail-closed); credential over plaintext-fallback refused. Returns 200, not 503.
- **Wiring-integrity:** the gate's `AgentTrustManager` dep is the real one (not null/no-op); the verify route actually mutates via `markMutualVerified`; the receipt path actually verifies signatures; the relay-send funnel actually invokes the credential gate; the flip requires a real verified inbound receipt (anti-confabulation).
- **Burst/flood invariant:** a `verification-failed` re-attempt LOOP from one peer raises ONE aggregated attention item + is rate-limited, never one-per-attempt; pool-wide coalesce.
- **Multi-machine:** a `mutual-verified` result replicates (dark/dryRun off→on) and is honored on a peer machine WITHOUT re-deriving SAS; a revoke tombstone un-verifies pool-wide; SAS/secret/token never appear in the replicated payload.

## 7. Open questions
*(none — all resolved into §3 Frontloaded Decisions)*

## 8. Completion criteria (for the build)
Built + merged to main via the smooth dev cycle (PR# + squash SHA), all 3 test tiers + wiring + multi-machine + burst tests green, tsc + lints clean, ships dark behind `threadline.verifiedPairing.*` with outbound enforcement fail-closed, and a REAL `mutual-verified` pairing completed with Dawn (surface `mutualVerifiedCount ≥ 1` with Dawn's fingerprint, the replicated read on a second machine, and a credential-share round-trip refused-then-allowed across the verification boundary).
