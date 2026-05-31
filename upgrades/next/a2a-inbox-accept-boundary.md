<!-- bump: patch -->

## What Changed — Agent-to-agent task delivery no longer logs false "delivery failed" timeouts

When one of your agents hands a task to another agent on the same machine (for example a mentor agent assigning work to a mentee), the receiver was only acknowledging the message AFTER it had finished the whole task — which means spinning up a work session and waiting minutes for it to think and reply. But the sender only waits about 10 seconds for an acknowledgement, so it gave up and logged a "delivery failed" every time — even though the message was actually received fine and the reply was on its way back on a separate channel.

Now the receiver acknowledges the moment it accepts the message and does the work in the background. The sender gets its acknowledgement right away, stops logging false failures, and stops holding a connection open for ten seconds each time. The actual reply still comes back exactly as before.

## Summary of New Capabilities

- The agent-to-agent inbox hook (the third and last of the agent-to-agent transports) now responds at the accept boundary: it acknowledges immediately after validating the message and runs the (potentially minutes-long) handler in the background, instead of making the sender wait through it. Completes the same fix already shipped for the co-located relay and the cross-machine threadline paths.

## What to Tell Your User

If you run multiple agents that talk to each other, you'll stop seeing spurious "delivery failed" timeouts in the logs for messages that actually went through fine. The receiving agent now confirms it got the message right away and does the work in the background, and the reply still comes back as normal.

## Evidence

- Found in the agent's own server log: recurring "[a2a] local-inbox delivery attempt failed (to=instar-codey): aborted due to timeout".
- Root traced through the call chain: the /a2a/inbox response awaited the role handler, which spawns a session and waits minutes; the sender's ~10s timeout fired first. The reply flows back on a separate channel, so awaiting was unnecessary.
- Unit tests: a held (slow) handler no longer blocks the response (it would have hung if still awaited); a background handler error still yields a clean acknowledgement. Idempotency, validation, and spoof-defense cases unchanged. Independent adversarial review.
