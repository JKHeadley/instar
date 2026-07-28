# Plain-English Overview — Robust Multi-Transport Mesh Communication

## What this is

When the agent runs on two machines (the stationary Mac Mini and the travelling
Laptop), the machines constantly need to talk to each other — mainly to agree on
"who is in charge right now." Today they have exactly **one** way to reach each
other: a Cloudflare tunnel (a public internet relay). Cloudflare keeps dropping
that connection for a few seconds at a time, and every time it drops, the Mini
panics that it lost the Laptop and nervously re-grabs the "I'm in charge" badge —
about once every two minutes, forever. It's currently harmless (nothing else is
fighting for the badge), but it's fragile: with worse timing it can leave the
Mini stranded.

The real problem isn't the badge logic — it's that the machines have **one rope**
between them, and it's the flimsiest rope available.

## What already exists

- One rope: the Cloudflare tunnel (flaky).
- The machines are usually **on the same wifi** right now, but they don't use it.
- A much sturdier option — **Tailscale**, a private network that gives each
  machine a fixed address that follows the Laptop anywhere — isn't installed yet.

## What's new

Give the machines **several ropes** and let them automatically use whichever one
is working:

1. **Tailscale** (sturdiest, travels with the Laptop) — needs a one-time ~5-minute
   install by the operator on both machines.
2. **Local network** (fastest when both are on the same wifi) — zero setup, the
   agent discovers it by itself.
3. **Cloudflare tunnel** (kept, but demoted to last-resort).

Each machine announces all the addresses it can be reached at; the other machine
tries them best-first and only says "I can't reach you" when **every** rope
fails. The instant Cloudflare drops, traffic silently slides to the local-network
or Tailscale rope — and the two-minute panic-flap simply stops, with no change to
the "who's in charge" rules at all.

## The safety net (last layer)

Even with three ropes, a machine that's fully asleep or off every network is
still unreachable. For that case, the **stationary** Mini is allowed to keep its
"in charge" badge by itself (instead of thrashing) — but ONLY when the other
machine has gone *silent past a real timeout* (genuinely absent, not merely
unreachable for a moment), only the machine you designate as the stationary
captain, and always behind the existing cryptographic "who's-really-in-charge"
lock. That last part is what makes it safe: even if the Mini wrongly assumes a
still-alive Laptop is gone, it never advances the lock or takes the badge away
from anyone — so two machines can never both end up acting as "in charge." A
travelling machine always steps down if it loses contact, so it can never wrongly
hold the badge. This safety net is proven by physically unplugging the Laptop on
the real pair before it's ever switched on.

## The safeguards, in plain terms

- **Nothing becomes less secure.** Every rope uses the exact same cryptographic
  machine-to-machine authentication; a local or Tailscale rope is not a backdoor.
- **The sturdy ropes ship turned ON** because they're purely additive — they just
  add more ways to connect, with Cloudflare still in the mix. If anything
  misbehaves, one config switch returns to today's single-rope behavior.
- **The "hold the badge alone" safety net ships turned OFF** by default (it's the
  only part that changes a real decision), and even when on it only applies to the
  designated stationary machine.
- **A single machine is completely unaffected** — every part of this is a no-op
  with nobody to talk to.

## What you actually need to decide

1. Whether to install Tailscale on both machines now (the strongest rope) — and
   whether you'd rather install the app yourself or hand the agent a one-time
   setup key to automate the wiring.
2. Whether you want SSH as a fourth rope. The recommendation is **no** — Tailscale
   already covers everything SSH would, more reliably — but it's your call.

Everything else (the local-network rope, the failover logic, the safety net) is
built and reviewed by the agent and brought back to you to approve before it
ships.
