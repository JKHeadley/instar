# A message sent while its topic moves machines is no longer lost

## What Changed

When a topic with no current owner was placed on another machine, the router sent the first message with ownership number 0 and ignored the reply. A machine that still held an older record for that topic refused it as out of date, and the router logged it as started anyway, so no machine answered. The hand-off now sends the real ownership number and the sender, reads the reply, and retries on network errors. If the other machine refuses or never answers, the router keeps the topic and answers on its own machine; if it cannot, the message goes to the durable inbound queue or the normal local handling.

## What to Tell Your User

If you run your agent on more than one machine, a message you send just as a conversation moves between machines now always gets answered. Before, it could sit unanswered until you wrote again.

## Summary of New Capabilities

No new capability. Multi-machine placement now confirms that the receiving machine took the message, and keeps it locally when it did not.

## Evidence

Incident: Echo Bugs hub message on 2026-11-01 22:00:16Z, Studio log `route topic 10000000001 → action=spawned … acked=true` while the Mama PC never started a session. Tests: tests/unit/SessionRouter.test.ts ("remote placement reads the spawn ACK", including a replay with the real receive handler holding an epoch-3 record) and tests/unit/session-router-spawn-ack-wiring.test.ts.
