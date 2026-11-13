# A restored Local Verify queue keeps its saved base and re-reads it before the first run

<!-- bump: patch -->

## What Changed

`LocalVerifyService.doRestoreQueue()` rebuilt each restored entry with `baseSha: view.baseRefOid`, the PR's base as of its last update on GitHub, and kept the saved `baseResolvedAt`. `request()` and the pre-start refresh never use `baseRefOid` (see the `baseHead` seam: "can be days stale"); restore did. Because the reconcile loop re-requests queued PRs every few minutes, the saved `baseResolvedAt` was usually seconds old, `mainMovedAt` is in-memory and null after a restart, so `decideBaseRefresh` was false and the first local start and the first peer dispatch after a restart ran on the stale base.

Now a restored entry keeps the saved `baseSha` (the last one this service resolved through `baseHead`), and a non-reserved entry comes back with `baseResolvedAt: 0`, so the pre-start refresh always runs for it. An entry reserved for a peer attempt is unchanged. `0` is not written to the durable queue.

## What to Tell Your User

Nothing changes that you will see. After a restart, the first changes tested could be checked against code that was hours out of date and fail for reasons already fixed. They are now always checked against the current code.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| First runs after a restart use today's base | Automatic |

## Evidence

Studio audit log, 2026-11-13 (UTC): `base-updated` for PR 3096 at 18:47:32 and PR 3137 at 18:48:05, both to `cc130bb8` (main's head then). Server restart; `queue-restored` at 18:50:28 (restored 11, dropped 0). `started` PR 3137 at 18:50:29 and `peer-dispatch` PR 3096 at 18:50:30, both with `baseSha 8ccc0ac5` and no `base-refreshed` event. `8ccc0ac5` is a main commit from 11:29:30 UTC, seven hours and six merges earlier. PR 3137 failed at 19:20 on `tests/integration/test-runner-bound-meta.test.ts` with zero-length probe windows, the fault PR 3140 fixed on main at 17:24; the tested tree did not contain that fix. PR 3096 failed at 19:10. At the next restart (19:21:01) the saved resolution times were older than five minutes and `base-refreshed` appears before both starts, which is why this was intermittent.

Tests: `tests/unit/localVerify/LocalVerifyService.test.ts`, 3 new: restore keeps the saved base and the pre-start refresh reads today's head even though the base was resolved just before the restart; when today's head cannot be read the run uses the saved base, not the PR view's; the "never resolved" marker is not written to the durable queue and a later request records a real time. `decideBaseRefresh` answers yes for `baseResolvedAt === 0` (two assertions). Nine restored-start assertions in existing tests gained a `flush()` (the start now follows the async refresh). All tests in the file pass. Not run locally (they take the suite slot): `tests/integration/local-verify-routes.test.ts`, `tests/e2e/local-verify-lifecycle.test.ts`, `tests/e2e/planned-restart-local-verify-lifecycle.test.ts`.
