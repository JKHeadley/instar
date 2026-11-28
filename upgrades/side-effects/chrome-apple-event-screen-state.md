# Side effects: name the Apple Event failure and record the screen state at a failed repair

**Change.**
- The normal-Chrome driver (`chrome-js.sh`) now names the macOS error behind `apple-event-failed`: not-permitted, timeout, no-such-tab, process-gone, connection-invalid or not-understood.
- On that failure the driver adds plain words from this agent's own lock reading: "console locked", "display asleep", or "console locked or display asleep (lock flag set, not confirmed)".
- A failed sign-in repair drive now records one audit note, `screen-state-at-failure`, with the screen state.

**Origin.** On 2026-11-26 the Studio and Mini returned a bare `apple-event-failed`. A probe showed OSStatus -1712 (timeout) even for Chrome's app name, while the Studio console was locked with its display asleep. The installed driver read no error code. Reading a JXA `Ref()` out-parameter after a failed send crashes osascript (SIGSEGV, reproduced on the M5); the driver uses a `$()` NSError holder, which is safe.

1. **Over-block.** None. Nothing new is blocked; the outcome of every call and every repair is unchanged.
2. **Under-block.** None, because this blocks nothing. A screen state the lock reader cannot read stays silent (no words, no note), and that is reported as unmeasured, never as awake.
3. **Level of abstraction.** The driver is where the error code exists. The orchestrator is the one place every drive failure passes through. The lock verdict comes from the existing `MachineLockStateReader`; no new detector is added.
4. **Signal vs authority.** Signal only. The note is a separate event row and never changes the state, the failure class or the reason. `unknown` is never reported as locked.
5. **Interactions.** The store queries that count events filter by named classes (challenges, cancels, admissions, hard lines). One query reads the newest event of any class: re-admission of a repair cancelled because its incident closed. That query now skips `screen-state-at-failure`, and `recordNote` writes nothing when the episode's version moved since the drive read it or the episode has ended. A cancel that lands during the 3s screen read wins: the orchestrator checks the abort signal again after the read and returns the cancelled result, exactly as before. The note reason passes `reloginReasonToken` (the `browser-` prefix). The reader call is bounded to 3s and swallows its own errors.
6. **External surfaces.** The event appears in `GET /subscription-relogin/:id/events`. The driver's error line gains words after the existing `ERR apple-event-failed` prefix, so callers matching that prefix are unaffected. The driver makes one localhost GET to the lock-state route, with the agent's own token passed to curl on stdin (never in its argv, so it is not in the process list). The secret-store fallback is bounded to 3s and the GET to 5s.
7. **Multi-machine posture.** Machine-local by design (`machine-local-justification: hardware-bound-resource`): the screen state belongs to this machine's console. Each machine's notes are already readable pool-wide through the existing repair events route.
8. **Rollback.** Revert the commit. The notes left behind are inert rows.

## Second-pass review (2026-11-27, independent reviewer)
Concern raised, then fixed:
1. A cancel during the screen read could leave the note as the newest event, so a repair cancelled because its incident closed would never be re-admitted, and a stale version could throw out of `tick()`. Fixed: abort re-check after both reads; `recordNote(id, expectedVersion, ...)` skips moved or ended episodes; the re-admission query skips the note class. Tests: a cancel during the read (drive returned and drive threw) ends cancelled with no note and the cancel as the newest event; `recordNote` on a moved or ended episode writes nothing.
2. The token was in curl's argv. Fixed: header on stdin (`-K -`); checked on the M5 (200 with it, 401 without).
3. The secret-store fallback had no time limit. Fixed: `perl alarm 3`.
Reviewer confirmed the rest: event class shape, reason token prefix, timer cleanup, catch-path abort order, exit codes and the `ERR apple-event-failed` prefix.
