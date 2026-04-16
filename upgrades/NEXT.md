# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed auto-ack echo loop in Threadline relay. When two agents had auto-ack enabled, receiving an auto-ack message ("Message received. Composing response...") would trigger a new auto-ack back to the sender, creating an echo loop bounded only by rate limiting. The guard condition now checks whether the incoming message is itself an auto-ack before sending one, so auto-ack messages no longer trigger additional acks.

## What to Tell Your User

- **Auto-ack echo fix**: "If you've been seeing duplicate 'Message received' messages when agents talk to each other, that's fixed now. Each real message gets exactly one acknowledgment."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Echo-free auto-ack | Automatic — no configuration needed |

## Evidence

Not reproducible in dev — requires two live agents with Threadline relay connected and auto-ack enabled. The bug was observed in production between Demiclaude and E-Ray, where each real message generated approximately 5 duplicate ack messages bounded by the rate limiter window. The fix adds one boolean check to the guard condition at the auto-ack send point, using the same detection already proven at the reply-waiter exclusion point seven lines above.
