# Local Verify: hold a change and move a change to the front, without a restart

<!-- bump: minor -->

## What Changed

Whoever runs a Local Verify test line gets two controls that take effect at once. Until now the only way to change what the line tested next was to edit the queue file by hand and restart the server, and a restart cancels the tests that are running on both machines (on 18 November 2026: 24 restarts, about 9 of them only to change the order, and 9 test runs cancelled part-way).

- **Hold** (`POST /local-verify/queue/hold`, ended by `POST /local-verify/queue/release`): the named pull request is taken out of the queue and is not tested until it is released. Its place goes to the next change waiting. Released, it comes back with the waiting time it had earned and with any re-test it was waiting for. There is one exception: if the queue and its 5 extra places are all full at that moment, the change goes to the head of the waiting list instead, a re-test it was waiting for is not kept, and the answer says so. A hold can be set before the change is queued. With `"blockMerge": true` the same request also sets the existing merge-side hold marker, so one request means "do not test and do not merge"; the answer says which of the two were applied.
- **Front** (`POST /local-verify/queue/front`, ended by `POST /local-verify/queue/unfront`): the named pull request is the next change to start. It works when the queue is full and the change is not in it yet (up to 5 places over the limit, shared with releases). At most 3 changes are fronted at once. If a test of a fronted change is interrupted, it is still first when it comes back; the mark ends when the change gets a result.

Neither control stops a test that is already running. A check of the shared code that is due still goes first, and every existing hold on the line (a pending update, low memory, a red main) applies as before.

Both are off unless `monitoring.localVerify.queueControls` is `true` on the machine that runs the line. The setting is read live, so no restart is needed to turn it on or off. With it off the four routes answer 404 and the queue behaves exactly as before. Only the machine that runs the line answers; others answer 409.

The choices are remembered per pull-request number in `state/local-verify/operator-queue.json`, so they survive a new push, a re-request and a restart. If that file cannot be read, the previous copy is used and the agent is told which holds were restored; if neither can be read, the agent is told once that the holds were lost. If the machine that runs the line changes, the old machine's holds do not move with it: it sends one message listing them to the session named in `monitoring.localVerify.operatorSession`, or raises an attention item when that is not set or the message could not be delivered to a running session.

Two things change for every install, whether or not the controls are turned on. The Local Verify audit log gets one `boot` row at each server start, with the reason the restart request carried or `unknown`, so restarts made only to reorder can be counted. And the verifier's version changes with this build, so each machine tests its open changes once more after installing it.

## What to Tell Your User

Nothing changes unless you run a Local Verify test line and turn the new setting on. If you do: you can now ask your agent to keep a pull request out of testing for a while, or to test one next, and it happens right away without restarting anything, so tests that are running are no longer thrown away just to change the order. A held pull request is listed where the queue is shown, and your agent reminds you once if a hold outlasts the date you gave, or a day.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Hold a pull request out of the test queue | `POST /local-verify/queue/hold {"pr", "by", "reason", "until"?, "blockMerge"?}`; end it with `POST /local-verify/queue/release {"pr", "by"}` |
| Do not test and do not merge, in one request | Add `"blockMerge": true` to the hold |
| Test a pull request next, even when the queue is full | `POST /local-verify/queue/front {"pr", "by", "reason"}`; end it with `POST /local-verify/queue/unfront {"pr", "by"}` |
| See held and fronted changes | `GET /local-verify`, under `operator` |
| Turn the controls on | Set `monitoring.localVerify.queueControls` to `true` in `.instar/config.json` on the machine that runs the line (read live) |
| Be told when holds are left behind on a machine that no longer runs the line | Set `monitoring.localVerify.operatorSession` to the name of the session that operates the line (read live) |
| Count restarts by reason | `boot` rows in `logs/local-verify.jsonl` (automatic) |

## Evidence

Unit tests written for this change: `operatorQueue.test.ts` (the file, the previous copy, the bound), `operatorHoldService.test.ts`, `operatorFrontService.test.ts` and `operatorQueueRoutes.test.ts`, 4 files, 97 tests passed. The five existing unit files for the service, the main-red hold, the waiting list, the peers and the routes passed with no edit (328 tests), which is the check that the queue is unchanged with the setting off. `tsc --noEmit` clean; `npm run lint` clean. An integration test of the four routes through the real router and an end-to-end test on the production wiring were written with this change; they were type-checked here and run in the full verify, not on the build machine.
