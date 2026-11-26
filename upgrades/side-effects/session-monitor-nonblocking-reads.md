# Side-Effects Review — the session monitor's per-poll checks use the non-blocking tmux reads

**Version / slug:** `session-monitor-nonblocking-reads`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 by reversibility (a revert undoes it; no stored data or config changes; the monitor part is live only where the existing dev-gated async hot path is on), with a second-pass review because it touches session recovery decisions. 3 source files, 2 test files. No spec review rounds; independent review of the code (the first read raised four should-fix findings, all applied).

`SessionMonitor.poll()` made three synchronous tmux subprocess calls per session per minute on the server's main thread (about 12 ms per session on a quiet Studio; the second largest synchronous spawn caller in a profile of the loaded server). Where the async hot path is on, the per-poll liveness and screen reads now go through the existing awaited twins.

Two repairs in the shared async tmux path came out of the review and ship with it because the monitor's correctness depends on them: a missing tmux socket is now classified as definitely absent, and the capture single-flight key includes the line count.

Fifth part of CMT-1718. Still open there: the supervisor's cleanup of a live verify child, and the remaining per-poll file reads listed in section 2.

## Decision-point inventory

- **SessionMonitor health classification** (healthy, idle, unresponsive, dead; feeds restart and user notices): same rules. Its liveness input changes source where the async path is on, with one stated difference (section 1 and 2).
- **`tmuxExecAsync` outcome classification** (success, definitely-absent, indeterminate; feeds the reaper's mark-completed, `enrollExistingOriginSessions`, the post-kill check, `hasActiveProcessesAsync`, `checkSessionWorkState` and this monitor): one more message is classified definitely-absent. The boot purge is NOT among them: it reads tmux through `SessionLivenessOracle`, which has its own, deliberately conservative classifier and still treats a missing socket as indeterminate.
- **`captureOutputAsync` single-flight**: which concurrent callers share one subprocess.

## 1. Over-block

- **Indeterminate reads as alive, and its screen is not read that poll.** This covers both sources of the answer: a tmux that did not reply in time, and a pane that ended with no exit status or signal (tmux answered, but the answer does not prove the session finished). The synchronous path treated the second as alive too, but read the retained pane and ran context-exhaustion detection on it; here that waits for a later poll. That state is normally short-lived. A session whose liveness tmux cannot answer in time is left alone that poll. If tmux stays wedged, a dead session with a waiting user is not restarted through the quiet dead-session path; after 10 minutes it is classified unresponsive and goes to mechanical recovery and triage, as any silent live session does. The synchronous path would have called it dead after a 5 s timeout per session, on the main thread, and tried a restart that itself needs tmux. Five indeterminate polls in a row are logged once and emitted.
- **A slow poll skips ticks.** With tmux wedged, each session costs up to 9 s (the screen read is skipped after an indeterminate liveness), sequentially: 10 sessions, 90 s, so one tick is skipped and logged. The synchronous worst case was 5 s per session with the whole server blocked.

## 2. Under-block

- **A session that is really gone but whose tmux server still answers slowly** is handled as in section 1.
- **Still synchronous in the monitor, per poll, per session:** `getTopicHistory` (a tail read and parse of the message log file). Not a subprocess; not changed here.
- **Still synchronous, rare:** the re-checks of liveness inside the notify and restart decisions, and `SessionRecovery.checkAndRecover`, which run only for an unhealthy session with a waiting user and are cooldown-limited.
- **The list of active topics is read once per poll.** The awaited reads widen the window in which a topic removed during a poll is still checked from that list; the same window already existed at the monitor's later awaits. Not changed here.
- **`classifyPaneCommand` logs** a line for a bare-shell or unknown pane command on every call; the synchronous check logged neither. One more log line a minute for such a session.

## 3. Level-of-abstraction fit

The monitor takes the reads as dependencies, as it does the synchronous ones; the server decides which to provide from the existing gate. The classifier and single-flight fixes are in `SessionManager`, where every user of the async path gets them.

## 4. Signal vs authority compliance

No new authority. The monitor keeps its authority over session recovery with the same rules; its liveness signal becomes tri-state where it was two-state with a hidden timeout. The direction of the change is toward keeping a session (never toward restarting or reaping one on a probe that failed to answer), which is the principle the async path was built on.

The classifier change moves one message from "don't know" to "absent". That widens what the reaper may mark completed and what `checkSessionWorkState` may call idle. It is limited to the one errno that means the socket does not exist. The residual risk: if the socket file is deleted while the tmux server keeps running (a temp-directory cleaner, for example), the sessions are alive but unreachable, and these consumers now act on "absent": the reaper marks them completed, the monitor restarts the conversation on a fresh server and the old agent processes are left running, and the work-state check says idle. The synchronous path, and so the whole fleet with the gate off, already behaves this way; it is a change only against the async path's previous behaviour of keeping such sessions indefinitely.

## 4b. Judgment-point check

Not applicable: no judgment call is replaced by a rule.

## 5. Interactions

- **Single-flight sharing.** The monitor's reads join an identical read already in flight (same op, same session, and now for captures the same depth) and count as one of at most 8 in flight; at the ceiling it gets an immediate indeterminate without spawning. The poll is sequential, so it holds at most one slot.
- **Reentrancy.** `checkSession` now yields at its first line. Every write to the monitor's snapshots, cooldowns and notice ledgers happens inside `checkSession`, reached only from `poll()` behind its running guard. `isSessionStarting` and the live session name are re-read after the await, so a session replaced during the read is not acted on.
- **Other async-path users** see the two shared fixes: a missing socket now reads as absent for the reaper and the other `tmuxExecAsync` callers (so sessions lost with the tmux server are marked completed promptly, where before they stayed indeterminate until tmux was started again), and overlapping captures at different depths no longer share a result. The boot purge is unchanged (see the inventory above), so after a reboot it and the reaper can disagree for a tick about the same session; the reaper's answer is the correct one. `checkSessionWorkState`'s 30-line capture uses the same keyed form, so it still shares with other 30-line readers.
- **The degraded-tmux guard** receives the monitor's call outcomes as latency samples, as it does for every other async caller.

## 6. External surfaces

None for users. One new monitor event (`monitor:liveness-indeterminate`) with no consumer yet; one new public method (`SessionManager.isSessionAliveNonBlocking`); two optional members on `SessionMonitorDeps`.

## 7. Multi-machine posture

Machine-local by design and unchanged: each machine's monitor checks its own tmux sessions; topics owned by a peer are skipped as before.

## 8. Rollback cost

Revert the commit, or set `monitoring.tmuxResilience.asyncHotPath.enabled` to false to return the monitor (and the rest of the hot path) to the synchronous reads.

## Conclusion

Takes three synchronous subprocess calls per session per minute off the server's main thread on development agents, makes a slow tmux read as "don't know" in the monitor where it used to read as dead, and repairs two defects in the shared async path. Ship, and continue CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only; it read the code and ran two tmux probes on private sockets in round 1; it did not run the tests, so the pass counts in the release note are mine).

**Round 1: Concern raised, no blocker.** Four should-fix findings, all applied:

- S1: with the tmux socket file missing (after a reboot or a cleaned temp directory), the async path answered indeterminate forever, so a dead session with a waiting user was never restarted through the quiet path. Fixed in the shared classifier: that one error now reads as definitely absent. I did not take the alternative of a synchronous confirm after several indeterminate polls, which would have put blocking calls back on the main thread exactly when tmux is wedged.
- S2: on a wedged tmux the monitor waited out a second timeout for the screen read and skipped ticks silently. Fixed: no screen read after an indeterminate liveness, and a skipped tick is logged.
- S3: the capture single-flight key ignored the line count, so overlapping captures at different depths shared one result; the monitor would have become a regular participant. Fixed in the shared path.
- S4: tests did not cover the cases the change is about. Added: a rejecting read, a run of indeterminate answers, overlapping polls, the capture skip, the missing-socket and unreachable-socket classifications, captures at two depths, the public tri-state name.

Nits: N4 (doc comment placement) applied. Left as stated in section 2: N1 (one more log line per poll for a bare-shell pane), N2 (`getTopicHistory` still synchronous), N3 (the active-topic list is read once per poll).

**Round 2: Concern raised on the documents.** R1: the documents said the classifier fix reaches the boot purge; it does not (the boot purge reads tmux through `SessionLivenessOracle`). Documents corrected; the oracle question is filed separately. Nits R2 to R6 applied: the residual risk of a socket deleted under a live server is stated; the warning wording and the documents cover the dead-pane-without-status source of indeterminate; the streak belongs to one session name and is dropped when a peer takes the topic; the screen-activity test runs in both modes; three overstated sentences in the overview corrected.

**Round 3: Concur.** All verified in the code and documents; no off-by-one in the streak logic; one untested line noted (the peer-owned streak deletion), now covered by a test.

**Reviewer concurred:** yes (round 3).

