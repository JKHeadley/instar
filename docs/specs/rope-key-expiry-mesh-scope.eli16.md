---
title: Stop warning about a device that isn't part of the mesh
slug: rope-key-expiry-mesh-scope
audience: decider
---

# Stop warning about a device that isn't part of the mesh

## The one-sentence version

Your machines watch for a Tailscale key that's about to expire and warn you — but they
were checking *every device on your account*, so one long-dead phone or old laptop with a
lapsed key made the warning permanent and meaningless.

## What this is about

Your machines reach each other over Tailscale, among other routes. Tailscale gives each
device a key that expires periodically; when it lapses, that device drops off the network.
Losing a route that way used to be silent, so a warning was added: if any key is within
two weeks of expiring, say so in the daily mesh summary.

The check asks Tailscale for the status of everything on your account and picks whichever
key expires soonest.

## What went wrong

Your Tailscale account holds more than the machines running agents. It holds phones,
other people's laptops, devices you set up once and forgot. One of them — a node called
"localhost" — went offline on the 13th and its key lapsed.

Because it was the soonest expiry on the whole account, every single check picked it. The
mesh summary said "a Tailscale key expires in 0 days — re-authenticate before it drops the
rope" continuously, for over two weeks, about a device that is not part of the mesh and
whose expiry cannot affect anything.

Worse, it was actively misleading. On 2026-08-29 I read that warning and told you a real
route was at risk and that you'd need to log in. That was wrong — every machine you
actually use had months left. A warning that is always on doesn't just get ignored; it
gets *believed* at the wrong moment.

## What changes

The check now only looks at devices that actually carry mesh traffic — the ones your
machines are configured to reach each other on — plus this machine itself.

Everything else about it is unchanged: same two-week horizon, same wording, same daily
summary.

## The safeguards

Three deliberate choices, all in the direction of never hiding a real warning:

- **This machine always counts.** Its own key lapsing would drop every route it has, so
  it's included whether or not it appears in the list of peer addresses.
- **If the list of mesh addresses can't be read, the check falls back to looking at
  everything** — exactly as it does today. A failure makes it noisier, never quieter.
- **An empty list also falls back to everything.** Otherwise a momentary blank would
  narrow the check down to this machine alone and quietly hide a genuine peer warning.

None of your device names, addresses, or account details leave the part of the code that
reads them — that was already a hard rule here, and it still holds. The addresses are
passed *in* to do the matching; only a yes/no comes back out.

## What you need to decide

Nothing. This is a scoping correction to an existing warning, it cannot suppress a warning
about a machine you actually use, and every failure path makes it behave exactly as it
does today.
