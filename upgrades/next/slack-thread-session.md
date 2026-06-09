## What Changed

feat(slack): thread→session mapping — a Slack **thread** can be its own resumable agent session (mirroring Telegram topic→session), via a routing-key abstraction. **Opt-in, default OFF.**

- `resolveRoutingKey(channelId, threadTs, ownTs)` → `channelId` by default; `channelId:thread_ts` only when the channel is opted in (`SlackConfig.threadSessions`) AND the message is a reply *inside* a thread (a thread root stays on the channel session). Registry + 24h resume map keyed on the routing key; raw channel + thread_ts retained for all Slack API/replies.
- No regression: with no config the routing key equals the channel id → byte-for-byte today's one-channel-one-session behavior. No cross-talk (distinct threads → distinct keys). Migration-parity: `slack-reply.sh` gains an optional (regex-gated, backward-compatible) `thread_ts` arg + a `PostUpdateMigrator` marker refresh.

## What to Tell Your User

Nothing changes by default — this ships opt-in. When you enable thread→session routing for a channel, the agent treats each thread as its own ongoing conversation (its own resumable session) instead of folding every thread into one channel session — the same way each Telegram topic already gets its own session. Two parallel threads stay separate; returning to a thread resumes it. Direct channel chat (and channels you don't opt in) is unchanged.

## Summary of New Capabilities

- **`SlackConfig.threadSessions: { enabledChannelIds?, allChannels? }`** (opt-in, per-channel) — routes replies inside a thread to a per-thread agent session (`channel:thread_ts`). Off everywhere by default.
- `slack-reply.sh` accepts an optional 2nd positional `thread_ts` to reply into a specific thread (backward compatible).

## Evidence

- 84 tests across the affected/new files: routing-key resolution (off/on, thread-root, two-threads-distinct, same-thread-same-key, mixed config), registry+resume keyed on the routing key, `sendToChannel`/`isSystemChannel` routing-key tolerance, inbound thread-metadata, the HTTP reply route threading + resolving the thread session, `slack-reply.sh` thread-arg behavior, and the migrator marker refresh. `tsc --noEmit` clean; broader Slack/SessionManager/migrator/reply suites green.
