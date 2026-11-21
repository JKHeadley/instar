# A planned restart keeps the lead

<!-- bump: patch -->

## What Changed

A machine that held the lead and restarted for a reason it asked for (a role change, an update, a restart through the API, the app or the dashboard, or the Telegram fix command) came back without it whenever its boot took longer than the lease's time-to-live. On the Mac Studio on 2026-11-21 that was a loop: it received the lead by hand-back, asked for the one planned restart a role change needs, its boot outlasted the lease, boot claim safety made it ask its peers first, the Laptop had taken over meanwhile, and ten minutes later the hand-back gave it the lead again — five restarts between 08:27Z and 09:55Z (feedback fb-135e3043-add).

Now, on a development agent (`multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity`, riding the development-agent gate; `takeoverReadyPool.enabled: false` is the rollback):

- Every writer of `state/restart-requested.json` that lives in the server announces the request before the file becomes visible (`src/core/restartRequestSignal.ts`). While the request is pending, the holder's renewals carry a bounded window as their expiry instead of the TTL: the slowest of its last twenty measured boots plus a margin, or three TTLs plus the margin before any boot is measured (233 s on a 60 s TTL), never above the thresholds after which peers would take over a silent holder. The renewal is also written beside the lease (`state/lease-continuity.json`, signed) and the local lease record carries a pending marker.
- The three writers behind nearly every holder restart (role change, update, API restart) wait up to 8 s for that renewal to be confirmed before they write the request. Requests written outside the process are seen by a 2 s poll and extended at once.
- At boot, such a *window lease* is not held from the local file. The machine asks its peers first and renews the same epoch only after a live peer's identity-verified answer shows no newer epoch; a peer already at a newer epoch is adopted; a pool where every peer is presumed dead or has been silent for boot claim safety's span is kept as a survivor hold. Lease initialisation waits up to 120 s for that verdict. The boot's length is measured and feeds the next window.
- The pending state ends only when the request is withdrawn by this process, is absent for 60 s with no consumer's ledger row, was consumed but the process is still alive after the shutdown bound, or has waited four hours; a consumer's deletion alone never ends it, because the kill follows the deletion.
- A mesh-off pool's legacy lease dial now records a peer whose reply carries an identity ack bound to the request nonce as a signed answer for the boot hold (it read every legacy answer as silence).
- `/health` (with your token) shows `multiMachine.syncStatus.pendingRestart` while a restart is pending; the server log says what happened in `lease-continuity:` sentences.

## What to Tell Your User

If one of your computers leads the others, it now keeps that role when it restarts for a reason it asked for: an update, a change of role, or a restart you asked for from the app, the dashboard or a message. Before, a slow restart handed the lead to another computer and could hand it back and forth for an hour. A restart you ask for through the API answers up to 8 seconds later than before while the lead is secured. Two things do not change yet: a computer that is killed or loses power still gives up the lead the old way (a later change removes the restart that role changes need), and a machine rolled back to an older version in the middle of a restart boots the old way once. Nothing changes for agents that are not development agents yet.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| A planned restart keeps the lead | Automatic on a development agent; `takeoverReadyPool.enabled: false` turns the whole takeover-ready pool off |
| See whether a restart is pending on the holder | `GET /health` (with your token) → `multiMachine.syncStatus.pendingRestart` (`requestedBy`, `since`, `windowMs`, or `null`) |
| Override the window | `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.windowMs` (still under the peer-enforced caps) |
| Read what happened | server log lines beginning `lease-continuity:`; evidence rows under `multiMachine.takeoverReadyPool` in `logs/feature-evidence.jsonl` |

## Evidence

- The incident, from the Studio's own `logs/restart-requests.jsonl`: five planned role-change requests consumed between 08:27:43Z and 09:55:21Z on 2026-11-21, boots of 1.5 to 14 minutes against a 60 s TTL. PR #2783 (`b7f693390`) widened the role-restart condition to `applies: config.scheduler.enabled`, which is why a pool with a named preferred machine restarts for role changes at all; the widening is kept and recorded in the role-restart spec.
- `tests/unit/LeaseCoordinator-plannedRestartContinuity.test.ts` (32 tests) reproduces the night: WITHOUT the fix the restarted holder's lease has lapsed at boot and the peer's newer epoch is adopted (the lead is gone); WITH the fix the same epoch is confirmed back and the lead is kept; plus every boundary (not the holder, no peers, switch off, unconfirmed broadcast, episode end rules, superseded, survivor hold, expired window, tampered record, relinquish, late promotion) and the second-pass review's fixes (TTL renewal at an episode's end, a superseded record force-expired, liveness-off survivor hold, the lapsed verdict, the git-store fold).
- `tests/unit/LeaseContinuity.test.ts` (23), `tests/unit/restartRequestSignal.test.ts` (9), `tests/unit/HttpLeaseTransport-bootProbe.test.ts` (13, 3 new: legacy dial with a verified ack is signed; without one, silent; probe listeners).
- `tests/integration/planned-restart-lease-continuity.test.ts` (4): the real `HttpLeaseTransport` against a peer answering the real `/api/lease` and `/api/lease/pull` shapes over HTTP, on the mesh dial and the legacy dial — the window reaches the peer, the boot confirms the same epoch, a newer epoch supersedes.
- `tests/e2e/planned-restart-keeps-lead-boot-path.test.ts` (8): the real `MultiMachineCoordinator.initializeLease` with boot claim safety on and off, the dark-pool survivor hold, supersession, the dark switch, and production wiring by text (server.ts deps, shutdown exit stamp first, watcher wait, every writer announces before publishing).
- Existing lease suites rerun (93 files named, 308 tests): one pinned expectation changed by design (a legacy dial with a verified ack is now `signed`); `tests/e2e/role-restart-wiring.test.ts` unchanged and green; `npx tsc --noEmit -p .` clean.
- Not run here: a live two-machine drill. This machine is a shared verifier with one test slot and the operator asked for no server restart and no live config change; the live proof is the parent's weekly takeover drill once this is on a development agent.
