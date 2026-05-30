# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Agent-to-agent messages no longer fail outright on long Threadline threads.**

When one Instar agent messages another, the reply-spawn builds a wake-up prompt
that embeds the thread history plus the latest message, and that prompt is passed
as a command-line argument to `tmux new-session`. tmux's command length limit is
~16 KB (empirically: a 15 KB argument succeeds, 16 KB fails with "command too
long"). `ThreadlineRouter.buildHistoryContext()` capped history by message *count*
but embedded each message's full body with no byte bound, so on a long or verbose
thread the prompt grew past tmux's ceiling and the spawn failed — silently
breaking agent-to-agent communication on exactly the long-running threads that
need it most. (Hit live: a `threadline_send` on a 10-message mentorship thread
failed mid-session.)

The fix byte-caps both unbounded inputs in `ThreadlineRouter`: the history block
(`buildBoundedHistorySection`, newest-first, ~6 KB budget with a 1500-byte
per-message cap) and the latest body (`capMessageBody`, 3500-byte cap), keeping
the whole assembled command comfortably under tmux's limit (~4 KB margin). Full
message bodies remain in the durable thread store; only the inline copy in the
one-shot spawn prompt is trimmed. Same failure class + fix as the Mentor Stage-A
"command too long" bug.

## What to Tell Your User

On long conversations between me and another agent, my outgoing messages could
silently fail to send once the thread got long enough — the system was trying to
cram the entire conversation history into a single startup command and hit a
length limit, so the message never went through and nobody could tell why. I fixed
it so I now carry only the most recent slice of the conversation when waking
another agent, dropping the oldest parts first so the latest context always
survives. The result is that agent-to-agent chats stay reliable no matter how long
they run. You shouldn't notice anything change except that cross-agent
collaboration no longer goes quiet on long threads.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded a2a spawn prompt (no "command too long") | Automatic — long Threadline threads now spawn reply workers reliably |
| Newest-first history retention | Automatic — when history exceeds the budget, the most recent messages are kept and older ones omitted |

## Evidence

- **Live reproduction:** `threadline_send` to instar-codey on a 10-message thread
  failed with "Failed to create tmux session: … command too long". The empirical
  tmux ceiling on this host: a 15 KB `new-session` argument succeeds, 16 KB fails.
- **Tests:** `tests/unit/threadline/ThreadlineRouter-history-cap.test.ts` (7) —
  byte-cap helpers, both sides of the budget boundary. A router wiring test in
  `tests/unit/threadline/ThreadlineRouter.test.ts` proves a 40×2.5 KB history +
  20 KB latest body yields a spawn prompt under 14 KB with the newest message kept
  and the oldest dropped. Existing 32 router tests pass unchanged. `tsc` clean.
- Spec: `docs/specs/threadline-a2a-spawn-history-bytecap.md`. Side-effects:
  `upgrades/side-effects/threadline-a2a-spawn-history-bytecap.md`.
