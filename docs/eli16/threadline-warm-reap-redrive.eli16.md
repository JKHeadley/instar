# Warm Threadline reap recovery — Plain-English Overview

When another agent sends a message, Instar can keep a conversation session warm so replies are fast. Under severe quota pressure, the system may shut that session down while it is still composing. The incoming message was written to the canonical Threadline inbox, but that inbox was only a record; the normal restart queue rejected warm agent-to-agent sessions because they have neither a Telegram topic nor a scheduled-job name. The reply could therefore disappear.

The restart queue now carries the Threadline conversation ID and the exact durable inbound message ID. Threadline replies record that exact inbound ID, so a reply to an earlier message cannot accidentally settle a newer interleaved message. The message becomes restart-eligible only when the authenticated canonical inbox proves it arrived and no authenticated outbound explicitly answers it. Once machine pressure and quota gates clear, the queue rechecks those facts and hands the exact message back to the existing Threadline router.

This reuses the established queue's durability, pressure gates, retry ladder, and resurrection cap. It does not create a second background recovery system. If the original worker managed to send before it died, its correlated outbound record prevents a duplicate reply.
