<!-- bump: patch -->

## What Changed

Fixes two real defects in the Telegram lifeline's queue-replay path that, together, caused the "incoherent reply to a one-message topic" symptom (2026-06-06, topic 21487): a user's substantive message was lost during a server CPU-starvation episode, then a later short nudge spawned a session with no context that confabulated an unrelated status report.

1. **False-drop fix.** `replayQueue` previously burned a single failure counter on every forward failure while `supervisor.healthy` was true. Under CPU starvation the server is healthy-but-too-slow, so forwards time out, all 3 attempts burn in ~90s, and the real message is dropped ("Handoff to server failed after 3 replay attempts" — 32 such drops on echo, including live operator messages). A new `forwardToServerClassified` distinguishes a genuine HTTP-400 rejection (`poison` — the only message-specific failure) from transient timeout/5xx/503/network/skew failures. A new pure `decideReplay` policy (`src/lifeline/replayPolicy.ts`) burns the small poison drop-budget only on a 400; transient failures never drop a real message. A generous transient backstop still bounds a permanently-unreachable server.

2. **Untracked-loss fix.** `MessageQueue.drain()` emptied the persisted queue up front, holding messages only in memory; a process exit mid-replay (update / version-skew / launchd restart) lost undelivered messages with no record — not even in `dropped-messages.json`. `replayQueue` now consumes durably: it works from `peek()` and removes a message from the persisted queue only after delivery or a deliberate drop, persisting strike counters in place via `updateReplayCounters()`. A mid-replay restart can no longer lose a message.

The persisted queue gains an additive, back-compatible `transientReplayFailures` field; no migration is needed.

## What to Tell Your User

Nothing required — this is a behind-the-scenes reliability fix. If your machine was overloaded, the part of me that catches your messages while the server is busy could, in rare cases, give up on a message and throw it away as if it were broken — or lose one entirely if I restarted at the wrong moment. That is now fixed: a busy or restarting server makes your message wait in line and get retried instead of being discarded, and a message only leaves the line once it is actually delivered. The practical effect is that you should stop seeing replies that have nothing to do with what you asked.

## Summary of New Capabilities

- The lifeline now classifies a failed message handoff as either a genuinely-bad message (only an HTTP-400 server rejection) or a transient capacity failure (timeout, server-busy, network) — and only a genuinely-bad message can ever exhaust the drop budget.
- Queued messages are consumed durably: a message leaves the on-disk queue only after it is delivered or deliberately dropped, so a restart mid-replay cannot silently lose it.
- A generous transient backstop drops a message only after a server has been unreachable across many attempts, always with an honest record and a resend notice — never silently.

## Evidence

- `tests/unit/lifeline/replayPolicy.test.ts` — both sides of every decision boundary, including the incident regression: many consecutive transient failures never drop a message and never touch the poison budget.
- `tests/unit/lifeline/MessageQueue-durability.test.ts` — `remove`/`updateReplayCounters` persist correctly; a simulated mid-replay process exit leaves undelivered messages on disk (no untracked loss).
- `tests/unit/lifeline/version-skew-recovery.test.ts` — updated to pin the new wiring (classified forward + `decideReplay` + durable peek/remove).
- Local verification: `tsc --noEmit` clean, all 9 lint gates clean, 157/157 lifeline unit tests + the stage-c chaos integration test green, 28 new/updated targeted tests green. Full unit suite deferred to CI (timed out locally under the live CPU-starvation episode this fix addresses).
