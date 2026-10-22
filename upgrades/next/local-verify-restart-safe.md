## What Changed

- **local-verify survives server restarts** (spec `docs/specs/local-verify-merge-authority.md` §2 "Restarts" and step 6). Three releases on 2026-10-22 each restarted the server and cost verify work: an auto-update cancelled a 35-minute verify, a queued verify started during shutdown, the queue was lost, and every green record was discarded because records were keyed to the package version.
  - **Restart hold:** while a verify runs, an automatic update restart waits for it, through the existing AutoUpdater restart-hold path (`registerLocalVerifyRestartHold`, key `local-verify`). The hold ends at the run's own ceiling (its 120-minute active-work budget plus two 30-minute in-place waits), capped by the gate's `maxDeferralHours`. A manual apply is not held.
  - **Shutdown:** `shutdown()` stops the in-flight run's process group and starts nothing else (no pump, no timer). The cancelled verify goes back to the head of the queue, not counted as an attempt. `POST /local-verify` answers 503 (`stopping`) during shutdown.
  - **Durable queue:** PR verify entries (pr, head, base, first-queued time, attempts, error retries; the in-flight entry first) are written atomically to `state/local-verify/queue.json` on every change. They are restored at boot, dropping PRs that closed, heads that moved, and verifies already recorded green. Restored entries wait for the orphan reap before starting, and a request arriving during the restore waits behind it. `main` verifies are re-derived, not persisted.
  - **No indefinite hold:** while an update is pending and only a running verify delays it, no new verify starts (spec §2 Restarts rule (b)); starts resume after 120 min pending or when something else delays the restart. That wait never counts toward the starved alert.
  - **No crash re-run loop:** a verify that was running when the server died uncleanly is charged one error retry; past the limit it records `error` (`server-restarted`) instead of re-running.
  - **`verifierVersion`** is now a content hash (`vh2:…`) of the verifier's real local import graph (including SafeGitExecutor, SafeFsExecutor, hostTestRunnerSemaphore, reviewGate and the floor script), the installed `typescript` version, the node version, the protected-path list and the policy hash, instead of the package version. A release that does not change any of those keeps its records. The run child recomputes it and refuses (`verifier-mismatch`) if its code on disk differs from the running server's.
  - A corrupt `queue.json` is moved aside (`queue.json.corrupt-<ts>`) and audited; `queue.json` is rewritten only when its content changes.

## What to Tell Your User

Nothing to do. My own test runs for pull requests now survive my updates: an update waits for a run in progress, and anything waiting in line is picked up again after the restart instead of being forgotten. Results stay valid across updates that don't touch the checking code, so they aren't redone.

## Summary of New Capabilities

- No new routes. `POST /local-verify` can now answer 503 `stopping` while the server shuts down.
- New state file `state/local-verify/queue.json` (registry category `local-verify-queue`).

## Evidence

- Unit (`tests/unit/localVerify/LocalVerifyService.test.ts`): the restart hold through the real AutoUpdater (an automatic restart is deferred with blocker `local-verify:pr-1`; a manual apply restarts); the hold's bound and cap; shutdown (SIGTERM only, no timer, nothing started after, entry back at the head with attempts 0, `stopping`); queue persisted and restored with closed / moved-head / already-green entries dropped; restored entries blocked behind an unconfirmed orphan until it is gone; `verifierVersion` stable across an unchanged verifier and changed by a module, a new file, or the policy hash; records kept across a boot with unchanged verifier content and re-verified when it changed.
