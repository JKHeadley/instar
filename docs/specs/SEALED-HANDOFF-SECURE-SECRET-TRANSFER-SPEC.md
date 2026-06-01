# Sealed Handoff — Secure Agent-to-Agent Secret Transfer

**Status:** approved: true (Dawn two-party convergence 2026-05-31; Justin approved + #657 merged/released 1.3.189 on 2026-06-01; R2 refined to trust-gated per Justin's 2026-06-01 directive — high trust on both axes needs no operator approval)
**Author:** echo (Instar agent / instar builder)
**Directive:** Justin — "you both need to figure out a way to send secrets securely; this is critical for agent-agent communication." Converged as a two-party security review with Dawn.

---

## 1. Problem

Agents need to hand each other live credentials (API tokens, keys) without a human couriering them. Today there is **no safe channel**:

- **Threadline relay messages are already E2E-encrypted in transit** (X25519 ECDH + XChaCha20-Poly1305, ephemeral per-message keys, forward secrecy — `MessageEncryptor.ts`). The relay only ever sees ciphertext. **Transit is NOT the gap.**
- **The real leak is post-decryption, at-rest + surfacing:** on receipt, instar writes the *decrypted* message to plaintext stores (`collaboration-surface.json`, the inbox JSONL) and the salience layer routes message content to a Telegram topic. Observed live this session: an "unbridged" thread (no `originTopicId`) STILL surfaced replies to topic 12476 via fallback salience. So a credential "sent over the relay" lands in plaintext logs and possibly chat.

Peer agent Dawn correctly refused to send a credential over the relay for exactly this reason. This spec is the durable fix.

## 2. Goal

A secret travels from sender agent → receiver agent such that it is **never written to any plaintext store, never routed to Telegram, and never present in any relay message** — with mutual cryptographic authentication and a structural operator-authorization gate.

## 3. Mechanism — "Sealed Handoff"

The secret value rides **HTTPS into a one-time, in-memory, never-on-disk store** (Secret Drop's proven model). Only a **write-only submission address** and signed metadata cross the E2E relay.

```
Receiver R (wants secret)                         Sender S (holds secret)
─────────────────────────                         ───────────────────────
1. mint one-time Secret Drop request
   → write-only submit URL (in-mem, TTL,
     single-use, never-on-disk)
2. build INVITATION, Ed25519-signed by R:
   { recipientFingerprint, submitUrlHost,
     tlsCertFingerprint, nonce, expiry,
     requestId }
        ── invitation over E2E relay ──▶   3. verify invitation sig against R's PINNED key
                                              verify submitUrlHost + tlsCertFp match before POST
                                           4. POST secret over HTTPS to submit URL,
                                              payload Ed25519-signed by S
5. on submit: verify S's signature against
   S's pinned key BEFORE accept; reject
   unsigned / wrong-key / replayed
6. secret held in-memory only; retrieve
   server-side via hardened reader; never
   written to plaintext, never to Telegram
```

## 4. Structural requirements (non-optional — from Dawn's security review)

### R1 — Two-sided authentication
- **R1a (sender-signature):** the submitted payload MUST be Ed25519-signed by the sender and verified server-side **before accept**. Recipient-binding + single-use + write-only = "first-POST-wins"; without sender-auth an intercepted URL lets an attacker **race the real sender or inject a poisoned token**. Reject unsigned / wrong-key / replayed submissions.
- **R1b (endpoint + cert pinning):** the submit **host + TLS cert-fingerprint** are signed *inside* the invitation, so the sender validates the destination against the receiver's key before POSTing. Defeats a relay-swapped collector URL. NOT "trust HTTPS to whatever host you're handed."

### R2 — Operator-confirm gate (requester ≠ authorizer)
- The agent **requesting** a secret CANNOT be the agent **authorizing** the transfer. Enforced **in code**, not convention.
- A relayed "the operator said go" is **NOT** valid authorization (the requester could be lying or compromised). The operator authorizes the *holder* (sender) **directly, out-of-band**.
- Receiver-side behavioral backstop (Dawn's First No): a ready-frame from the requester is a *status update*, never a trigger; the holder acts only on the operator's direct, off-relay word. The code gate is the structural layer; the behavioral gate is defense-in-depth.

### R3 — At-rest invariant (tested + attested)
- The secret is **never** persisted to plaintext (`collaboration-surface.json`, inbox, conversation stores) and **never** routed to Telegram/salience.
- This MUST be a **tested invariant** (Phase-3 E2E) with an **attestation** the peer can check — that is exactly where the original leak lived, and the peer cannot audit our runtime.

## 5. Identity / trust prerequisites (out of band; parallel to build)
- Trust is **net-new**, not restored: a peer cannot distinguish "echo rotated keys" from "someone impersonating echo" without a continuity proof. echo's Threadline identity rotated `34df4f05` (April 2026) → `63b1dbb2` (current); the old key is unavailable, so **no continuity proof exists**. The operator makes a **fresh** trust pin of the current fingerprint.
- **Follow-up gap (separate work):** Threadline identity rotation silently breaks peer trust. Add a continuity mechanism (old-key-signs-new rotation record, or operator-attested rotation log) so a future rotation is verifiable, not a fresh trust reset.

## 6. Build surface

Reuse existing battle-tested primitives — **no new crypto**:
- **Secret Drop store** — in-memory, one-time, never-on-disk, TTL. Extend submit path to verify a sender Ed25519 signature (R1a).
- **`SecureInvitation`** (`src/threadline/SecureInvitation.ts`) — Ed25519-signed, single-use, recipient-bound, nonce-protected, short-lived. Extend the signed token body to carry `submitUrlHost` + `tlsCertFingerprint` (R1b).
- **Threadline E2E** (`MessageEncryptor`) — carries the invitation envelope over the relay.

New / changed:
- **Keystone — agent self-mint:** an agent must mint its own Secret Drop request. Today blocked: the agent's own `authToken` is externalized (`{secret:true}`), so a bash bearer 403s. Add a **sanctioned internal/local-trusted path** (in-process call, or a localhost-only loopback that does not require the externalized bearer) — NOT by scraping the vault.
- **Operator-confirm gate** (R2) in the accept path: a transfer is only completed when an operator authorization record (out-of-band, bound to the holder) is present; requester identity ≠ authorizer identity enforced.
- **Ergonomic wrapper:** `threadline_request_secret` (receiver) + a sender-side submit helper, so agents don't hand-roll the dance.

## 7. Test strategy (3-tier — TESTING-INTEGRITY-SPEC)

- **Unit (`tests/unit/`):** invitation sign/verify incl. host+certFp binding (R1b); submit-signature verify accept/reject for unsigned/wrong-key/replayed (R1a); requester≠authorizer gate both sides of the boundary (R2); self-mint path returns a usable one-time URL.
- **Integration (`tests/integration/`):** full HTTP submit→verify→retrieve pipeline; relay-swapped-host invitation is rejected; operator-confirm gate blocks a transfer with no/wrong authorization record.
- **E2E (`tests/e2e/`):** the **at-rest invariant** (R3) — drive a real sealed handoff, then assert the secret value appears in NONE of: `collaboration-surface.json`, inbox JSONL, conversation stores, any Telegram-routed payload; and the attestation endpoint reports the invariant held. This is the single most important test (it guards the original leak).
- **Wiring-integrity:** the request/submit routes are mounted and the gate is constructed at boot (grep key-links), not dead code.

## 8. Must-haves (Phase 0.5, goal-backward)
- TRUTH: a secret sent via sealed handoff is retrievable by the receiver AND absent from every plaintext store + Telegram payload (E2E-tested).
- TRUTH: an unsigned or wrong-sender-key submit is rejected with no secret stored.
- TRUTH: a transfer with no operator authorization record is blocked, even given a valid relayed "go".
- TRUTH: an agent can mint its own one-time submit URL without the externalized bearer.
- ARTIFACT: spec (this file); request/submit routes; gate module; SecureInvitation host+cert extension; 3-tier tests.
- KEY LINK: server boot constructs the gate + mounts the request/submit routes (WIRED grep).

## 9. Threats (STRIDE, abbreviated)
| ID | Category | Threat | Mitigation | Bound test |
|----|----------|--------|------------|-----------|
| T-01 | Tampering/Spoofing | intercepted submit URL → attacker races/poisons | R1a sender-signature verify before accept | unit: submit-sig reject |
| T-02 | Spoofing | relay-swapped collector URL | R1b host+certFp signed in invitation | unit: invitation host-binding |
| T-03 | Elevation | requester self-authorizes the transfer | R2 requester≠authorizer code gate | integration: gate blocks |
| T-04 | Info disclosure | secret written to plaintext/Telegram (the original leak) | R3 at-rest invariant | e2e: at-rest invariant |
| T-05 | Repudiation | who authorized? | audit record of operator authorization (Phase 4) | integration: audit row |

## 10. Out of scope / deferred (with backing)
- Identity-rotation continuity mechanism (§5 follow-up) — separate spec.
- Operator authorization UX (how Justin issues the out-of-band confirm) — minimal first cut; richer flow later.
