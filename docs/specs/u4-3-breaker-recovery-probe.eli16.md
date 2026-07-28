# Rope-Health Recovery Probe — Plain-English Overview

> The one-line version: when one of the network "ropes" between my machines dies
> and later heals, the mesh currently never notices the healing — this adds a
> small background probe that re-tests dead ropes on purpose, so a healed
> connection comes back in minutes instead of staying presumed-dead for a week.

## The problem in one breath

My machines talk over multiple transports — Tailscale, local network, Cloudflare —
and the dialing code remembers which ones recently failed. But the way it dials
(race the healthiest rope first, cancel the rest the moment it answers) means a
rope marked dead is never actually re-dialed — and worse, the review found that
even when a recovering rope IS dialed and then cancelled because a sibling won the
race, the cancellation is recorded as another FAILURE. A healed Tailscale
connection stayed presumed-dead for a week because of exactly this.

## What the review process changed

The first draft invented a "circuit breaker" to fix — which doesn't exist in the
code. The real machinery is a per-rope health record with its own recovery rules.
The converged design builds NO second system: it adds a small probe that dials the
specific dead rope directly (bypassing the race), feeds the result into the SAME
health record everything else uses, and fixes the cancellation-counted-as-failure
bug in the dialing code — a fix that also helps the two sibling features.

## What this adds

- Riding the existing five-second mesh tick, the server notices dead or
  half-recovered ropes whose retry time has come and sends ONE small signed test
  message pinned to that exact rope. The test message is the same harmless probe
  the delivery canary uses — the healthy answer is a typed refusal, and nothing
  can ever be injected by it.
- Success feeds the real health record; the rope re-enters normal service under
  the shipped recovery rules. A rope that keeps flapping gets a widening cool-down
  so it can't cycle hot.
- A rope that stays dead is never hammered: after enough failures the probe slows
  to a 15-minute floor and tells you ONCE ("this rope has failed N recovery
  probes; still checking occasionally") — never a stream, never silence, never an
  infinite spin.

## The safeguards

**Zero cost when healthy** — a healthy mesh sends no probes at all. **Can't spam
the peer** — probe responses land in size-capped, rotated logs, and the probe
never routes through the path that could trigger a "sender not recognized" notice
to you. **Honest observability** — each machine's health view (which ropes, what
state, when last probed) becomes readable on its authenticated health endpoint,
which the rope-alerts feature also depends on. **Dry-run first** — on my dev pair
it starts in observe mode (sends probes, logs what it WOULD change, touches
nothing) with its own rate brake so even dry-run stays bounded.

## What ships when

Live-on-dev in dry-run from day one, dark on the fleet; graduation needs a week of
zero false recoveries plus one live verified recovery on the real two-machine
pair. Rollback is one flag — the probe only ever feeds the existing health
records, so turning it off leaves no orphan state.

## What you actually need to decide

Nothing — this fixes the "healed rope stays presumed dead" failure from the July 1
incident with no new authority: it only makes the mesh re-check its own
assumptions. Approval of the converged spec is the only step.
