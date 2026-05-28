# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor consumer — receiver wiring + anti-ping-pong tracker.** Closes the mentor round-trip
on Echo's side. Three coupled additions, all dark at the same `mentor.botToken` gate as the
prior PR (until the bot is configured, none of this runs):

- A new `OutstandingPromptTracker` — per-mentee, persistent across server restart — that
  refuses to send a new mentor prompt while a prior one is in flight within
  `replyTimeoutMs` (default 20 min, > the 15-min tick interval). This makes the original
  "ping-pong" concern structurally impossible at the cadence layer.
- A `mentor-reply` role-handler installed on the mentor-bot adapter via the receiver hook
  from the prior PR. When Codey replies, the handler clears the outstanding-prompt by
  correlation id + persists the reply to `mentor-replies.jsonl` for Stage-B forensics.
  The handler's closure has minimal capability — it cannot reach `spawnStageA` / scheduler
  / `deliverToMentee` / Threadline (structural anti-loop invariant).
- `deliverToMentee` integrates the tracker: sweeps orphans on each call + surfaces each
  one as a deduped `DegradationReporter` event (silent reply-loss is observable). Marks
  on successful send; defers if prior-prompt-in-flight.

## What to Tell Your User

- Plumbing for the mentor feature — your concern about agents bouncing messages back and forth in a loop is now structurally impossible at the timing layer. Echo cannot send a new mentor message while it's still waiting on the prior reply, and if a reply never arrives an alert is raised instead of a silent retry. Stays completely dark until the mentor bot is configured.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mentor receiver + anti-ping-pong (dark) | Internal — `OutstandingPromptTracker` (per-mentee persistent state) blocks re-sends while a prior is in flight; mentor-reply role-handler clears the tracker on reply; orphan-sweep emits one deduped `DegradationReporter` event per orphaned correlation id |

## Evidence

**Net-new groundwork, not a bug fix.** 10 new unit tests for `OutstandingPromptTracker`,
all green: anti-ping-pong assertion (markSent → canSendTo returns prior-prompt-in-flight);
clearByCorr happy + spurious; cross-mentee non-blocking; persistence across re-open
(server restart preserves in-flight state); reply-timeout sweep; sweepExpired returns
orphans; orphan-notify idempotency (don't re-spam the same orphan-episode); corrupt-file
recovery starts fresh. The receiver wiring + tracker integration in `AgentServer.deliverToMentee`
is the dark layer that the bot-setup live flow will exercise in the next PR.
`tsc --noEmit` clean. 50 mentor-stack tests across the staged build, all green.
