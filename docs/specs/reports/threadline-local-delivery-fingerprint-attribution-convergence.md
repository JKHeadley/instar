# Convergence Report — Threadline local-delivery fingerprint attribution

**Spec:** `docs/specs/threadline-local-delivery-fingerprint-attribution.md`
**Converged:** 2026-06-10T01:48:29Z · **Iterations:** 2 · **Reviewers:** security, scalability, adversarial, integration, lessons (5 internal perspectives across 5 subagent passes over 2 rounds).

## ELI10 Overview

Echo messaged the Luna agent on the same Mac; Luna replied — and the reply vanished. A guard that stops conversations from being hijacked saw Luna's reply coming from "sagemind" (her name), but the conversation was filed under her fingerprint (`1db85f`). Name ≠ fingerprint, so the guard assumed an intruder and quarantined the reply. The fix teaches the same-computer delivery path to work out the sender's fingerprint — the exact same way the conversation was filed — and hand the guard just that one fact, so legitimate replies match and stay on-thread. It changes nothing else; unknown senders are still isolated.

The main tradeoff: same-computer delivery is gated by a shared token, not a cryptographic signature, so a program already holding that token could stamp a known peer's name and pass the guard. We accept that — the token is the real lock (unchanged), the guard was never actually a lock on the same computer (it just broke every reply), and the internet path is cryptographically verified and untouched.

## Original vs Converged

The convergence caught a **blocking bug in the original fix that would have shipped and done nothing**, and a second design flaw with real side effects.

- **Originally**, the resolver read `entry.fingerprint` from the address book. Two reviewers independently grounded this against the LIVE `known-agents.json`: sagemind has **no `fingerprint` field — only a `publicKey`**, and the conversation was filed using the first 32 chars of that publicKey (`1db85f`). The original resolver would have returned null → fallen back to the name → **silently no-op'd on the exact incident**. The converged design funnels record *and* compare through one shared resolver using the identical chain (`fingerprint || publicKey[:32]`), so they can never disagree.
- **Originally**, the fix handed the guard a full identity bundle ("relayContext"). Reviewers showed (in code) that doing so where today it's absent has three side effects: it adds an "external agent" grounding preamble to the spawned session, shrinks injected history (20→5), and changes a persisted record. The converged design hands the guard **only the one resolved-fingerprint fact** via a narrow parameter — verified in code to touch *only* the guard's comparison and nothing else.
- The converged version also **commits the trust decision** (rather than deferring it), reworded an over-eager "already verified" claim to honest future tense, scoped the warrants-gate fix out (to avoid re-introducing the persisted-record side effect), and resolved a reviewer disagreement about a second ingress by reading the code (it's the Ed25519-authenticated cross-machine path, not the co-located bug path).

## Iteration Summary

| Iteration | Reviewers who flagged | Material/blocking findings | Spec changes |
|-----------|-----------------------|----------------------------|--------------|
| 1 | security, adversarial, integration+lessons | **2 blocking + 8 material** | Redesign: shared resolver (`fingerprint \|\| publicKey[:32]`) used by record+compare; narrow fingerprint hint instead of a full relayContext; commit the trust decision; rework parent-principle caveat; reword L7 to future tense; warrants-gate fix → non-goal |
| 2 | adversarial; integration+lessons+security (CONVERGED) | **0 blocking, 2 material (test-wording/scope)** | Resolved the second-ingress reviewer disagreement by reading code (authenticated cross-machine path → no hint); corrected the integration-test wording (drive the real route, not the stub); scoped the resolver away from the divergent `routes.ts:13851` chain; noted the topic-gated owner record |

## Full Findings Catalog

### Iteration 1

- **[BLOCKING — adversarial + integration] Resolver/recorder divergence.** `entry.fingerprint`-only resolver returns null for the live `publicKey`-only sagemind → no-op on the incident. → **Resolved:** shared resolver `fingerprint || publicKey[:32] || null` used by both sides.
- **[BLOCKING — adversarial + integration] Full relayContext has side effects** (grounding preamble, history 20→5, persisted participants) where today it's `undefined`. → **Resolved:** narrow `inboundSenderFingerprint` hint touching only the anti-hijack comparison (code-verified: `inboundFp` referenced at exactly 3 lines, all in the guard).
- **[MATERIAL] Trust decision deferred; reverse-direction unverified; name collisions; per-message read; parent-principle over-fit; L7 over-claim; stale-ack claim overstated.** → **Resolved:** trust decision committed (§C); bidirectional fleet-shaped E2E; collision→null; parent-principle caveat; L7 future-tense; stale-ack removed from motivation.

### Iteration 2

- **[CONVERGED — integration+lessons+security]** Narrow hint verified zero-side-effect in code; shared resolver mirrors the recorder; trust decision sound under same-author scrutiny; parent-principle (CMC + caveat) is the honest fit (not KYP); warrants-gate non-goal is a legitimate blast-radius call, not a recurrence-risking deferral.
- **[MATERIAL — adversarial] Second ingress under-specified** (`ThreadlineEndpoints.ts:429`). → **Resolved by code-reading:** it's the Ed25519-authenticated cross-machine path (senders: relay + AgentBus); `from.agent` is the relay fingerprint, not a co-located name → no hint needed; build must verify, and if a name ever reaches it, use the authenticated `X-Threadline-Agent` header, never the TOFU lookup.
- **[MATERIAL — adversarial] Integration harness is a stub.** The named `relay-send-local-roundtrip` test captures envelopes but never hits the real guard. → **Resolved:** spec now requires driving the REAL `/messages/relay-agent` route with a thread pre-seeded as owned by `publicKey[:32]`.
- **[MINOR] Divergent `routes.ts:13851` chain; topic-gated owner record.** → folded into §A scoping notes.

## Convergence verdict

Converged at iteration 2. The integration+lessons+security reviewer (carrying the mandatory lessons-aware/anti-circular check) returned CONVERGED with the narrow-hint zero-side-effect property verified directly in code. The remaining round-2 items were test-wording/scope corrections (including a reviewer disagreement resolved by the author reading the code, not by fiat) — all folded, none re-opening the design. The fix is fail-safe (isolation on resolution-miss), minimal-blast-radius (one comparison line), and grounded in the live incident.

Ready for user review and approval. **Approval is the user's step.**

## Implementation note (after approval)

Single PR (Tier 2). Shared `resolvePeerFingerprint`/`resolvePeerFingerprintByName` helper; the
`/messages/relay-agent` route resolves the inbound name and passes `inboundSenderFingerprint` to
`handleInboundMessage`; the anti-hijack consumes it in the `inboundFp` fallback; the owner-record sites
adopt the shared helper. 3-tier tests on the real route, bidirectional E2E that reds on current main.
