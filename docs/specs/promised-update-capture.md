# Promised-update capture

**Tier:** 1 (a revert fully undoes it). **Bug:** Echo Bugs topic 10000002488, Instar feedback fb-43834231-9a6.

## Problem

On 2026-11-07 at 17:01 PST Echo ended a status message in topic 137342 with "Next update by about 7 PM." No update was sent; the session stopped after 18:18 and nobody returned to the work until the operator asked 37 hours later.

Nothing knew a message was owed, because nothing recorded the promise:

1. **CommitmentSentinel** pairs a user message with the agent's reply and asks only about "user asked, agent agreed" commitments. The 17:01 message was an unprompted status update with no user message before it, so it was never shown to the detector.
2. **Action-Claim sentinel, lane B** (enabled on Echo) reads only the first 500 characters of a turn. The promise started at character 704 of a 730-character message. Its time pattern (`CommitmentTracker.detectTimePromise`) also has no clock times ("by 7 PM"), only "in N minutes", "by EOD" and "tomorrow". It also reads the session's final turn text, which is often not the message that was sent.
3. The working rule "open a commitment when you promise a time" depends on the session remembering. It failed on 2026-10-13, 2026-11-03 and 2026-11-07.

The dated check-in reminder (`checkInAt` + `CheckInReminderReconciler`, live on Echo) would have fired at 7 PM. Nothing gave it a row.

## Design

Record the promise from the message that was actually sent, at the moment it is logged, and reuse the existing dated reminder for the due time.

- `src/monitoring/promisedUpdateDetector.ts` (pure). A sentence must hold a promise-of-a-message cue ("next update", "I'll report back", "you'll hear from me", "update by") and a concrete time: a clock time with am/pm or a 24-hour hh:mm, noon/midnight, optionally "tomorrow" or a weekday, or "in/within N minutes/hours". Times resolve in the agent's zone (`commitments.promisedUpdateCapture.timeZone`, else the machine's), DST-correct, rolling a past clock time to the next day. Retrospective or negated sentences ("I promised…", "no update by…") are skipped. Horizon: 2 minutes to 36 hours (a week with a weekday).
- `src/monitoring/PromisedUpdateCapture.ts`. Chained onto `TelegramAdapter.onMessageLogged` in `server.ts`, the seam every outbound and inbound message passes. For an agent message (`provenance: 'agent'`) in a topic:
  - every earlier open promised-update commitment in the same topic, made at least 5 minutes before this message, is closed `delivered` (this message is the update; a message within 5 minutes is the rest of the same report);
  - if the message promises a time, one commitment is recorded: `checkInAt` = time + 15 minutes grace, `externalKey: promised-update:<topic>:<messageId>` (a replay never makes two), `beaconEnabled: false` (the reminder is the follow-through).
- `CheckInReminderReconciler`: for a promised-update row the reminder text says the update is late (fixed template, quotes the promise), and after it is delivered and stamped, `resumePromisedUpdate` hands the promise to the topic's session. `routes.ts` wires that to `telegram.onTopicMessage`, the inbound path that delivers to a live session or resumes/respawns a dead one, exactly as dashboard decisions are handed over. The handoff carries `senderUnverified: true`, so it is never operator authority. Without a session path the text makes no pickup claim.
- Gate: follows `commitments.checkInReminder.enabled` through `resolveDevAgentGate` (live on development agents, dark on the fleet like the reminder), with `commitments.promisedUpdateCapture.enabled` as an explicit override, read live.

## Acceptance

- The exact 17:01 message records a commitment due 19:00 PST (checkInAt 19:15).
- A later agent message in the topic closes it; a split message seconds later does not.
- When due with nothing sent: one late-update line, one handoff, never repeated.
- User, automation and unknown-provenance messages never record or close.
- Agent awareness: template line plus a `migrateClaudeMd` arm for existing agents.
