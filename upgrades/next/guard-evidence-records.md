<!-- bump: patch -->

## What Changed

Two load-bearing multi-machine guards that run in dry-run now leave durable
per-run evidence (CMT-1119). The U4.4 lease hand-back reconciler appends to
`logs/lease-handback.jsonl` on every state change and significant event
(would-hand-back, offer, claim, step-down, failure, episode cap, deferral
ceiling), plus at most one heartbeat line an hour while its state is unchanged.
The identity divergence monitor appends one line per completed check to
`logs/identity-divergence-monitor.jsonl` (sources read, identities compared,
active divergences, each new one's raised/dry-run disposition, cleared ones).
Both now register a runtime getter, so `GET /guards` grades them from a real
last-run time instead of `not-instrumented`. Logs rotate at 5 MB. No decision
logic changed.

## What to Tell Your User

Nothing changes in how your agent behaves. Two background safety checks for
agents running on more than one machine now keep a short log each time they
run, so we can confirm they work before switching them fully on.

## Summary of New Capabilities

- The lease hand-back and identity-divergence checks are visible on the safety
  status page with their last run time, and each keeps a log of what it saw and
  what it would have done.

## Evidence

New synthetic tests stage the lease held by a non-preferred machine (records a
dry-run would-hand-back with its episode) and an injected equal-epoch signing
divergence (recorded once with its dry-run disposition, then cleared). Other
tests prove no per-tick noise, an hourly heartbeat on the preferred captain,
nothing written while disabled, a throwing record sink leaving the lease
decision unchanged, bounded rotation, and the server wiring. Writing the test
exposed one ordering bug, fixed here: the would-hand-back, offer, claim,
failure and step-down records now carry the episode they describe.
