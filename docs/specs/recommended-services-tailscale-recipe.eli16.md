# Your agent can set up Tailscale for you (test agents only, for now)

## What this is

Tailscale gives your agent a private address that only your own devices can reach. With it, you can open your agent's pages from your phone anywhere, and an agent that runs on more than one machine gets its strongest link between them. It is one of the recommended services: things your agent can offer and then set up itself, after you say yes.

Each recommended service needs a recipe, which is the set of instructions a setup session follows after your yes, plus a check that decides whether the service really works. Jev from TypeSafe had the first recipe. This change adds the second one, for Tailscale.

## What the setup session does

First it looks whether Tailscale is already installed and signed in. If this machine is already on a tailnet, it changes nothing and tells you it was already working. If Tailscale is missing, it installs it, choosing a way that needs no administrator password where one exists. On Linux it also handles the step that lets your agent's own user manage Tailscale.

Then it starts Tailscale's sign-in and sends you one link. One tap on that link signs this machine in to your Tailscale with your own Google, GitHub or similar login, and makes a free account if you don't have one yet. That tap is the only thing you do. The session never signs in for you with a stored key or a login it already has, because your own tap is what makes it your network. It never signs a machine out, or moves it to another network.

When Tailscale reports the machine is signed in, has a private address and is online, the check passes and the session tells you it works. If it can't finish, nothing breaks: your agent is still reachable the way it is today, through its tunnel, your local network or messages.

## Safeguards

- The check reads Tailscale's own status, and its words never include an address, a device name or an account name.
- If Tailscale doesn't answer in time, the check says "unknown", so nothing starts on a guess.
- This recipe keeps no key, and the route that stores keys refuses one for Tailscale.
- The shared rules still apply: no spending or permissions without your yes, and your yes to Tailscale is not a yes to Tailscale's terms.

## What you need to decide

Nothing. Like Jev's, this recipe only runs on test agents while it is being proven, and your agent offers no services yet.
