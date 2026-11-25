# Permanent agent links, explained simply

## What problem this solves

Right now, a link to something your agent has, like a conversation or a document, contains the agent's internet address. That address belongs to one computer. If that computer is away or its name changes, the link stops working, and an agent on two computers has two addresses. So there's no single link that means "my agent".

Justin asked whether instar.sh could give each agent a permanent link that opens the Instar app on iPhone or Mac. It had to stay optional, keep using the agent's own private Cloudflare or Tailscale network, and be secure.

## The idea

A permanent link says **which agent** and **which page**. It doesn't say **where the agent is**.

`https://instar.sh/a#v=1&i=<agent's identity>&t=conversation&r=<which one>`

- The "agent's identity" is a fingerprint of the agent's own key. An agent that has talked to other agents already has one; once its computers share one identity (they do after the existing identity handover), it's the same on all of them. Nobody can register or squat it the way they could a name. An agent without one simply can't make these links.
- Your app already knows how to reach every agent it's paired with, over Tailscale or the agent's Cloudflare tunnel. So when you tap the link, iPhone or Mac hands it to the Instar app. The app finds the paired agent with that identity and opens the page directly. instar.sh never sees the traffic.
- instar.sh stores nothing. It serves one plain page and the small file that tells Apple "the Instar app may open these links".

## Why it's safe

- **Another agent can't pretend to be yours.** When the app first learns an agent's identity, it sends a random challenge. The agent has to sign it with its private key, and the signature is tied to this phone and this address. A second agent you've paired with can copy the public fingerprint but can't produce that signature. And if an agent's identity ever changes, the app doesn't quietly accept the new one: it stops using that pairing for links until its original identity comes back or you pair again.
- **A link can only take you to a page.** It can't approve, send, share, or change anything. Opening a conversation from a link doesn't even send messages that were waiting to go out. A link never jumps over the lock screen or pops up an approval card.
- **Access doesn't change.** If an owner sends a link to a team member, the member sees only what they were already allowed to see.
- **instar.sh holds no addresses and doesn't forward anyone.** A plain browser gets a page with an "Open in Instar" button and nothing else, so it can't be used as a trusted-looking forwarder by phishers.
- **Honest privacy note:** the part after `#` isn't sent to instar.sh when the page loads. But anyone who has the whole link, and the apps that handle it, can read which agent and which page it names. The link holds no password or access.

## Optional

It's off unless the agent turns it on (`agentLinks.enabled`). An agent that never turns it on works exactly as today. If instar.sh ever disappeared, you could still paste the link into the app, or use the `instar://a#...` form, which needs no website.

## What gets built

1. The agent: a signed "this is my identity" answer for paired apps, and a way for the agent to make these links. Off by default.
2. instar.sh: the `/a` page and Apple's link file updated for iPhone and Mac. The existing `/doc` page has a problem of its own (its script never runs, and fixing it would turn instar.sh into a forwarder to whatever address a link names), so it gets its own separate change.
3. The iPhone and Mac apps: learn and check each agent's identity, open `/a` links to the right page, and refuse links for agents you aren't paired with.
4. Proof on Echo: a real link opening the right page on Justin's iPhone and Mac, and the safe page in a browser.

Windows and Android follow later with the same link format.
