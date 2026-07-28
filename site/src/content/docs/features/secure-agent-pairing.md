---
title: Secure Agent Pairing (Verified Pairing)
description: Mutual out-of-band identity verification (a 6-word SAS) that lets two agents prove who they're talking to before any credential is shared — defeating relay/man-in-the-middle substitution.
---

Two Instar agents on different machines can already exchange encrypted, signed messages. What they could *not* do is **prove** the agent on the other end is the one their operator actually trusts, rather than an impostor sitting in the middle swapping identities. That gap had a concrete cost: an agent correctly *refused* to send a credential to a peer it couldn't verify. Secure Agent Pairing closes it.

It works like verifying a contact on Signal or pairing Bluetooth headphones: both agents compute the **same short 6-word code** from their handshake, a human (the operator) confirms the two codes match out-of-band, and only then can the two agents share a credential.

## What it does

- **Out-of-band identity verification (SAS).** From the handshake's shared secret, both sides deterministically derive an identical 6-word **Short Authentication String** (66 bits, from a vendored BIP-39 wordlist). A man-in-the-middle who substituted a key produces a *different* shared secret — so the two codes won't match, and the operator catches it. The SAS is never transmitted; only a non-reversible `sasFingerprint` is ever logged.
- **Operator-confirmed, not self-granted.** Confirming a match requires the operator's **dashboard PIN** — the agent's own API token is structurally insufficient. An agent can never approve its own pairing.
- **A credential-share gate that fails closed.** Once two agents are *mutually verified*, a dedicated `credential-share` operation opens between them. A credential send to a peer that is **not** mutually verified is refused, refused over any unencrypted path, and refused on any uncertainty (fail-closed).
- **The verification follows you across machines.** A pairing verified on one machine is honored on your others — but only after pinning the peer's exact identity key. The secret material (the SAS, the shared secret, the relay token) never leaves the machine that made it.

## How it works under the hood

The cryptographic foundation already existed in Threadline — Secure Agent Pairing adds the *identity-binding* and *policy* layer on top of it:

- **`ThreadlineCrypto`** gains the SAS primitives: `deriveSAS` (the 6 words), `deriveSasFingerprint` (the loggable fingerprint), and `derivePairingId` (a per-handshake epoch id that invalidates a stale verification when a new handshake replaces it). These reuse the same HKDF-SHA256 that `ThreadlineCrypto` already uses for the relay token, with domain-separated `info` strings so the SAS, fingerprint, pairing id, and relay token can never collide.
- **`HandshakeManager`** is where the SAS is derived inline at handshake completion (the live shared secret is in memory there); the raw secret is never persisted.
- **`AgentTrustManager`** records the result. It gains a new trust source, `mutual-verified`, that is **structurally un-self-grantable**: only the dedicated `markMutualVerified` method can set it, the generic trust setter rejects it, and an unknown trust source degrades to un-verified. The pairing state lives on the trust profile itself (a single atomic writer), so there is no torn cross-file state.
- **`PairingPendingStore`** holds the SAS words for an in-progress verification in a machine-local `0600` file, so the operator can re-read the code after a restart; it is discarded the moment the pairing resolves. The words live here, never in the replicated trust profile.
- **`CredentialShareGate`** is the enforcement chokepoint. Its `assertCanShareCredential` is the agent-facing read, but the real guarantee lives inside the relay-send funnel: every outbound credential passes through it, keyed on *who the peer is* (their trust source), never on a message label or content the sender controls. It refuses a credential over the plaintext fallback path (`MessageEncryptor`'s encrypted+signed path only).
- **`PairVerifyReceipt`** handles the `pair-verify` control-plane message — the peer's signed acknowledgement that it computed the same SAS. The receipt is fully validated (Ed25519 signature against the pinned identity key, pairing-id match, fingerprint match, replay protection) before it can change anything, and it can only set an optional liveness flag — it can never flip a pairing to verified on its own. The operator's confirmation is the load-bearing step.
- **`InboundMessageGate`** routes an inbound credential-bearing message through the same sender-keyed decision, so an unverified peer's payload is never acted on as a credential.
- **`ThreadlinePairingReplicatedStore`** replicates *only* the verified-identity result `{ peerFp, peerIdentityPub, state, verifiedAt, verifiedOnMachine }` across your machines, riding the same hardened multi-machine state-sync machinery as the relationships and learnings stores. It can never carry the SAS, the shared secret, or the relay token — the serializer projects an explicit closed field set. A machine honors an inherited verification only by pinning the peer's identity key, and still requires its own live encrypted channel before a credential can flow.

## Using it

- **Is my channel to a peer mutually verified?** `GET /threadline/pairing` lists every pairing and its state; `GET /threadline/pairing/:peerFp` shows one (the SAS words appear only while pending **and** only to a PIN-authenticated operator request).
- **To pair:** drive the `threadline_pair` MCP tool (`status`) or the dashboard pairing panel to see the pending code, compare it with the peer's, and confirm the match — the confirm (`POST /threadline/pairing/:peerFp/verify`) requires your dashboard PIN.
- **Never send a peer a secret until the pairing shows `mutual-verified`** — the gate enforces this, but knowing it lets you pair *first* instead of hitting a refusal.
- A failed match (a probable man-in-the-middle) raises a single high-priority attention item and forces the peer back to untrusted.

## Safety posture

The whole feature ships **dark**: the credential gate is behind `threadline.verifiedPairing.*` and the cross-machine replication behind `multiMachine.stateSync.threadlinePairing` (hard-dark by default). When disabled, behavior is byte-identical to before. When enabled, the credential-leak protection is fail-closed from the first moment — a leak-prevention gate has no "log it but allow it anyway" warm-up. It is precise about scope: it guards the sanctioned credential-sharing path, not arbitrary secrets pasted into free-text messages (that is the External Operation Gate's concern).
