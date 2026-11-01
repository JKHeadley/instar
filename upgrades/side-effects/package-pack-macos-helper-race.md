# Side-Effects Review — macOS package retry and dead-pane cleanup

**Version / slug:** `package-pack-macos-helper-race`
**Date:** `2026-11-01`
**Author:** Echo
**Second-pass reviewer:** dedicated safety reviewer — concurred after nonce and atomicity corrections

## Summary of the change

`tests/unit/package-completeness.test.ts` now exposes npm errors and retries only an `ENOENT` for a temporary macOS capture helper, at most 16 times. `src/threadline/PipeSessionSpawner.ts` stamps new tmux sessions with a random session-local nonce in the same tmux command queue as creation and requires that stamp for cleanup. On tmux 3.7c, an owned retained dead pane may have a blank PID; its session can now be removed without signalling a process. The integration test checks actual spawn stamping, session removal, mismatched-nonce refusal, and zero process signals. Merge authority is unchanged.

## Decision-point inventory

- Package test retry classifier — modified: bounded retry for one temporary-helper `ENOENT`; other npm errors fail immediately.
- PipeSessionSpawner ownership — modified: matching nonce required for all cleanup; a blank-PID dead pane also needs the recorded session ID and dead state. Live panes still require the recorded PID before a process signal.

## 1. Over-block

No user action is blocked. A tmux session without the recorded nonce remains untouched, even if its name and ID match; this may leave an orphan if the nonce cannot be read, which is the intended ownership boundary. Genuine package failures still fail immediately.

## 2. Under-block

An undocumented tmux dead-pane format will remain untouched. If nonce stamping or readback fails just after spawn, the spawner refuses to track that new session, which may then remain until it exits. The 17-attempt package bound can still fail if helper churn lasts longer. These failures remain visible and cannot produce a green merge result.

## 3. Level-of-abstraction fit

The package retry belongs in the packaging test. Session ownership belongs in PipeSessionSpawner, which holds the session ID and PID and owns cleanup. The session-local nonce distinguishes a replacement even if tmux restarts and reuses an ID; a merge coordinator cannot safely infer that identity.

## 4. Signal vs authority compliance

Per [signal-vs-authority](../../docs/signal-vs-authority.md), session ownership is a hard process-safety invariant, not a judgment about intent. A matching nonce and exact dead-pane row authorize only tmux-session removal; they never authorize `process.kill`. The live process-signal path additionally requires the recorded PID. The package retry is test code and cannot authorize a merge; Local Verify retains the full-suite verdict.

## 5. Interactions

The verifier isolates each lane with `TMUX_TMPDIR`, which exposed the M5 failure. A replacement session with a different ID or nonce remains untouched. Creation and nonce stamping share one tmux client command queue, so a server restart cannot insert a different session between them. For every tmux session removal, `if-shell -F` rechecks the nonce in the same server command as `kill-session`; blank-PID panes also recheck dead state. The nested tmux command is shell-single-quoted so a session ID such as `$0` reaches tmux literally instead of expanding to `/bin/sh`. This closes the server-restart window between the first read and removal. The live process-group signal still has the prior check-to-signal PID race; this change narrows ownership with the nonce but does not make operating-system signalling atomic with tmux. The existing cleanup path still clears spawner bookkeeping. The package retry is independent.

## 6. External surfaces

On tmux 3.7c, the spawner now removes its own retained dead pane instead of leaking it. It also stores an internal nonce as a tmux session option. No message, API, config, published package content, or operator action changes. An unfamiliar tmux row fails toward leaving the session in place. No operator surface is added.

## 7. Multi-machine posture

Machine-local by design. Each spawner owns tmux sessions only on its own machine using that machine's recorded session ID, PID, and nonce. No state replication, topic-transfer behavior, or generated URL changes. The package retry runs on whichever machine runs the test.

## 8. Rollback cost

A normal revert release restores prior dead-session behavior; no migration or persistent state repair is needed. The npm flag and retry bound can likewise be reverted without changing published package contents.

## Verification and proportion

Two earlier M5 full unit suites failed only the package test after 54,070 other tests passed. A concurrent package/helper run reproduced `ENOENT`; the corrected earlier branch passed the full M5 unit, integration, and E2E suites. PR #2521's M5 merge check passed unit tests but failed the process-ownership integration file, including its isolation rerun. With the verifier's isolated `TMUX_TMPDIR`, the failure reproduced at the session-removal assertion. After the nonce fix, that isolated M5 test passed all nine cases, including actual spawn stamping, mismatched-nonce refusal, and zero process signals. The Studio pre-push smoke then caught shell expansion of tmux's `$0` ID in the nested conditional kill command; the command is now single-quoted. A fresh full suite and Local Verify result on the new PR head are still required before merge.

Tier 1 is declared for a narrow, reversible repair, with independent safety review because cleanup touches session lifecycle. No spec review rounds were needed; the merge-check failure prompted one additional commit and gate attempt.

## Independent review

Concur with the review. The safety reviewer identified and verified corrections for tmux server ID reuse, creation-time stamping, and the check-to-removal race. The final design queues creation and nonce stamping in one tmux client command, checks the stamp before tracking, and makes every session removal conditional on the nonce inside tmux. The blank-PID path also requires dead state and never signals a process. The inherited live process-group check-to-signal race is disclosed above.
