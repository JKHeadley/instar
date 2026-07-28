# Side-Effects Review — Registry lost-update race fix (pid-guarded unregister + resurrecting heartbeat)

**Version / slug:** `registry-guarded-unregister`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

`unregisterAgent` gains an `onlyIfPid` guard; server and lifeline shutdowns pass their own pid so an old generation's late shutdown can no longer delete the successor's fresh registry entry. `heartbeat` now returns whether the entry was found, and `startHeartbeat` accepts a `reRegister` callback that recreates a missing registration (invoked on the initial beat and on every interval tick that finds the entry gone).

## Decision-point inventory

- `AgentRegistry.unregisterAgent` — modified — optional pid guard; removal only on matching `entry.pid` when `onlyIfPid` is given; skip is logged. No-opts call unchanged.
- `AgentRegistry.heartbeat` — modified — return type `void` → `boolean` (found-flag). All existing callers ignore the return; no behavior change for them.
- `AgentRegistry.startHeartbeat` — modified — new optional `reRegister` param; missing-entry beats log a warning and invoke the callback inside its own try/catch.
- `server.ts` shutdown — modified — passes `{ onlyIfPid: process.pid }`.
- `server.ts` heartbeat wiring — modified — passes a reRegister callback that re-runs `registerAgent(projectDir, projectName, port)`.
- `TelegramLifeline` register/unregister — modified — same two changes for the `-lifeline` entry (lifeline restarts on version skew / drift-promote: identical race shape).
- `nuke.ts` (operator removal) — untouched — unconditional removal preserved deliberately.

## Direction of failure

- Old failure: silent durable deregistration — agent vanishes from the registry while alive; registry-dependent tooling (worktree CLI agent-home resolution, discovery) refuses the agent until the next full restart.
- New behavior: a guarded shutdown skips a non-matching entry (logged); a missing entry is resurrected within one heartbeat interval (60s default) or immediately at heartbeat start.
- Conservative failure direction: when in doubt the entry is KEPT — a pid-guarded removal that cannot confirm ownership leaves the entry; `cleanStaleEntries` (dead-pid detection + 1h heartbeat expiry) remains the garbage collector for genuinely dead entries, so a kept-but-dead entry is bounded, not permanent.

## Side-effects checklist

1. **Over-block (entry kept when it should be removed):** a guarded shutdown whose own registration was somehow rewritten with a different pid (e.g. a concurrent re-register) leaves the entry behind. Bounded: the entry's pid is then dead, so `cleanStaleEntries` marks it stale on the next registry read and expires it. No permanent zombie.
2. **Under-block (entry removed when it should be kept):** unguarded callers (CLI `nuke`, `unregisterPort` by name) still remove unconditionally — intentional operator semantics. The guarded path cannot remove a successor's entry by construction.
3. **Level-of-abstraction fit:** the guard lives in `AgentRegistry` (the single registry mutation funnel), not in callers — every future shutdown path gets the same primitive. Callers only declare WHO they are (their pid); the registry decides.
4. **Signal vs authority compliance:** no LLM involvement; pure structural fix. The resurrect log lines are signals for the operator; nothing blocks.
5. **Interactions:** the reRegister callback calls `registerAgent`, which port-conflict-checks against RUNNING entries — if another live agent legitimately claimed the port meanwhile, re-registration throws and is contained (logged, retried next beat). Heartbeat lock-failure recovery (3-strikes force-unlock) is unchanged; missing-entry is handled separately from lock errors and does NOT count toward failure strikes.
6. **External surfaces:** registry.json consumers (worktree CLI, `instar status`, discovery) see strictly more-accurate state. No API/route changes.
7. **Rollback cost:** revert the commit; no data migration. Registry files written by the new code are schema-identical.

## Scope not taken

- No change to `cleanStaleEntries` semantics (dead-pid/1h-expiry pruning untouched).
- No lock-protocol changes (proper-lockfile usage unchanged).
- No registry watching/inotify — resurrect is heartbeat-cadence (60s), which matches the observed failure window.
- No fix for the `startHeartbeatByName` path (no live consumers register through it with a server lifecycle; can adopt the callback later if one appears).

## Rollback

Revert the single commit. Behavior returns to unconditional unregister + silent heartbeat no-op.
