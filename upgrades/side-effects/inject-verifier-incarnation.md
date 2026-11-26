# Side effects — injection-verification incarnation scoping

## What this change can stop happening

The only behavioural change is that `verifyInjection`'s remaining rungs are skipped once the session's native conversation id has rotated. Consequences, including the unwelcome ones:

1. **A genuinely stuck message whose session is respawned for an unrelated reason loses this ladder's remaining rungs.** The respawn path re-injects and starts its own ladder, so the delivery is still verified — but by the NEW ladder, with its own nine-second budget starting at the re-injection. If a future respawn path is ever added that does NOT re-inject, this guard would drop the verification for it. The mitigation is that the guard triggers on the id rotation written by `setClaudeSessionId`, which today is only reached on respawn/resume paths that carry the message with them.
2. **Fewer `SessionManager.verifyInjection` degradation entries.** Dashboards, the degradation digest and the feedback webhook will see a drop. That drop is the removal of false positives, not of real ones — a count going down here is the intended effect and must not be read as "injection got more reliable".
3. **One new log line per abandoned ladder.** `[SessionManager] Injection verification for "<session>" abandoned at attempt N: the session was respawned (native id rotated), so this pane is a different attempt that verifies itself.` On a machine where respawn-recovery is frequent this is roughly as chatty as the warning it replaces. It is deliberately a `console.log`, not a degradation: the hand-off is normal operation.

## What it cannot do

- It never presses a key, never injects, never kills or spawns anything. The only new read is one `state.listSessions()` lookup per ladder rung, wrapped in try/catch returning null.
- It cannot suppress the real verdict for a session that is NOT respawned: with a stable id the ladder runs unchanged, which is covered by a test.
- It cannot be triggered by the first binding of a native id (null → value), which is covered by a test. Without that exception, every session injected into before its id was bound would have lost its verification.
- A state read failure returns null on both sides, so the guard is inert rather than abandoning. Covered by a test.

## Blast radius

`src/core/SessionManager.ts` only: one new private helper (`injectionIncarnationId`) and a guard at the top of `verifyInjection`'s `runCheck`. Every injection into every framework passes through `verifyInjection`, so the code path is hot — but the guard is a no-op whenever the id is unchanged or unknown, which is the overwhelming majority of rungs.

`tests/unit/session-injection-verify.test.ts` was also changed: its seven source-text contract assertions now slice the whole method instead of a fixed 5,000-character window. This weakens nothing — the window had silently stopped covering the end of the method, which is how it failed a contract the code still honoured — but it does mean those assertions now read a longer string, so a future assertion written against them should not assume a bounded size.

## Rollback

Revert the commit. There is no flag, no config key and no persisted state, so a revert restores the previous behaviour exactly, including the false alarms.

## What was deliberately NOT done

- **The codex-only stranded-draft record was left alone.** `recordStrandedDraftMarker` is still called only for `codex-cli`, so for a claude session the `Persistent StuckInputSentinel` named in the degradation's `fallback` field has no durable marker to act on, and its 10-second tick with a 2-tick floor cannot engage inside a short-lived job session anyway. That is a real second defect — the message names a backstop that cannot reach this case — but it is a separate change with its own risk (recording markers for claude sessions changes what the sentinel acts on fleet-wide), and the honest fix for THIS bug does not need it.
- **No attempt was made to make the Enter more reliable.** The eaten-Enter race in the terminal interface is upstream of us; the recovery already works.
