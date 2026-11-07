# Convergence report: a native conversation for every session (part 2 of 3)

This took four review rounds, each by an independent reviewer subagent that read the spec against the code and, from round 2, against the draft implementation. Round 4 found no design defects and one code issue, now fixed and tested. No cross-model pass ran.

## ELI10 overview

When you start a new session, you can give it its own conversation in the Instar app, and that's the default when you don't use Telegram or Slack. The agent creates the conversation, sets its engine if you picked one, gets its memory privacy right, and starts the session attached to it. Starting one twice by accident, even across a restart, makes one conversation, not two.

## What the rounds changed

- **Round 1 (7 defects).** Each fix:
  - The memory place is recorded before the session starts. Otherwise its first message would replace it.
  - The relay is checked before anything is created.
  - "Started" is said only when true, with a reason when it isn't.
  - The engine and machine pickers were split.
  - A standby creates the conversation and leaves the session to the serving machine.
  - Title rules apply.
  - A first form of repeat protection was added.
- **Round 2 (4 defects, 6 code issues).** Each fix:
  - A standby refuses an engine pick and never seeds, because its profile store isn't read by the serving machine.
  - The session is never named after the person's name, which would make the session manager reuse another session.
  - One request id per New session sheet.
  - Cause-neutral memory words.
  - Single-flight repeats.
  - Refusals in words.
  - The new session records what it launched on.
- **Round 3 (1 defect, 5 code issues).** Repeat protection became durable through the phone's request store, with boot recovery. The e2e test was added. The phone refuses an over-long app name before Face ID.
- **Round 4 (0 defects, 1 code issue).** A refused create releases its request instead of replaying it. A resumed create seeds if needed. The request's identity includes the engine pick.

| Round | Design defects | Code issues | Minor |
|---|---|---|---|
| 1 | 7 | — | 5 |
| 2 | 4 | 6 | 5 |
| 3 | 1 | 5 | 8 |
| 4 | 0 | 1 | 6 |

## Left as is, by design

- Within the 5 minutes after a restart, a retry gets "may or may not have been created; check first". The message tells the person to check before trying again.
- The memory check uses the agent's default engine, as every inbound message does.
