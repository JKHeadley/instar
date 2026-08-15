# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Replies to the operator now use the spawn capacity that was already reserved for them.

Every model call on a machine competes for a fixed number of concurrent slots. Two of
those are reserved for a lane the outbound message gate is explicitly named for — a
review a human is actively waiting on. The reservation was enabled and the gate was
allowlisted to use it.

The gate claims that reserve only when told BOTH that the recipient is the operator and
that someone is waiting on this specific message. It was told the first. Nothing ever
told it the second — so the condition was never true and the reserved slots were never
claimed. Operator replies queued behind background work and, under load, the gate failed
closed and held them.

Measured during a live incident: sends refused 12 times in ~15 minutes, with two slots
reserved and zero in use.

## What to Tell Your User

- "If my replies ever stalled while background work was busy, that's fixed — replies now
  use capacity that was set aside for them."
- "It changes which queue a check waits in. It does not change what the check decides."

## Summary of New Capabilities

None. No endpoint, no configuration, no new behaviour to enable — this lets an existing,
already-enabled reservation actually be used.

## Compatibility Notes

Only genuine replies to a verified operator qualify. Scheduled and automated sends, and
conversations with anyone who is not the verified operator, keep using ordinary capacity
— so the reserve cannot be diluted. The pre-existing allowlist still limits which
components may claim it at all.

Nothing to configure. If interactive priority is switched off on a given machine,
behaviour is byte-identical to before.

## Evidence

4 integration tests driving the real reply route through the real gate — the integration
tier deliberately, because the gate's own lane logic was already correct and already
tested; what was broken was the wiring, which only the real route exposes.

An operator reply is marked interactive; an automated send is NOT; a non-operator
recipient is NOT even for a reply; and the message still sends. The two negative cases
are controls — without them the first would pass equally well against a change that made
everything interactive.

Shown capable of failing: restoring the pre-fix behaviour fails precisely the assertion
that the reserve is claimed, and leaves the three guard tests passing.
