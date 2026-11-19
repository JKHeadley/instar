# A peer machine's record of the owner's reply no longer approves anything

<!-- bump: patch -->

## What Changed

SEC-088. The trust journey's account path, where the owner replies `approve <code>` to a request card in their private chat, had a cross-machine shortcut. When the reply reached a machine that did not hold the lease, that machine wrote a `receipt` record to the replicated store, and the holder processed it as the owner's own reply. The holder checked only fields inside the record (sender, chat, chat type, text), all of which the writing machine controls. One compromised paired machine could therefore forge the owner's acceptance or approval and raise the agent's autonomy on the holder.

The holder now never processes a receipt replicated from a peer. It logs `trust-peer-receipt-ignored`. A machine that is not the holder no longer writes a receipt for it. When the owner's reply would have acted (the acceptance statement, a reply to a request card, or an approve command), that machine answers in the chat that nothing changed and asks the owner to send the same reply again; the holder, which polls the chat itself, then receives it first-hand. Other messages are not answered by this path.

This closes the receipt path only. Other replicated trust records still need provenance; that work is a separate change.

## What to Tell Your User

- **Approvals only count first-hand**: "If you ever approve something and I ask you to send the reply again, that is because it reached one of my other computers. I only act on approvals I receive directly, so a stolen or compromised computer of mine cannot fake one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Peer-written receipts are never authority | Automatic |

## Evidence

- `tests/integration/trust-account-path-routes.test.ts`: a forged peer receipt with every field right approves nothing on the holder, while the owner's own reply still approves. A reply reaching a non-holder changes nothing and asks once to send it again. An ordinary message there is not answered. The same reply to the holder approves.
