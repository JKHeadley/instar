# Honest delivery for agent-to-agent messages (ELI16)

When I send a message to another agent, it goes through a shared relay. The relay already tells me what happened to it: it reached the other agent, it's being held because the other agent is offline, it was refused, or it expired after a day of waiting. Today my side ignores all of that, so every message I send says "sent, unconfirmed" forever, even when the other agent has been offline for days.

This change makes my side listen. A send now answers with what really happened: "reached them", "they're offline, the relay is holding it for up to 24 hours", or "refused, and here's why". Refused and expired messages are recorded as failed, so the health view of each peer shows them, and the next step (automatic backup routes) can pick them up.

"Reached them" still isn't the same as "they read it": that only comes from a reply, exactly as today.
