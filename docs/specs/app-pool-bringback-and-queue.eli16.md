# Bring It Back Here, and Waiting App Messages: Plain-English Overview

## The problem in one breath

The first real test of moving an app conversation between two machines found two bugs. When the machine running a moved conversation was switched off, the phone did not offer "Bring it back here" for 15 minutes. And a message sent while that machine was off was saved but never delivered, even after the machine came back, on an agent that has no Telegram.

## What already exists

- An app conversation can be moved to another of the agent's machines. The machine that serves the app (the lease holder) keeps a record of where each conversation runs.
- If that machine stops answering, the phone can offer "Bring it back here": the person confirms, the conversation comes back, and the other machine's copy is shut down when it reconnects.
- A message for a conversation whose machine can't be reached is saved in a queue and delivered when the machine answers again.

## What was wrong

- To decide whether the other machine was answering, the holder used a reading that stays "alive" for 15 minutes after the last contact. That window suits failover, which must not react to a short blip, but it hid "Bring it back here" for 15 minutes.
- The queue passed every saved message to a delivery step that is only set up when the agent uses Telegram. On an agent without Telegram, saved app messages could never be delivered and simply expired.

## What this changes

- The holder now treats the other machine as answering only if it reached it directly within the last 2 minutes, the same rule the pool's readiness check already uses. "Bring it back here" appears about 2 minutes after a machine stops answering.
- Saved app messages now go straight to the app's own delivery step, whether or not the agent uses Telegram.

## The safeguards

**Bringing back is still the person's decision.** It is offered sooner, but it only happens when the person taps it and confirms a warning that the other machine's session will be stopped when it reconnects.

**A machine that comes back cannot take over again.** Its record is older than the holder's, so it closes its stale copy.

**Nothing else moves.** Telegram and Slack messages are delivered exactly as before. Failover keeps its 15-minute window.

## What ships when

Both fixes ship together. The feature stays off for the fleet and on for development agents only.

## What you actually need to decide

Nothing. These are bug fixes found by the planned two-machine proof, and the proof's step 7 will be rerun on them.
