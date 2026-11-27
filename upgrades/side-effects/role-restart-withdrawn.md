# Side-Effects Review — A role restart that is no longer needed is withdrawn

**Version / slug:** `role-restart-withdrawn`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

A narrow bug fix. A role-change restart request (`state/restart-requested.json`, `requestedBy: 'role-change'`) is written by `requestRoleRestart()` and consumed by the lifeline's `ServerSupervisor.checkRestartRequest()` or the server's `ForegroundRestartWatcher`. Both leave the file in place while a Local Verify run holds the restart, and re-read it on each tick. Nothing removed the request when the role returned to its boot value, so the restart ran later for a reason that no longer held (2026-11-20, Mac Studio: lease lost 15:43Z, regained 15:53Z, restarted 16:03Z).

New: `withdrawRoleRestart(files, pid = process.pid)` in `src/core/roleFollowRestart.ts`. It reads the request and removes it (through `SafeFsExecutor.safeUnlinkSync`) only if `requestedBy === 'role-change'` and `pid` equals this process. `reconcileRole` in `src/commands/server.ts` calls it on the existing early return `nowAwake === bootAwake`. Files: those two, `tests/unit/roleFollowRestart.test.ts`, `tests/e2e/role-restart-wiring.test.ts`, an ELI16 and an upgrade note. No route, config, hook, skill or template changes.

## Decision-point inventory

- `reconcileRole` (restart or not for a role change) — modify — on "role equals boot role" it now also withdraws this process's own waiting role request. The restart decision itself (`decideRoleRestart`) is unchanged.
- `withdrawRoleRestart` — add — decides whether a request file is this process's role request.
- `ServerSupervisor.checkRestartRequest`, `ForegroundRestartWatcher.check` — pass-through — unchanged; with no file they already reset their deferral state.

## 1. Over-block

Nothing is blocked. The change removes a restart; it never delays or refuses one.

## 2. Under-block

- A role restart that was needed and is withdrawn by mistake: only possible if the role equals the boot role, and then the process already has what the role needs (the scheduler exists exactly when the process booted awake). 
- A stale role request written by an earlier process (different pid) is not withdrawn. After any restart the role matches boot, and the supervisor consumes the file when it restarts the server, so such a file should not exist; if one does, behaviour is as before this change.
- The lease moving back and forth is not fixed by this change. It removes one cost of each move (a lost verify and a silent holder).

## 3. Level-of-abstraction fit

The withdraw sits beside the request, in the same module, and is called from the one place that already compares the role with the boot role. The supervisor is not taught about roles.

## 4. Signal vs authority compliance

The server is the authority on its own role and wrote the request; it withdraws its own request. It does not touch requests written by other authorities (update, operator, config change): the `requestedBy` and `pid` checks enforce that.

## 5. Interactions

- Race with the supervisor: if the supervisor reads the file just before it is removed, the restart proceeds as it did before this change. No new failure.
- An update request that replaced the role request in the same file (same path): `requestedBy` differs, so it is kept. A test asserts this.
- The 15-minute stamp (`state/role-restart.json`) is kept on withdrawal, so a role that flips again inside the interval is still held to one restart.
- Promotion catch-up reads the stamp only after a restart of a machine that holds the lease at the stamped epoch; a withdrawn promotion does not restart, so nothing reads it as a promotion.

## 6. External surfaces

None. One new server log line.

## 7. Multi-machine posture

machine-local-justification: the request file, the stamp and the boot role are facts about one server process on one machine. Each machine withdraws only its own request.

## 8. Rollback cost

Revert the commit. No state to migrate; no file format changes.

## Self-action declaration

This change adds no new self-action. It removes one planned restart in a case where it had no purpose. Bounded: at most one file removal per waiting request.
