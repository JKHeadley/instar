# App message signatures over Tailscale (plain-English overview)

Every message you type in the Instar iPhone app is signed by a key that lives only in your phone. The agent checks that signature and shows a small mark: verified means it really came from your phone.

The signature also covers the address your phone sent the message to. When you pair, the phone uses one address (for example the agent's Cloudflare address). Afterwards the app prefers a faster route when it can, such as the machine's Tailscale address. The check only accepted the address you paired on, so on the first cloud agent every message after the first showed "signature failed", even though nothing was wrong.

Now, a message sent to another of the agent's own addresses counts as verified when the agent's machine also signed a receipt for it. The machine only signs that receipt for a request it accepted on one of its own known addresses, so a message sent anywhere else still fails. If the receipt can't be checked yet on a machine, the mark says "couldn't check" instead of failed.

Nothing else about the check changes, and nothing is blocked by it: it is only the mark you see next to your messages.
