# Convergence Report — The Agent Is Always Reachable

## Cross-model review: SKIPPED-ABBREVIATED (single-framework, urgency)

Live-incident-driven standard (topic 28744). Cross-model skipped; the code-backed conformance gate + adversarial + lessons-aware reviewers ran and found 2 BLOCKERS + 6 majors — a real, non-rubber-stamp round.

## Iteration Summary

**Round 1**
- **Conformance gate (2 flags):** No Unbounded Loops (the floor's exempt spawn needs a breaker/cap) → ADDRESSED (bounded respawn + breaker + host spawn-cap). Cross-Machine Coherence (per-host floor risks multiple lifelines) → ADDRESSED (floor held by the lease-holder only).
- **Adversarial reviewer — 2 BLOCKERS + 4 majors/minors:**
  - BLOCKER 1 (existence≠liveness): a wedged lifeline reads "reachable" while the agent is dark → floor predicate is LIVENESS (StuckSignatureClassifier; wedged → floor-unmet → fresh respawn).
  - BLOCKER 2 (breaker terminal state = dark): full-stop after the breaker defeats the whole point + notice routed through the down channel → breaker drops to a SLOW heartbeat (never full-stop); notice via the lifeline-process direct path.
  - MAJOR 3 (floor identity forgeable): unset lifelineTopicId → heuristic "first topic" masquerade → canonical (lifelineTopicId, machineId), fail-closed REFUSE if unset; one exempt token under lock.
  - MAJOR 4 (spawn-cap starves the floor): the exempt spawn still needs a host slot exactly when saturated → reserved reachability lane.
  - MAJOR 5 (G2 holdable by tone gate): the never-silent notice fails closed under the very pressure it reports → deterministic delivery path, tone-gate-exempt.
  - MINOR 7/8: forced-pressure integration test (the #1287 fix makes the real trigger rare); G3 self-remediation hard-deadline.
- **Lessons-aware reviewer — 1 MAJOR + minors:**
  - MAJOR d (session≠poller): "lifeline session exists" ≠ "user can reach the agent" — the ingress poller is a separate layer → standard SCOPED to the session/resource-gating layer + cross-references the poller-liveness layer (version-skew/watchdog); no over-claim.
  - MINOR a (name the enforcers → Applied-through clause added), b (G3 demoted from "guarantee" to "standard + ordering lever"), c (route G2 through the existing raiseAggregated funnel; resolve ttl-expired interaction), e (G1 dryRun-first explicit).

**Round 2 (convergence check)** — every blocker + major incorporated into the spec; the design is now liveness-gated, fail-closed on identity, reserved-lane, never-dark, deterministic-delivery, lease-scoped, layer-honest. No new material findings. **Converged.**

## Decision-completeness
All decisions frontloaded; `## Open questions` empty. G2 ships ON (pure-additive never-silent); G1 (reaper/spawn change) ships dryRun-first on dev behind a default-on flag.
