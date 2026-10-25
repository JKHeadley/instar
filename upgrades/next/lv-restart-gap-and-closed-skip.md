## What Changed

- **A release takes effect after the running verify, not after the whole queue.** The local verifier already had a rule: while an update is waiting and this verifier's own hold is the only thing delaying the restart, it starts no NEW verify, so the running one finishes and the restart goes ahead. The rule never engaged after the update was applied: the AutoUpdater clears `pendingUpdate` the moment the new version is installed, and from then on only its durable `restartDeferral` says a restart is waiting. The verifier read only `pendingUpdate`/`coalescingUntil`, so it saw "nothing pending", started the next queued verify seconds after each one ended, and the restart (retried every 5 minutes) kept finding a new run in flight (2026-10-25: v1.3.1429 deferred from 08:30Z for hours: `Restart deferred for v1.3.1429: held for in-flight work: a local verify of PR #2194 …`, then PR #2183, then `main`; on 2026-10-24 v1.3.1423 installed 21:06 PDT and restarted 21:42 only because the queue drained). An active `restartDeferral` now counts as pending, timed from the earlier of detection and the first deferral, so the existing 120-minute cap and the "something else is delaying it" rule apply unchanged.
- **A merged or closed PR is no longer verified.** `POST /local-verify` for a PR that is not open answers `409 { code: "pr-closed" }` instead of queueing it, and drops any entry already queued for that PR (a run in flight finishes). An entry that waited long enough to take the pre-start re-read (5 minutes, or `main` moved) also asks GitHub whether the PR is still open; a definite "closed" drops it with a `dequeued` audit event (`reason: "closed"`) instead of spending an ~18-minute run on it. An unknown answer (GitHub unreadable) keeps the entry, as before. The pre-start re-read now runs even where no base-branch reader is wired.

## What to Tell Your User

Nothing to do. New versions of me now switch on within one test run of being installed instead of waiting until my verify queue happens to empty, and pull requests that were already merged no longer sit in the queue using up test runs.

## Summary of New Capabilities

- `POST /local-verify` result code `pr-closed` (HTTP 409).
- `updatePendingFromAutoUpdater` reads `restartDeferral` (`LocalVerifyAutoUpdaterView.getStatus()` carries it; the real AutoUpdater already exposed it).
- Audit events in `logs/local-verify.jsonl`: `refused` with `reason: "pr-closed"`; `dequeued` with `reason: "closed"`.

## Evidence

- `tests/unit/localVerify/LocalVerifyService.test.ts` ("a deferred restart is a pending update"): the pure mapping on both sides of the boundary; through the REAL `AutoUpdater` + `registerLocalVerifyRestartHold`, a restart deferred only for the running verify (`pendingUpdate: null`, `restartDeferral.active`) stops PR 2 from starting when PR 1 ends, the retry then writes `restart-requested.json`, and the queue resumes after. ("closed PRs are skipped"): POST for a closed PR answers `pr-closed` and drops its queued entry while a run in flight carries on, an unknown answer queues; at pick time a PR merged while it waited is dequeued (`reason: closed`) and the next one starts, an unknown one still starts. `tests/unit/localVerify/localVerifyRoutes.test.ts`: `pr-closed` → 409. 5 of the 6 fail against the previous code (the 6th covers the second-pass reviewer's point); 413/413 local-verify unit tests pass with it.
- Live: `.instar/state/auto-updater.json` on 2026-10-25T09:15Z read `pendingUpdate: null`, `restartDeferral: { active: true, targetVersion: "1.3.1429", firstDeferredAt: "2026-10-25T08:30:12.997Z", currentBlockers: ["local-verify:main"] }` — the exact state the verifier did not count as pending.
