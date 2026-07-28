---
title: Sibling-Transport Brakes — live-tail and reply-marker wires get timeouts + bounded failure logging
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged as the mechanical completion of the #874 pattern (line-level CONCUR-reviewed tonight on HttpLeaseTransport, including the 30s timeout sizing vs the fleet's 5–40s receiver-stall envelope — applied here from the start) on the two remaining mesh transports, with the one coupling risk verified ABSENT by direct grep (isReachable()'s only consumer is the LEASE transport via LeaseCoordinator — neither sibling feeds renewal/suspend); validated by a focused adversarial second-pass (CONCUR on all probes: the Two-Generals widening is pre-accepted by the marker's documented design; gate keys are peer-bounded; alternating ok/fail chatter is diagnostic signal at reply cadence; local encryptFor throws disambiguate via the error detail).
approved: true
---

# Sibling-Transport Brakes

> Approval ground: Justin's autonomous-session direction (topic "Resource
> Limitation Mitigation", 2026-06-06) with standing merge-on-green approval.
> Audit fix #5 (CMT-1109), completing the transport set #874 started.

## Problem

`HttpLiveTailTransport` and `ReplyMarkerTransport` shipped with the identical
gaps #874 closed on the lease wire: no abort signal on their fetches (a hung
socket holds a flush / the reply-commit path open indefinitely) and per-attempt
failure logging (live-tail: one line per topic per backoff attempt against a
down peer; reply-marker: one line per rejected marker). Lower blast radius
than the lease wire — neither feeds lease renewal/suspend (verified:
`.isReachable()`'s only src consumer is `LeaseCoordinator` via the lease
transport) — but the same P19 violations.

## Design

The #874 pattern verbatim: `AbortSignal.timeout(requestTimeoutMs)` on both
fetches (default 30s — the #874 reviewer's corrected sizing, above the fleet's
documented 5–40s receiver-stall envelope) + `PeerFailureLogGate` state-change
logging (first / every-Nth / recovery; live-tail N=360 for its tick-bounded
cadence, reply-marker N=50 since markers flow at reply cadence). Non-ok
responses now gated-logged with status + context detail. No server.ts wiring
needed — neither transport has a config-coupled horizon (unlike the lease
wire's leaseTtlMs derivation).

Reviewer-analyzed acceptances: (a) a 30s abort can drop a marker a slower wait
might have delivered — widening the documented Two-Generals residual that the
marker's own class doc pre-accepts (broadcast is void-discarded fire-and-forget
at its only callsite; provider redelivery + the dedup gate + git-committed
ledger state are the backstops); (b) perfectly alternating ok/fail logs per
transition — diagnostic signal for a genuinely unstable peer, bounded at reply
cadence; (c) a local `encryptFor` throw logs under the peer key with the real
error message as the disambiguating detail.

## Tests

`tests/unit/sibling-transport-brakes.test.ts` — 6 green: AbortSignal presence
on both transports; the P19 sustained-failure bounds (25 failed flushes → 3
lines; 12 rejected markers → 2 lines); recovery-once on both; steady-success
silence on both. Pre-existing suites untouched and green (HttpLiveTailTransport
6, reply-marker-transport 3, live-tail roundtrip); tsc clean.

## Rollback

Revert; no persistent state, no config, no schema.
