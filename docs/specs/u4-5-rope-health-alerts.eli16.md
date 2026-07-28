# Rope-Health Alerts — Plain-English Overview

> The one-line version: when the connections between my machines degrade — a
> Tailscale key about to expire, one rope down, or a genuine partition brewing —
> you hear about it calmly and ONCE, before it becomes a lease incident; and your
> laptop going to sleep never triggers a false alarm.

## The problem in one breath

Transport degradation is silent today. A Tailscale key expiry drops a rope with no
warning; the Cloudflare flap that caused the July 1 lease instability was visible
only to someone who went looking; and an all-transports-down partition — the
precondition for silent message loss — has no prompt alert at all.

## What the review process changed

The first draft bolted alerts onto a once-daily audit script that lives outside
the product — which structurally could not deliver a prompt partition alert,
couldn't remember state between runs, and wasn't shippable to other agents. The
converged design is a real in-server monitor with its own small durable memory.
The review's sharpest catch: the signal the draft used to tell "laptop asleep"
from "genuine partition" does not exist in the code — so the final design uses one
that does: the slow heartbeat each machine writes through a channel independent of
the mesh ropes. If that heartbeat keeps advancing while every rope is down, the
peer is ALIVE but unreachable — a real partition, urgent. If the heartbeat stopped
too, the peer is almost certainly asleep or off — noted in the daily digest, never
an alarm. A lid-close can no longer page you.

## What this adds

- Three calm tiers: healthy is silent; a degraded rope (one down, others up) or a
  key expiring within 14 days becomes one line in the existing daily digest; only
  a verified partition to a machine that should be online raises ONE attention
  item per episode.
- Flap-proof: an episode needs sustained confirmation to open and ten quiet
  minutes to close — a blip can neither fire nor clear-then-refire. During a true
  two-sided partition each machine can raise at most one item (they can't
  coordinate through a mesh that's down — stated honestly), grouped after healing.
- Alert text carries only the rope kind, machine nickname, and relative expiry —
  never raw addresses, hostnames, or account details.
- Everything ships in the product with proper migrations: the monitor, an
  authenticated read endpoint, and a daily digest job — the hand-deployed audit
  script becomes a consumer, not the mechanism.

## The safeguards

Depends on the recovery-probe feature's health snapshot (built first — no made-up
fallback data source). Key expiry is checked by a bounded, hourly, timeout-capped
read of the Tailscale CLI; if the CLI isn't installed that tier is simply absent.
If alert delivery itself fails, the failure is remembered and retried — detected
problems cannot be lost silently. The urgent tier's right to auto-raise attention
items is argued explicitly in the rollout registry (episode-deduped, sleep-gated,
operator-mandated) rather than smuggled in.

## What you actually need to decide

Nothing — the alert destination is a config knob you already control (unset means
log-only), and the monitor starts observe-first on the dev pair. Approval of the
converged spec is the only step.
