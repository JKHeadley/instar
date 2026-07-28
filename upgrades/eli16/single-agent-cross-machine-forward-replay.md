# Cross-machine restart replay fix

One agent can run across two machines. If the machine receiving Telegram messages forwards one to the machine currently running the conversation, both machines must agree which original message was handled.

Previously, the forwarding machine could mark its Telegram position complete before forwarding had settled. The owner also wrote a durable receipt but ignored whether that receipt already existed, falling back to memory that vanished on restart. Now the forward acknowledgment completes first, and the durable original-message receipt decides whether the owner has already accepted it.
