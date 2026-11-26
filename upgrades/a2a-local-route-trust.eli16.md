# Checking who is sending on the same-computer route (ELI16)

Agents can message each other in two ways. One goes through a shared relay on the internet. The other is a shortcut used when both agents run on the same computer: one hands the message straight to the other's server.

The relay way checks who is sending. Each agent keeps a list of the other agents it trusts and how much. If a message comes over the relay from an agent that is not on the list, it is turned away. That agent may only "ping" to see if anyone is there.

The shortcut never checked the list. It treated every sender as a known, trusted-enough agent. So an agent that would be turned away over the relay could get its message in by using the shortcut. That is the hole this change closes: the shortcut now looks the sender up in the same list and applies the same rule.

There is a catch, and it decides how this ships. I looked at the agents on the development computer. Most of them have no list entry for the agents they talk to over the shortcut every day, because nothing ever asked for one. If the new check started turning messages away right now, those working conversations would stop.

So the check starts in watch-only mode. It looks every sender up, delivers every message exactly as before, and writes down each message it would have turned away, with a running count on the agent's private health page. Nothing is refused until someone deliberately switches watch-only mode off. Before doing that, they read the count and add the legitimate senders to the list.

When watch-only mode is off, a sender that is not allowed gets a clear refusal straight away, before the message is recorded anywhere. The sending agent then tries the relay, as it already does when the shortcut fails. The relay judges the message again by its own rules, using an identity it has actually proven, and it may let the message in. So switching the check on does not promise that such a message never arrives. It promises the message does not arrive by a route that cannot prove who sent it. The refusal is never reported as a delivery.

One thing I found while testing: the relay is not fully strict either. An agent the relay has never seen before skips the relay's trust check on first contact and is treated as known from then on. This change leaves that alone and records it for a separate decision.

Two limits, stated plainly. First, the shortcut still cannot prove who the sender is. It only knows the sender could read a file on this computer, and it takes the sender's name from the message. This change makes both ways use the same rule; it does not make the shortcut as strong as the relay's signed messages. Second, some agents have no trust list at all, because their relay is switched off or another machine holds their relay connection. For those the check does nothing, and says so in the count, because turning every message away would cut them off completely.

**What ships now.** The check is on for development agents only, in watch-only mode. It stays off for everyone else until the development agent's count shows what would break.

**What needs deciding later.** Whether to switch watch-only mode off on the development agent, after reading two days of counts. Turning it on for everyone needs a way for agents on the same computer to get on each other's lists without someone adding each pair by hand; that is recorded on the tracking item for this work.

**Status.** Approved for building under the operator's standing approval for the agent-to-agent communications track (2026-10-06).
