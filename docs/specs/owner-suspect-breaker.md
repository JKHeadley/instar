---
title: Owner-Suspect Breaker — wire the router's dead per-peer hook into a half-open circuit
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged against deep grounding of the SessionRouter (the audit's "load-shedding" lead resolved to three concrete facts — markOwnerSuspect NEVER WIRED in production, isMachineAlive reads only capacity heartbeats so a slow-but-heartbeating peer never short-circuits, and queueMessage is a production NO-OP so re-placement is the only message-preserving path today); validated by an adversarial second-pass whose probe-1 OBJECT (forever-suspect under steady traffic — re-marks extended the TTL window so a recovered peer could never reach half-open) was CONFIRMED BY REPRODUCTION and fixed (absolute per-episode TTL) with a regression test, and whose remaining five probes (swap-count invariance, pin behavior, all-suspect fallback, stale-ack semantics, chains-cleanup race) all traced clean.
approved: true
---

# Owner-Suspect Breaker (task 4a — the uncontroversial half)

> Approval ground: Justin's autonomous-session direction with standing
> merge-on-green approval (topic "Resource Limitation Mitigation",
> 2026-06-06). The POLICY half (queue-vs-replace while suspect, which needs a
> durable inbound queue built first) goes to Justin as lettered options — see
> the companion message <!-- tracked: CMT-1109 -->.

## Problem (grounded — three findings sharper than the audit lead)

The audit said "SessionRouter lacks per-peer load-shedding." Grounding found:
1. The router already HAS the breaker hook — `markOwnerSuspect` fires on
   delivery-retry exhaustion — but it was **never wired in production**
   ("constructed but inert" at the wiring layer).
2. `isMachineAlive` reads only capacity-heartbeat `online` — a slow-but-
   heartbeating peer keeps passing it, so EVERY session it owns re-pays the
   full retry tax (~4.5s: initial + 3 backed-off retries) on EVERY message.
3. `queueMessage` is a production no-op — "queued" means "dropped to platform
   redelivery." Re-placement is the only message-preserving path today, which
   is why this PR keeps the existing re-place semantics and the queue-based
   stability policy is a separate operator decision.
Plus: the per-session `chains` map grew one settled-promise entry per
session-ever-routed, forever (the same leak shape as the tail-cache finding).

## Design

- **`OwnerSuspectBreaker`** (pure core class): per-peer suspect windows with
  **absolute per-episode TTL** (default 30s — a re-mark inside an open window
  does NOT extend it; the reviewer's reproduction showed extension semantics
  made a recovered busy peer suspect FOREVER, since no delivery is attempted
  while suspect so only the TTL can re-open probing). Half-open after expiry.
  Composes `FailureEpisodeLatch` per peer: first-mark log once, ONE
  degradation signal per 10min-sustained episode, recovery log + state
  deleted on success (bounded memory).
- **Router** (minimal): new optional `onOwnerResponsive` dep fired on ANY
  deliverMessage ack (queued/duplicate/stale all prove the peer answered —
  transport health, which is exactly what this breaker measures); `chains`
  entry deleted when its tail settles while still current (bounded by
  in-flight sessions; the identity-check guard preserves serialization —
  reviewer probe 5 traced the interleaving clean).
- **Wiring**: `markOwnerSuspect` → breaker; `isMachineAlive` composed with
  `!isSuspect` (suspect peers' sessions take the EXISTING failover re-place
  path without re-paying the retry tax); placement's `machineRegistry`
  filtered to exclude suspect machines UNLESS that empties the set
  (all-suspect → unfiltered, mirroring the all-machines-quota-blocked
  precedent — reviewer probe 3 confirmed `spawnOnMachine` is not
  `isMachineAlive`-gated, so the fallback cannot wedge).

## Swap semantics (the "fewer swaps" check)

Reviewer probe 1+2 traced: a session still moves at most once per peer-down
episode (the breaker removes redundant retry tax for the peer's OTHER
sessions; it does not add moves). HARD-pinned sessions do NOT migrate during
a suspect window — placement returns `hard-pin-unavailable` and the message
falls through; on TTL expiry the pin resolves in place. A 30s blip cannot
permanently migrate a pinned session.

## Tests

`tests/unit/OwnerSuspectBreaker.test.ts` — 11 green: TTL/half-open, the
ABSOLUTE per-episode TTL regression (the reviewer's bug — a steady <TTL
re-mark stream must still reach half-open), recovery-once, the P19
sustained-suspicion bound (20 marks → 1 first-log + 1 signal), peer
independence + bounded memory, fresh-episode re-fire; router integration —
onOwnerResponsive on success AND stale acks, the END-TO-END short-circuit
(message 1 pays 4 attempts, message 2 pays ZERO), chains-map boundedness.
SessionRouter suite (23), session-router-dispatch integration (3), and the
session-pool deliverMessage e2e (4) all green; tsc clean.

## Rollback

Revert; no persistent state, no config, no schema. (The wiring is one block
in server.ts; removing it restores the inert-hook status quo.)
