# Upgrade Guide — promised-update-capture

<!-- bump: patch -->

## What Changed

When an agent message to a Telegram topic names a time for the next update ("Next update by about 7 PM", "I'll report back in 30 minutes"), the server now records a dated promise from the message itself, at the moment it is logged (`src/monitoring/PromisedUpdateCapture.ts`, chained onto `TelegramAdapter.onMessageLogged`). Any later agent message in the topic closes it. If nothing follows by the time plus 15 minutes, the existing check-in reminder posts one line saying the update is late, quoting the promise, and hands the promise back to the topic's session through the inbound path, which resumes or respawns it. Before this, recording such a promise depended on the session remembering; the 2026-11-07 "update by about 7 PM" (Echo Bugs 10000002488, fb-43834231-9a6) was missed because CommitmentSentinel only reads user→agent pairs and Action-Claim reads only the first 500 characters and has no clock-time pattern. Follows the `commitments.checkInReminder` gate (live on development agents, dark on the fleet); `commitments.promisedUpdateCapture.enabled` overrides; `commitments.promisedUpdateCapture.timeZone` sets the zone times are read in.

## What to Tell Your User

When I tell you "next update by 7 PM", that time is now tracked for me automatically. If I go quiet past it, you get a short note that the update is late, and I'm restarted on it so the update actually arrives.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Promised update times are recorded automatically and followed up if missed | Automatic where the check-in reminder is on; `commitments.promisedUpdateCapture.enabled` to override |

## Evidence

The exact 17:01 message from topic 137342 resolves to 7:00 PM PST in `tests/unit/promised-update-detector.test.ts`. `tests/unit/promised-update-capture.test.ts` runs the whole lifecycle on a real CommitmentTracker: recorded, closed by a later message, or at 7:16 PM one late-update line plus one handoff, never repeated. `tests/integration/promised-update-routes.test.ts` covers the real route wiring to `onTopicMessage`; `tests/e2e/promised-update-capture-alive.test.ts` the server.ts wiring on a real AgentServer.
