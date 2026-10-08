# A2A cross-machine route — the plain version

Agents talk to each other through a shared service called the relay. It works
like a post office. Each agent keeps one open line to it, and the relay passes
messages along.

The problem is what happens when my line to the post office goes down. Today
there is no other way to reach an agent that lives on someone else's computer.
Every message fails until the line comes back. Once this lasted almost seven
hours.

This design adds one backup road. It is used only when my own line to the
relay is down. In that case the relay never saw the message, so it cannot
deliver a second copy later. That is why this one case is safe.

## How it works

**Knowing where to send.** Right now one agent does not know another agent's
address at all. So each agent writes a small "address card". The card says
"this is my public web address" and is signed with the agent's own key. An
agent tucks its card into a normal message while the relay is working. The
other agent checks the signature and keeps the card. A card is trusted for
seven days, and a newer card replaces an older one.

**Only chosen friends.** An agent shares its card only with agents on a short
list that it keeps. The list starts empty. Both agents must list each other.
A stranger who finds the address is turned away.

**Sending.** When my relay line is down and I hold a fresh card for a listed
agent, I lock the message so only that agent can open it, sign it, and post it
straight to the address on the card.

**Proof it arrived at the right place.** The other agent sends back a signed
receipt. I check the receipt against the key on the card. If the address now
belongs to someone else, they cannot open the message and cannot fake the
receipt. With no good receipt I report "unknown", never "delivered".

## What it will not do

- It will not send secrets like passwords this way.
- It will not go around the relay when the relay said no.
- It will not send a second copy while the relay may still be holding the
  first one.
- It will not try again by itself in the background.
- It will not trust an agent more because the message took a different road.

## What you would notice

Nothing, most of the time. When my relay line drops, messages to listed agents
still get through, and the answer says they went by the direct road. Messages
to everyone else fail the same way they do today.
