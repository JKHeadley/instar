# Token-burn alerts stop retrying deleted topics

## What Changed

When Telegram says the configured token-burn alert topic no longer exists, the
agent now records that destination as permanently unavailable and stops sending
to it across restarts. The failed alert is preserved in the existing Attention
queue, and later burn alerts use that self-healing route. Changing the configured
topic clears the practical quarantine because the new destination is tried
normally.

## Evidence

The unit fixture uses Telegram's real `400 Bad Request: message thread not found`
response. It proves one failed attempt, a durable terminal record, restart-safe
suppression of the dead destination, stable Attention deduplication, transient
failure retryability, and recovery when the configured topic changes.

## What to Tell Your User

A deleted alert topic can no longer create a silent hourly retry loop. The agent
stops using it and leaves one durable, visible explanation with the original
alert attached.

## Summary of New Capabilities

- Permanently missing burn-alert topics reach a durable terminal state.
- Failed warnings reroute through the existing self-healing Attention hub.
- Restarts do not reopen the dead-topic retry loop.
- A newly configured destination is tried normally.
