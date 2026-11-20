# A role restart that is no longer needed is withdrawn

<!-- bump: patch -->

## What Changed

A machine whose lease role changes asks for one planned restart (`state/restart-requested.json`, `requestedBy: role-change`). The request waits while a Local Verify run is in progress. If the role went back to what it was at boot while the request waited, the restart still ran. On 2026-11-20 the Mac Studio lost the lease at 15:43Z, had it back at 15:53Z, and was restarted at 16:03Z for "this machine gave up the lease". The restart ended the verify in progress and left the lease unrenewed for the length of a boot.

`reconcileRole` in `src/commands/server.ts` now calls `withdrawRoleRestart()` (new, in `src/core/roleFollowRestart.ts`) when the role matches the boot role. It removes the request only when it was written for a role change by this same process. Requests from an update or any other writer are left alone. The 15-minute stamp is kept, so the limit on role restarts is unchanged.

## What to Tell Your User

Nothing to do. When one of your computers briefly lost the lead role and got it back, it could still restart several minutes later for no reason, which threw away a test run in progress. It no longer does.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| A waiting role restart is cancelled when the role is back to its boot value | Automatic. The server log says "the waiting role restart is withdrawn" |

## Evidence

Seen live on 2026-11-20 (supervisor log: "Restart requested by role-change (no version change: this machine gave up the lease)" at 16:03Z on a machine holding the lease since 15:53Z). Unit tests: `tests/unit/roleFollowRestart.test.ts` (12 tests, 4 new). Wiring: `tests/e2e/role-restart-wiring.test.ts` (7 tests, 1 new).
