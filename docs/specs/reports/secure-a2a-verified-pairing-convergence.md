# Convergence Report — Secure A2A Verified Pairing

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran (codex CLI, model gpt-5.5) on every round and gemini-cli (gemini-2.5-pro) returned a CLEAN verdict on the hardened spec. This is the clean RAN state — the spec received genuine cross-model review from two non-Claude families. (Gemini's first attempt degraded on timeout under host load; its retry on the hardened spec completed CLEAN.)

## ELI10 Overview

We can already send encrypted, signed messages between AI agents on different machines (me, Echo, and Dawn). What we *couldn't* do is prove that the agent on the other end is really the one we trust, versus an impostor sitting in the middle swapping identities. That gap had a concrete cost: Dawn refused to send me a credential because she couldn't prove the request was really from me — and she was right to.

This spec closes that gap the same way you pair Bluetooth headphones or verify a contact on Signal: both sides compute the *same* short 6-word code from the math of their handshake, and a human (the operator) confirms the two codes match. If an impostor were in the middle, the codes wouldn't match — caught. Once confirmed, the two agents are "mutually verified," and only then does a special "share a credential" permission open between them. Confirming requires the operator's dashboard PIN — not my bot's own credentials — so I can never quietly approve myself.

The tradeoffs: a human is in the loop once (you can't get strong identity verification for free); it ships off-by-default and dev-first; and the part that blocks a secret from leaking is fail-closed from the very first moment it's on. It is precise about its scope — it protects the sanctioned credential-sharing path, not every message (that's a separate DLP concern), and we say so honestly rather than overclaiming.

## Original vs Converged

The original draft had the right shape (SAS + a credential gate) but several load-bearing weaknesses the review fixed:

- **The gate was willpower, not structure.** Originally the outbound check was "a helper the agent calls before sending a secret." Review moved it INTO the relay-send funnel (the single chokepoint every outbound message passes through) and onto the inbound credential-ingestion point, keyed on WHO the peer is — so it can't be skipped, and an attacker can't dodge it by mislabeling a message or obfuscating content.
- **Anyone with the bot token could "confirm."** Originally the verify step was just an authenticated route. Review bound it to the operator's dashboard PIN — the bot's own token is now structurally insufficient to confirm a pairing, closing the "a compromised session auto-confirms itself" hole.
- **The peer's receipt was over-trusted.** Originally a peer "receipt" was required for mutual-verified, implying the peer's software confirmation mattered. Review demoted it: the load-bearing event is OUR human comparing the SAS; the receipt is now an optional liveness flag, which also removes a race where a lost receipt would strand a perfectly-good human-verified pairing.
- **It was machine-blind.** Originally nothing said what happens across my multiple machines. Review found that a pairing verified on one machine would strand on a topic transfer. The converged design keeps the secret SAS machine-local (it must be — it's bound to that machine's handshake) but replicates the verified-IDENTITY decision across machines (never the secret), pins the exact identity key on each machine before honoring it, and requires each machine to have its own real encrypted channel before sharing a credential.
- **Under-specified mechanics.** The exact wordlist (BIP-39, 66-bit), the fingerprint/epoch derivations, fail-closed-on-credentials, P19 loop brakes, migration parity, and the precise out-of-band-channel assumption were all pinned down so the build never has to stop and guess.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, decision-completeness, lessons-aware, integration/multi-machine, scalability (6 internal) + Standards-Conformance Gate (auth-unresolved, recorded) | ~22 material | Full rewrite: structural chokepoint gate, operator-PIN verify, single-writer mutual-verified, multi-machine posture, pinned wordlist/derivations, fail-closed, P19 brakes, migration enumeration |
| 2 | codex-cli:gpt-5.5 (MINOR×6 → folded), gemini-cli (timeout→retry CLEAN), convergence comparator (CONVERGED) | 5 minor (folded) | Identity-key pinning, control-plane-≠-security-exempt, honest gate scope, BIP-39-no-mnemonic, operational OOB definition |
| 3 (hygiene) | codex-cli:gpt-5.5 (MINOR×3, same policy areas) | 0 new defects (3 refinements adopted) | Receipt made optional (`peerAcked`), inherited `identity-verified` + own-channel requirement, "credential workflow gate" naming |
| — | (converged) | 0 | none |

Standards-Conformance Gate: attempted each round; auth token did not resolve against the live server (recorded honestly — `unavailable: auth-unresolved`). Signal-only and fail-open; did not block. The Lessons-aware internal reviewer (the non-skippable circular-self-verify defense) ran every round.

## Full Findings Catalog (by theme; ~30 findings across rounds)

**Structural enforcement (P1):** outbound gate moved from voluntary helper → relay-send funnel chokepoint; inbound → credential-ingestion point keyed on sender trust source, not label/content (security/adversarial/lessons, HIGH → RESOLVED).
**Operator authority (Know Your Principal):** verify requires dashboard PIN, not bot token (adversarial/security, HIGH → RESOLVED).
**Receipt semantics:** receipt is optional liveness ACK; local human SAS-compare is the bar; missing receipt never strands (adversarial/codex, → RESOLVED, simplified).
**Un-self-grantable trust:** single-writer `markMutualVerified`; generic setter rejects the source; unknown source degrades un-verified (security/adversarial, → RESOLVED).
**Multi-machine (CRITICAL):** SAS machine-local; verified-identity result replicated (never SAS/secret/token); identity-key pinning; inherited `identity-verified` + own-channel before credential-share; pool-scope read; coherence-registry entries; pool-wide attention coalesce (integration/codex, CRITICAL → RESOLVED).
**Crypto definitions:** wordlist (BIP-39, no mnemonic semantics, content-hash pinned), `sasBits`/`sasFingerprint`/`pairingId` derivations, big-endian, versioned info strings (decision-completeness/security, → RESOLVED).
**Fail direction:** credential-share fail-closed; dryRun governs only inbound observability; outbound enforcement live from day one (lessons/security, → RESOLVED).
**P19 brakes:** single-shot receipt + backoff; pending TTL surfaces once; verification-failed no auto-retry; failure attention dedup per-peer-episode (lessons/scalability, → RESOLVED).
**Performance:** resolve profile once / O(1) index; in-memory reads only; single source of truth, trust-source set last → fails closed (scalability, → RESOLVED).
**Migration parity (P5):** 3 config keys via migrateConfig; threadline_pair MCP tool always-overwrite; CLAUDE.md awareness + migrateClaudeMd; plaintext-fallback refusal; enum forward-compat; ExternalOperationGate layering (integration/lessons, → RESOLVED).
**Control-plane hardening:** pair-verify gate-exempt but still schema/sig/size/replay/rate validated (codex, → RESOLVED).
**OOB channel:** operational definition — local render + human eyes over a relay-independent surface; explicit negative cases (codex/security, → RESOLVED).
**Honest scope:** "credential workflow gate," not universal DLP; sanctioned path is the only affordance (codex, → RESOLVED).

Non-material considerations recorded but not actioned: gemini's "consider the Noise Protocol Framework instead of a bespoke handshake" (the design is built correctly from standard primitives; adopting Noise is a larger rewrite, out of scope) and "operator-in-the-loop may bottleneck future autonomous fleets" (a deliberate security choice for the credential-sharing use case; future fleet-scale delegation is a separate evolution).

## Convergence verdict

Converged at iteration 3. The two non-Claude external models reached MINOR-ISSUES-all-folded (codex) and CLEAN (gemini); the independent comparator confirmed all prior material findings RESOLVED with zero new material issues; and the final external pass raised only same-area policy refinements (now adopted), not new defects. Zero unresolved entries in `## Open questions`. Spec is ready for user review and approval.
