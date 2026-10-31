# Side-Effects Review — update activation peer pause

**Version / slug:** `update-activation-peer-pause`
**Date:** `2026-10-31`
**Author:** Echo
**Second-pass reviewer:** independent AutoUpdater/Local Verify review; concurred after exception cleanup

## Summary of the change

A process-local marker is set before installing an update. Local Verify treats it as a bounded pause for new PR checks during installation and each restart decision, including manual apply with automatic updates off. A failed install or a decision to defer or batch the restart clears the marker. The durable deferral rule then governs admission until a retry starts. A successful restart request keeps the marker until the old process exits; the new process starts with it clear. This closes the observed gap between clearing `pendingUpdate` and requesting a restart.

Tier 1 is proposed because the change is reversible, has no new persistent schema or configuration, and changes admission only while an update is in motion. The existing merge-authorizing checks and evidence requirements remain intact. Most added lines are tests, this review, and the release note. One independent review round found an exception path, which was fixed and concurred with on the second pass. A separate M5 integration test fixture correction is documented below; the same reviewer concurred with that delta. The three focused activation test tiers, build, and lint passed; the full suite and exact-head merge check remain required before release.

## Decision-point inventory

- `AutoUpdater.applyPendingUpdate`: sets the marker before awaiting install; clears it on failed install and retains it on success.
- `AutoUpdater.gatedRestart`: retains the marker through a written restart request; clears it when the restart is deferred, batched, refused by cooldown, fails to write, or a gate dependency throws.
- `updatePendingFromAutoUpdater`: treats a valid marker as pending, with a 120-minute bound from the current attempt; during the restart decision it wins over other blockers that might end before the request.
- `LocalVerifyService.peerRun` and local start: use the existing `notePause` checks; they refuse or wait rather than create a record.
- `GET /updates/status`: exposes the marker timestamp for diagnosis, without changing a command or allowing a restart.

## 1. Over-block

A new check waits while installation runs and through the short restart decision. If a restart request is written but the process fails to exit, the marker can hold starts for up to 120 minutes. After that cap, checks resume; the verifier's installed-code mismatch check still protects record integrity. A durable deferral clears the marker, so an unrelated long-lived session does not hold the peer idle merely because bytes are installed.

## 2. Under-block

A process crash or an updater created from an old persisted state has no process-local marker. The existing durable deferral and installed-verifier mismatch checks still apply. Explicit `forceRestart:true` remains an operator override that can interrupt a check. The marker does not make a restart and a check atomic across two independent processes; it closes the observed in-process admission window before child spawn.

## 3. Level-of-abstraction fit

The updater owns the install/restart phase and exposes its status. Local Verify already has a single update-pending admission function, so the change extends that seam rather than adding a second scheduler or a file lock.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The marker is a temporary negative admission signal. It cannot authorize a green record or merge. A false positive delays a check within the existing bound; an unreadable status keeps the previous fail-open behavior, with verifier-code mismatch checked before a child starts.

## 4b. Judgment-point check

No new heuristic chooses a winner between conflicting evidence. The marker is set by the updater's exact control flow and read by the existing deterministic pause rule.

## 5. Interactions

- **Shadowing:** A durable restart deferral takes over after a deferral decision; the marker is cleared so an unrelated blocker exception still works.
- **Double-fire:** Repeated apply calls are already serialized by `isApplying`; the marker does not schedule a restart.
- **Races:** `peerRun` checks `notePause` again after asynchronous PR validation and before synchronous acceptance. A restart retry sets the marker before checking holds and keeps it through the request. The live M5 race is the regression target.
- **Feedback loops:** The marker is process-local, bounded, and cannot create a new update or retry timer.

## 6. External surfaces

`GET /updates/status` gains `updateActivationPendingSince`, an ISO timestamp or null. No new endpoint, config key, persistent schema, message, or operator step. No migration is needed for existing agents: the code ships in the package and the marker is initialized on every server boot.

## 7. Multi-machine posture

Each peer maintains its own marker. The coordinator sees `slotBusy` from peer status and does not dispatch into a paused peer. A peer already reserved before the marker is set remains covered by the existing restart hold. The coordinator's retry of an interrupted attempt remains the fallback if an operator forces a restart.

## 8. Rollback cost

Revert this patch and ship another release. The response field disappears; no durable state needs repair. Until the rollback is applied, a verifier can again accept a check in the install-to-restart gap.

## Conclusion

The change closes the observed restart admission window while preserving bounded deferral behavior and full-suite merge authority. Ship after the three test tiers, full suite, and independent review pass.

## Second-pass review

The independent reviewer identified an exception path that could leave the marker active after a restart gate failed before writing a request. The revised code clears it on both the first decision and deferred retries, and clears it if the restart request file cannot be written. The reviewer concurred with the revised diff and found no further P1/P2 issue. The two exception paths have unit boundary tests; the reviewer did not run tests.

## M5 tmux fixture repair

Three recent M5 PR checks (#2376, #2381, #2505) failed the unrelated `foreign-process-survives-test-instance` integration file, including their in-run isolation reruns. A captured JSON report from a fourth run showed the exact assertion: the test expected a dead pane to retain its old `pane_pid`, but tmux 3.7c returned an empty string. The test now accepts either a retained old pid or an empty pid. It still requires `pane_dead=1`, requires the owned tmux session to be removed, and spies on `process.kill` to prove no process signal is sent. A different nonempty pid still fails. This changes a test fixture assumption, not production process ownership or killing behavior. A manual isolated run passed before the change, which is why the loaded-run report was needed for the diagnosis.

The independent reviewer concurred: the old-pid representation remains tested on hosts that report it; the no-signal assertion remains on hosts that return empty, and the test rejects any different nonempty pid. The reviewer found no material safety issue in shipping this narrow compatibility repair with the activation fix.

## Evidence pointers

- Live incident: M5 applied v1.3.1552 at 21:10:36 UTC; PR #2381 was accepted at 21:11:17; after restart, the peer returned `state:unknown` for that attempt.
- Focused unit tests: 149 passed after updating the old-process/new-process admission expectation. Build and lint passed.
- Authenticated HTTP integration: 7 passed, including refusal and post-activation acceptance. Production-shaped E2E: 2 passed, including manual apply with auto-apply off. These tiny tests waited 21 and 26 minutes respectively for the shared Studio suite slot.
- Full-suite result: the first unit run found two scanner-counted catches. Both already logged the errors; explicit `@silent-fallback-ok` annotations restored the 494 baseline in a focused rerun. The complete suite rerun is pending in the Studio suite-slot queue behind active merge checks. Exact-head Local Verify remains the merge authority.
