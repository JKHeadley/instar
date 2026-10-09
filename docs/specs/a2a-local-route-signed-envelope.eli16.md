# Proving who sent a message on the same-computer route (ELI16)

Agents can message each other in two ways. One goes through a shared relay on the internet. The other is a shortcut used when both agents run on the same computer: one hands the message straight to the other's server.

The relay way proves who is sending. Every message carries a digital signature made with the sender's private key, and the receiver checks it against the sender's public key before reading the message. A forged or altered message fails the check and is thrown away.

The shortcut never proved anything. The sender wrote its own name into the message, and the receiver believed it. The only thing the receiver checked was a password-like token that any program on the same computer could read. An earlier change made the shortcut look the sender's name up in a trust list, but it still took the name on faith. That earlier change said so plainly and pointed at this one.

This change closes that gap. Every message on the shortcut now carries the same kind of signature the relay uses. The receiver looks up the sender's name in its own list of agents it has met (the list its discovery tool fills in, which records each agent's public key) and checks the signature against the key it has on record for that name. If the message has no signature, the signature does not match, the name is not on the list, or the message claims a fingerprint that is not the one on record, the receiver refuses it with a clear, typed answer that says which check failed. A refused message is never recorded anywhere: no inbox entry, no history row, no attribution to a conversation.

Both programs that use the shortcut now sign what they send, using the identity key each agent already has. An older receiver that does not know about the signature simply ignores it, so agents can update in any order.

There is no switch to turn this off. A safety check with an off switch is not a safety check, and another agent's own backup route has been waiting for this proof to exist before it is turned on. Two things this costs, said plainly. First, while the agents on one computer are at different versions during an update, an updated receiver refuses an older sender's unsigned messages; those messages go over the relay instead, or wait in a drop folder the receiver empties when it starts. Second, a receiver that has never run its discovery tool against a sender does not have that sender's key on record, and refuses it as "unknown sender" until discovery runs. Both cases show up by name in the receiver's log and on its health page.

Three limits, also said plainly. The check does not stop a program running as the same user on the same computer, because such a program can read every agent's private key anyway. It does not yet put the proven sender into the same history list the relay uses, so a copy of one message arriving by both routes is still labelled rather than merged; that is now possible and is recorded as a follow-up. And it does not check that the message was addressed to this agent, only that it came from who it says.

**What ships now.** The signature check on the shortcut, live for everyone, with counters on each agent's private health page.

**What needs deciding later.** Whether to merge the proven local sender into the relay's history list, and whether to add a time bound on signed messages if a replay is ever measured.

**Status.** Approved for building under the operator's directive for this commitment (Justin, Telegram topic 9210, 2026-10-09).
