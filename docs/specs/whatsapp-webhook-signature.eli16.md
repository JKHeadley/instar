# WhatsApp Business messages must be signed (ELI16)

When someone messages the agent over WhatsApp Business, Meta forwards the message to the agent's public web address. That address cannot ask for the agent's password, because Meta does not have it. So until now, anyone who found the address could send in a fake message and claim it came from any phone number, even the owner's. The agent would believe it.

Meta solves this with a shared secret, the App Secret. It stamps every real delivery with a signature made from that secret and the exact message. The agent now checks that stamp and throws away anything without a correct one. If the App Secret was never set, the agent refuses all WhatsApp Business messages and says why, instead of trusting them. WhatsApp through the normal app (the Baileys backend) works as before.
