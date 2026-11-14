# Reaching an agent by more than one road, in plain words

## What this is

Today the Instar iPhone app knows one road to an agent: its Cloudflare web address. If Cloudflare has a bad hour, the app cannot reach the agent at all. Justin's phone and all of his machines are also on Tailscale, a private network only his own devices can join. This change lets the app use either road and switch by itself when one fails.

Remote Desktop gets a second benefit. Today every picture and every tap travels phone → Cloudflare → the Mac Studio → the machine being controlled, and back. With this change the phone talks straight to the machine it is controlling over Tailscale, which removes two hops and should make it feel much less laggy.

## What already exists

- Each phone has its own signing key, and every request it sends is signed. Today that signature is tied to the one web address the phone paired with.
- Machines can already serve their agent over Tailscale with a proper HTTPS certificate (Mama PC does).
- Remote Desktop is already decided on the Studio (where you type your PIN), and the machine being controlled checks the Studio's signed permission slip before letting anyone in.

## What is new

- Each machine works out its own list of names: its Cloudflare address and its Tailscale address. It reads them from its own settings; nothing a request says can add a name.
- A phone's signed request is accepted on any of the machine's own names, and still refused on any other machine's name, so a captured request cannot be replayed somewhere else.
- The app asks for that list once, keeps it, and tries Tailscale first, then Cloudflare.
- For Remote Desktop, after the Studio approves, the phone connects straight to the target machine over Tailscale. The target still checks the Studio's permission slip exactly as before. If the direct road does not answer within two seconds, it falls back to today's route.

## Safeguards

- The machine that decides who may start Remote Desktop does not change, and neither do the checks the target machine makes.
- Each switch can be turned off on its own, which puts everything back exactly as today.

## What needs deciding

Nothing from Justin. The agent sets up the Tailscale addresses on each machine itself.
