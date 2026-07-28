---
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "rev-1 — incident-driven (EXO topic 2169: the pool placed and stickily kept a topic on a machine whose LLM account was rate-limited; the user saw silence and the presence proxy claimed 'actively working'). Grounded in PlacementExecutor.decide() (pure), the capacity-heartbeat producer (refreshPool), and MachinePoolRegistry assembly. Design: per-machine self-reported quotaState in the heartbeat (each machine reads ONLY its own QuotaTracker — the gemini quota-conflation lesson), a candidate-pool quota gate in decide() with a place-somewhere fallback and a pin-wins exception. Every boundary side test-pinned."
approved: true
approved-by: "operator (Justin) via Telegram topic 13481 — 2026-06-05 06:51Z 12h autonomous mandate (\"We've identified multiple issues with the multi machine system recently... we need to resolve them here\"); the quota-blind placement issue documented in the 2026-06-05 topic-2169 incident finding"
approved-at: "2026-06-05T06:51:00Z"
---

# Quota-Aware Placement — don't place topics on a silent machine

**Status:** Approved 2026-06-05. Implemented.
**Author:** Echo
**Companion:** quota-aware-placement.eli16.md
**Trigger:** 2026-06-05 incident (topic 2169): a topic lived on the Mac Mini
while the Mini's Claude account was rate-limited ("session limit, resets
10:30pm"). Placement had no quota signal — it placed by load/sessions/memory
only, and stickiness then KEPT the topic on the silent machine.

---

## The gap

`MachineCapacity` carried load, sessions, and memory — nothing about whether
the machine's LLM account could actually do work. `PlacementExecutor.decide()`
is pure over `MachineCapacity[]`, so the fix is a new self-reported field +
a gate in the pure function.

## The design

1. **Self-reported `quotaState` in the capacity heartbeat.** `refreshPool()`
   (the 30s self-heartbeat) computes `{ blocked, blockedUntil?, reason? }`
   from THIS machine's own `QuotaTracker.getState()`: blocked when a provider
   block is in effect (`blockedUntil` in the future) or the 5-hour window is
   exhausted (≥95% — the same bar `canRunJob` uses to block all spawns).
   Each machine reads ONLY its own tracker — never another machine's file
   (the gemini per-model-deferral-recorded-as-global-block lesson). Unknown /
   unreadable state → field omitted → treated as not blocked.
2. **Registry passthrough.** `HeartbeatObservation.quotaState` →
   `MachineCapacity.quotaState` in `assemble()`; visible in `GET /pool`.
3. **The gate in `decide()`** (after the online/clock filter):
   - quota-blocked machines drop out of the candidate pool — least-loaded,
     soft preference, and STICKINESS all skip them (a blocked current owner
     loses stickiness, which is exactly how the incident topic gets off the
     silent machine);
   - **place-somewhere fallback:** if EVERY eligible machine is blocked, the
     pool proceeds least-loaded among them with
     `escalationReason: 'all-machines-quota-blocked'` (placing somewhere
     beats placing nowhere);
   - **pin wins:** a HARD pin to a blocked machine is honored (the user's
     explicit command), flagged `escalationReason:
     'pinned-machine-quota-blocked'`; the capability requirement is still
     enforced on the pin path (never capability-blind).

## Backward compatibility

Absent `quotaState` (older heartbeats, mixed-version pools) = not blocked —
bit-identical placement to today. The decision `reason` strings are unchanged;
the new signal rides the existing optional `escalationReason`.

## Tests

- `tests/unit/PlacementExecutor.test.ts` (+8): blocked machine avoided even
  when least-loaded; blocked owner loses stickiness (the incident case);
  all-blocked fallback + note; hard-pin honored + flagged; soft preference
  degrades; absent state = eligible; `blocked:false` eligible; pin still
  capability-checked. (29 existing placement tests green.)
- `tests/unit/MachinePoolRegistry.test.ts` (+1): heartbeat → capacity
  passthrough, and a later heartbeat WITHOUT the field clears it.

## Out of scope

- Re-placing topics that are ALREADY on a machine that becomes blocked with
  no inbound traffic (placement runs per-message; the next message re-places
  off the blocked owner via the lost-stickiness rule).
- Presence-proxy honesty about rate-limited sessions — sibling task, separate
  change.
