# Side-Effects Review — Interactive Priority Lane for the Host Spawn Cap (F5 build)

**Version / slug:** `spawn-cap-interactive-priority`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Tier:** 2 (converged + approved spec: `docs/specs/spawn-cap-interactive-priority.md`)

## Summary

Implements the converged F5 design: the host spawn cap (the fork-bomb OOM floor) now
SUBDIVIDES into reserved interactive/background headroom so the user-facing tone gate
is not starved by background sentinels under contention. It NEVER raises the total cap.
Ships dark-on-fleet / live-on-dev via the dev-agent gate; byte-identical when off.

Implemented this change:
- `attribution.lane?: 'interactive'|'background'` (types.ts) — the lane signal.
- `hostSpawnSemaphore`: `SpawnLane` + optional per-holder `lane`; `clampInteractiveReserves`;
  `acquire(id, lane)` with the symmetric reserve (interactive iff `liveTotal<N AND
  liveInteractive<N−Rb`; background symmetric); `interactivePriorityEnabled()`; per-lane
  `status()` fields. The `liveTotal<N` OOM floor remains the UNCONDITIONAL first predicate.
- `SpawnCapIntelligenceProvider`: `INTERACTIVE_LANE_ALLOWLIST` (downgrade non-allowlisted
  `interactive` to background); lane-aware ingress (interactive fast-path before the
  waiters cap + a CARVE-OUT of `waitersMax`, never additive); passes the lane to acquire.
- `MessagingToneGate`: `synchronousReply` context flag → sets `lane:'interactive'` only on
  the operator-facing synchronous reply.
- Dev-gated flag wiring (server.ts `configureHostSpawnSemaphore`), config type +
  ConfigDefaults (`enabled` OMITTED → dev-gate; `ri:2, rb:2`), `/spawn-limiter` per-lane
  fields.

## The 8 questions

1. **Over-block** — N/A. The reservation gates spawns (existing authority); it adds no new
   rejection. A saturated interactive call still fails closed (typed shed) exactly as today.
2. **Under-block** — N/A. The total cap is byte-identical (`liveTotal<N` first, always).
3. **Level-of-abstraction fit** — Correct. `ComponentFrameworks`/attribution already carry
   per-call metadata; the reserve lives in the one primitive (`hostSpawnSemaphore`) +
   its wrapper. No routing-engine change.
4. **Signal vs authority** — Subdivides EXISTING authority by a lane; no new brittle
   blocking logic (pure integer counting over the holder set, same shape as `liveHolders<cap`).
   The interactive signal is hardened by a code allowlist + a membership-pinning test (not
   convention). Complies with docs/signal-vs-authority.md.
5. **Interactions** — Disabled ⇒ byte-identical (no `lane` written, ingress carve-out
   gated on `priorityOn`, lane resolves to background). Confirmed: 25 existing spawn-cap
   tests + 160 tone-gate tests pass unchanged. The wrapper ingress carve-out keeps the
   aggregate poller bound at `waitersMax` (not additive). Garbage/missing lane → background,
   never drops a holder (`isWellFormedHolder` untouched) — the OOM floor cannot be eroded.
6. **External surfaces** — `/spawn-limiter` gains per-lane fields (additive). The tone
   gate's LLM call may run on a different framework lane than background — intended, visible.
7. **Multi-machine** — Host-local BY DESIGN (the holders file is per-host, never synced).
   Each host reserves its own headroom. The optional `lane` rides inside the host-local
   file; an old reader ignores it, a new reader counts a missing lane as background — total
   cap bounded both directions during a mixed-version window (priority is best-effort until
   all co-resident agents upgrade; moot while dark). No replication.
8. **Rollback cost** — Trivial. The dev-gate flag off (or `interactivePriority.enabled:false`)
   restores all-or-nothing. No migration (deepMerge backfills `ri/rb`; no stale `enabled`
   to strip on a new block). No state. Revert the commit otherwise.

## Tracked follow-ups (not orphan deferrals)

- A `lint-interactive-lane-allowlist` CI script (Structure>Willpower belt-and-suspenders).
  The wrapper DOWNGRADE + the membership-pinning unit test already guarantee safety; the
  lint is additional defense against a new static assignment site. <!-- tracked: topic-28744 F5-followup interactive-lane-lint -->
- The §A.1 second tagged seam (operator-inbound `MessageSentinel`) is on the allowlist; its
  synchronousReply-equivalent wiring on the inbound path lands with the inbound work. <!-- tracked: topic-28744 F5-followup messagesentinel-inbound-lane -->

## Second-pass note (spawn-cap = safety floor)

This touches the fork-bomb OOM floor (a Phase-5 trigger area). The load-bearing review
point: the change ONLY subdivides within `N` — `liveTotal<N` is the unconditional first
predicate of every lane, the reserve never raises the ceiling, a garbage lane never drops
a holder, and `enabled:false` is byte-identical (verified by the existing burst-invariant
fork-bomb test passing unchanged). The decision boundary is covered by 17 new unit tests.

## Rollback

Dev-gate off / `enabled:false`. No migration, no state.
