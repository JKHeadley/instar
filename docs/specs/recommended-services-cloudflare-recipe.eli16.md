# Your agent can give itself a fixed address on your domain (test agents only, for now)

## What this is

Today an agent's public address is temporary: Cloudflare hands it a random one, and it changes on every restart, so links to its dashboard and app stop working. "Cloudflare with your own domain" is one of the recommended services: a fixed address, such as agent.your-domain.com, that always reaches your agent. Until now setting it up meant doing the Cloudflare work by hand. This change gives the service a setup recipe, so after your yes the agent does all of it. Like the other recipes before their live proof, it runs only on test agents until it has been proven for real.

## What the setup session does

First it asks whose Cloudflare account to use, and presents both choices as good:

1. **Your own account, with a domain already on it.** The agent signs in there in a normal browser with your password and any sign-in code, each through a one-time private link, makes a limited key for this one job, stores it, and signs out. You never open Cloudflare.
2. **An account of its own, with a new domain.** A domain costs money, usually about ten dollars a year, so the agent tells you the exact price first and buys nothing until you say yes, then takes your card through the same kind of private link.

It also asks which name you want (it suggests agent.<your domain>). Then the server does the Cloudflare work itself: it finds your domain, makes a tunnel named after the agent, points the tunnel at the agent, points the name at the tunnel, writes the new address into the agent's own settings and asks for a planned restart. After the restart, the check passes once the agent answers at the new name from the public internet, and the agent tells you the address.

## If you say no later

The agent puts its settings back the way they were (the temporary address returns), removes the name it made from Cloudflare, and forgets the key. The tunnel it made usually stays in your Cloudflare account, unused and free, because Cloudflare won't delete a tunnel while the agent is still connected to it; a later yes reuses it, and you can remove it from your Cloudflare dashboard any time. Your account and domain stay yours. Because the address may be your only way of reaching the agent, the switch-off waits, and says so, until another way in works.

## Safeguards

- The key is never printed, logged or put in a command or a web address: it travels only in a header to Cloudflare, and the session hands it to its own server through one call.
- A value the server could not use (a bare key, or a name it can't work with) is refused on the spot and never stored.
- A fixed address you already had is never replaced: if one is working, the agent says so and changes nothing.
- Only what setup made is undone: a tunnel that was already in your account is never deleted.
- The check says "unknown" when Cloudflare or the network does not answer, so nothing claims to work on a guess.
- The recipe is dark: available only to a test agent that lists it, until the live proof.

## What you need to decide

Nothing yet. The live proof needs one decision, asked separately: a domain of yours I may use for a test name, or a yes to a test domain of about ten dollars.
