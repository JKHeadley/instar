# Side-Effects Review — local-verify survives server restarts

**Version / slug:** `local-verify-restart-safe`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur (see below)`

## Summary of the change

Live runs on 2026-10-22 (audit `logs/local-verify.jsonl`, 12:23Z) showed four restart defects: an auto-update shutdown cancelled a 35-minute verify; the service then started the next queued verify during shutdown (the cancelled child's exit ran `pump()`), which the new boot found alive with unconfirmed identity (`orphan-reap-incomplete`); the queue was in memory only and was lost; and `rebuildIndex` discarded every record (`skippedVersion`) because `verifierVersion` was the package version. Changes: `src/localVerify/LocalVerifyService.ts` (a `stopped` flag that gates `pump()`, `request()` and the cancel kill-timer; `shutdown()` re-queues the cancelled entry at the head; `persistQueue()` / `restoreQueue()` over `state/local-verify/queue.json`; `restartHolds()` + `restartHoldUntil()`), new `src/localVerify/verifierVersion.ts` (content hash), `src/localVerify/localVerifyWiring.ts` (`registerLocalVerifyRestartHold`, `verifierVersion: computeVerifierVersion(...)`), `src/commands/server.ts` (registers the hold after boot), `src/localVerify/localVerifyRoutes.ts` (`stopping` → 503), and the state registry (`local-verify-queue`).

## Second-pass fixes (round 1)

The first second-pass review found six problems; each now has a fix and a test that fails without it (checked by mutation):

1. **Indefinite hold.** A finished verify started the next one at once, so a busy queue kept the hold alive, and the AutoUpdater resets its max-deferral clock when a newer version arrives. Spec §2 Restarts rule (b) is now built: `decideUpdatePause` (pure) plus `updatePendingFromAutoUpdater` read "update pending" as autoApply on and `pendingUpdate` set or `coalescingUntil` a real time (not `'notified'`), timed from `pendingUpdateDetectedAt`. While pending and only this verifier's hold delays the restart (`getRestartBlockers()` shows nothing but `hold:local-verify…`), `pump()` starts no new verify; the running one ends and the restart goes ahead. Starts resume after 120 min pending, or when something else delays the restart anyway; unknown state never pauses. Paused time is accrued per entry (`pausedMs`, persisted) and subtracted from the starved clock.
2. **Crash re-run loop.** The running entry is written with `inFlight: true`; a clean shutdown re-queues it unmarked. A marked entry found at boot (unclean exit) is charged one error retry through `decideVerifyRetry`; past the limit it is not re-queued and an `error` record with `errorStep: server-restarted` is written.
3. **Restore race.** `restoreQueue()` sets `restoring`: `request()` waits behind it (FIFO kept: restored entries stay ahead), `pump()` starts nothing, `persistQueue()` writes nothing until the restore has the whole picture. Restore no longer pumps; the next tick or request does.
4. **Version hash.** `vh2:` = the real local import graph (type-only imports skipped, as the build erases them) from the child entry and the record-meaning server modules (`VERIFIER_ROOTS`: runVerifyMain, LocalVerifyService, mainHealth, record, policy, StatusReconciler) through `src/core`, `src/feedback-factory` and `scripts/` — today 23 files including SafeGitExecutor, SafeFsExecutor, SourceTreeGuard, hostTestRunnerSemaphore, reviewGate and the floor script — plus the installed `typescript` version, `process.version`, the protected-path list's VALUE (it is passed to the child as data, so its value rather than its 400-line source file is what a verdict depends on), and the policy hash. Wiring and routes are not roots: they pull in Config and HTTP plumbing (the full localVerify directory graph is 112 files) that change with most releases and never alter a verdict. The child recomputes the hash at start and refuses with `verifier-mismatch` (recorded as `errorStep: verifier-mismatch`) when it differs from what the server passed.
5. **Corrupt `queue.json`.** Moved aside to `queue.json.corrupt-<ts>`, audited `queue-restore-unreadable`; invalid entries are counted (`queue-restore-invalid-entries`); `queue-restored` carries per-reason drop counts (closed, head-or-base-moved, already-recorded, duplicate, queue-full, server-restarted).
6. **Writes only on change.** `persistQueue()` compares the serialized content with the last write.

## Decision-point inventory

- `LocalVerifyService.pump` — modify — refuses to start anything once `shutdown()` ran.
- `LocalVerifyService.shutdown` — modify — cancels without a kill timer, re-queues the cancelled PR entry at the head, persists.
- `LocalVerifyService.restoreQueue` — add — at boot, keep / drop each saved entry (closed, head or base branch moved, already green).
- `LocalVerifyService.restartHolds` → AutoUpdater restart-hold path — add (feeds an existing gate) — names the running verify and its end time.
- `decideUpdatePause` (rule (b)) — add — pauses NEW starts while an update waits only on this verifier; bounded at 120 min.
- `doRestoreQueue` unclean-exit handling — add — charges one error retry via the existing `decideVerifyRetry`; stops with `server-restarted`.
- `runVerifyMain` version check — add — refuses to run under a mismatched verifier.
- `rebuildIndex` version check — pass-through — the comparison is unchanged; the value it compares (`verifierVersion`) is now a content hash.

The self-action decision functions (`decideVerifyRetry`, `decideStarved`, `decideStart`, `decideMain*`) are unchanged, so the convergence models in `src/testing/selfActionRegistry.ts` still drive the same code (`tests/unit/self-action-convergence.test.ts` passes).

---

## 1. Over-block

- The restart hold delays an automatic update restart by up to the running verify's own ceiling (≤ 3 h: 120 min active budget + two 30-min in-place waits), capped by `maxDeferralHours` (default 4 h) and by the AutoUpdater's own max-deferral clock. A release that must land fast is applied manually (not held).
- `POST /local-verify` answers 503 `stopping` during the shutdown window. A caller retries after the restart; nothing legitimate is refused outside that window.
- Restore drops an entry whose PR is closed or whose head/base branch moved; that entry would have been verified for a state that no longer exists, so dropping it loses nothing.

## 2. Under-block

- The hold bound is the run's maximum, not its remaining time: the server cannot see the child's in-place waits, so a run near its end still holds up to the ceiling measured from its start. It never holds past the run's own deadline.
- A crash (no graceful shutdown) leaves `queue.json` from the last change; an entry added in the instant before the crash may be lost. Every queue mutation persists, so the window is one synchronous step.
- `verifierVersion` follows the relative import graph by a static scan of import specifiers; a module loaded through a computed path or a package import (other than `typescript`, whose version is hashed) is not followed. Stated in the module.
- Rule (b) reads `getRestartBlockers()`; if the AutoUpdater does not expose it, the blockers count as unknown and starts never pause (fails toward verifying, and the AutoUpdater's own max-deferral still bounds the hold).
- Paused time is accrued at tick/pump granularity, so the interval between the last paused observation and the first unpaused one is counted as paused (at most one 30 s tick).
- An unreadable PR at restore is kept (it refuses at request time if it stays unreadable).

## 3. Level-of-abstraction fit

The hold feeds the existing AutoUpdater/UpdateGate restart-hold mechanism (the same one pairing invites use) instead of adding a new restart gate. The queue file follows the service's existing atomic-write pattern (`inflight.json`). The version hash replaces a value, not a mechanism.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The restart hold is a bounded signal consumed by the AutoUpdater's deferral path, which already owns the restart decision, its max-deferral ceiling and the manual-apply bypass. The queue/restore logic decides only what the verifier itself runs next; it has no block surface over any other actor.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The restore rules (closed, head moved, already green) are an enumerable invariant: a record is keyed by (pr, head, base branch), so a changed key is by definition a different verify. The hold bound is the run's own deterministic deadline.

## 5. Interactions

- **Shadowing:** the hold is one provider among the AutoUpdater's holds; the soonest-ending hold sets the retry time, and the max-deferral ceiling still applies to all of them.
- **Double-fire:** `shutdown()` is idempotent (`stopped` guard). The cancelled child's exit runs `onExit`, which records nothing for a cancelled run and cannot start another (pump is gated) — the 2026-10-22 PR 2297 start-during-shutdown is closed.
- **Races:** if the old child is still alive at the next boot (SIGTERM not yet effective), the orphan reap runs before restore; an unconfirmed group blocks every restored entry until it is gone (tested).
- **Feedback loops:** a restored entry that errors follows the existing retry table (`errorRetries` is persisted, so a restart cannot reset the one automatic re-run); an entry that was running at an unclean exit is charged one error retry, so a crash-restart loop cannot re-run it forever.
- **Hold vs queue:** the hold and rule (b) together bound an update's wait to one running verify (≤ its ceiling), never a chain of them; the 120-min pending cap stops a long-pending update from starving verification in turn.

## 6. External surfaces

- Persistent state: new `state/local-verify/queue.json` (≤ 11 entries, replaced in place), registered as `local-verify-queue`.
- Update timing: automatic restarts can wait for a running verify (bounded as above); the deferral and its reason are visible in `/updates` status (`restartDeferral.currentBlockers: ["local-verify:pr-N"]`).
- Existing journal records written under the package-version scheme no longer match and are re-verified once after this ships; after that, unchanged-verifier releases keep records.
- No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: the queue names runs on this machine's own bare clone and process groups, like the journal and in-flight record; lease acquisition by a different machine already starts that machine from its own (empty) state. No user-facing notices, no URLs.

## 8. Rollback cost

Pure code change plus one state file (and, rarely, a moved-aside `queue.json.corrupt-<ts>`). Records written with `vh1:`/`vh2:` versions re-verify once after any version-scheme change. Reverting restores the old behaviour (no hold, in-memory queue, package-version records); a stale `queue.json` is then ignored. No migration. Records written with `vh1:` versions would be re-verified once by the reverted code.

## Conclusion

The four restart defects observed on 2026-10-22 and the six second-pass findings each have a fix and a test that fails without it (checked by mutating each guard away: the shutdown `stopped` gate, the rule (b) pause, the unclean-exit charge, the restore persist guard and request wait, write-on-change, and the corrupt-file move). The design reuses the AutoUpdater hold path rather than adding a gate. Follow-ups: the spec's "hold heads whose projected status is success" rule is left as the `extraHolds` seam in `registerLocalVerifyRestartHold` until merges consume local-verify. Clear to ship after the second-pass review.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: back-to-back verifies plus frequent releases could hold an automatic update indefinitely (the AutoUpdater resets its deferral clock on a newer version), so spec §2 rule (b) is now built (no new verify starts while an update is pending and this hold is the only delay; resume after 120 minutes); an unclean exit re-ran the in-flight verify at every boot with no limit (now one error retry, then an `error` record); a POST during restore could rewrite the queue without unrestored entries (now queued behind a `restoring` flag); the version hash missed the verifier's other imports, the typescript and node versions (now the real import graph plus both versions, and the child refuses on a mismatch); a corrupt queue file was silently overwritten (now moved aside and audited); the queue file was rewritten on every pump (now only on change). Round 2 verified each fix and concurred; leftover noted: a `verifier-mismatch` is filed as a crash, so it re-runs once before ending as an error record (bounded, safe direction).

## Evidence pointers

`tests/unit/localVerify/LocalVerifyService.test.ts` — describes `restart hold`, `shutdown`, `durable queue`, `rule (b)…`, `unclean exit…`, `restore race`, `corrupt queue.json and restore audit`, `queue.json is written only when it changes`, `verifierVersion: the real import graph…`.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` is not the class here; the change touches a self-triggered controller (the verify queue's restart/resume) but adds no new emit. The shutdown re-queue is a one-shot operator/update-driven action.
- **`closure`** — `guard`
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (local-verify-error-rerun, local-verify-capacity-requeue, local-verify-main-schedule), howCaught: the decision functions the queue uses are unchanged and still driven by the convergence models; the persisted errorRetries/attempts keep the steady-state bound across restarts (a restart cannot reset the one automatic error re-run)}`.
