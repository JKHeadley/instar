---
title: "U4.3 — Traffic-Independent Circuit-Breaker Recovery Probe"
slug: "u4-3-breaker-recovery-probe"
author: "echo"
status: "draft"
parent-principle: "Verify the State, Not Its Symbol — a breaker's open state must be re-verified against reality, not left to chance traffic"
sibling-principles: "The Agent Is Always Reachable; Runtime End-to-End Proof — the canary standard (this reuses the G4 delivery-canary probe primitive); Bounded Blast Radius (P19 bounded probing)"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "G4 delivery-canary probe primitive (.instar/scripts/delivery-canary.mjs, deployed both machines this session); multiMachine.meshTransport per-transport breakers"
---

# U4.3 — Traffic-Independent Circuit-Breaker Recovery Probe

## 1. Problem

Each mesh transport ("rope") has a per-transport circuit breaker that OPENS on
repeated failure so the lease layer stops trying a dead rope. Today a breaker only
CLOSES when new traffic happens to test the path and succeed. On a quiet mesh — the
common case for a two-machine personal setup between conversations — a breaker can
stay open long after the underlying rope healed. The lease layer then keeps AVOIDING
a machine that is actually reachable ("healthy but presumed-down"), which:

- Amplifies every other U4 gap (a machine wrongly presumed down is a machine the
  lease won't hand back to — U4.4 — and won't place topics on).
- Is a "Verify the State, Not Its Symbol" violation: the OPEN symbol is trusted as
  ground truth instead of being re-verified against the live rope.

This is a close cousin of the single-rope Cloudflare flap that caused the 2026-07-01
lease instability: recovery was traffic-gated, so a healed rope stayed marked-bad.

## 2. Design

**An active, cadenced half-open probe — reusing the G4 canary primitive.** When a
transport's breaker is OPEN, a background probe tests THAT specific transport on a
backoff schedule, independent of user traffic:

- **Probe = the G4 delivery-canary primitive.** G4 already sends a signed,
  bogus-uid `deliverMessage` over the real mesh RPC per machine-pair with zero
  injection risk (the peer answers `refused:not-router` / `ack:sender-rejected` per
  role). U4.3 reuses that exact primitive, but PINNED to the specific transport whose
  breaker is open (the mesh RPC gains a "try this rope only" hint), so a success
  proves THAT rope, not just "some rope."
- **Half-open state machine:** OPEN → after `probeBackoff` (exponential from ~30s,
  capped) send ONE probe → success increments a consecutive-success counter; N
  consecutive successes (default 2) CLOSE the breaker and emit a `rope-recovered`
  breadcrumb to the server log (NOT an alert — recovery is good news, and U4.5 owns
  any user-facing rope messaging). A failure resets the counter and widens the
  backoff.
- **Bounded (P19):** a persistently-broken rope does NOT probe forever — after a
  ceiling of attempts the probe cadence caps at a floor rate and records
  `probe-exhausted` (still probing occasionally, but not spinning). It gives up
  LOUDLY into the guard-posture inventory rather than silently, so a permanently-dead
  rope is visible, not merely quiet.
- **Never probes a healthy (closed) breaker** — zero cost when everything is fine.

## 3. Multi-machine posture (mandatory)

A breaker is per-(local-machine, peer, transport). Each machine probes its OWN open
breakers to its OWN peers — **machine-local BY DESIGN**, no replication (a probe's
result is only meaningful from the machine that sent it). `GET /health` gains, per
transport, `breakerState + lastProbeAt + nextProbeAt + consecutiveSuccesses` so the
state is inspectable from either machine's own view. No cross-machine state; the
guard-posture inventory surfaces a `probe-exhausted` rope on `GET /guards`.

## 4. Tests

- `open-breaker-probes-on-backoff` (probe fires without any user traffic).
- `N-consecutive-successes-closes-breaker` (and N-1 does not).
- `probe-failure-resets-counter-and-widens-backoff`.
- `closed-breaker-never-probes` (zero-cost when healthy).
- `persistently-broken-rope-caps-cadence-and-records-probe-exhausted` (P19; no spin).
- `probe-is-pinned-to-the-open-transport` (a success on rope B does not close rope A's
  breaker).
- `probe-uses-bogus-uid-and-cannot-inject` (reuses G4's zero-injection contract).

## 5. Rollback / rollout

Ships dark → dry-run (logs "would probe / would close" without mutating breaker
state) → dev-agent → fleet, gated by `multiMachine.meshTransport.breakerRecoveryProbe`.
Rollback = drop the flag; breakers revert to traffic-gated recovery (today's
behavior). No new store; state lives with the existing per-transport breaker.

## Frontloaded Decisions

1. **Reuse the G4 canary primitive** rather than a new probe — it already has the
   zero-injection, signed, per-pair contract; a second probe path would be
   duplicate attack surface.
2. **Recovery is a log breadcrumb, not a user alert** — U4.5 owns user-facing rope
   messaging; a breaker closing is routine good news.
3. **N=2 consecutive successes to close** — one success could be a fluke on a
   flapping rope; two is the anti-flap floor (config-tunable). (Contested-cheap:
   N/A — internal breaker state, no external side-effect.)
4. **P19 bound on probing** — a dead rope caps its cadence and reports exhausted;
   never an unbounded spin.

## Open questions

None.
