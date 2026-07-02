# Lease Hand-Back to the Preferred Captain — Plain-English Overview

> The one-line version: when your always-on Mac Mini recovers after a failover
> moved "who's in charge" to the sleep-prone Laptop, the in-charge role now walks
> itself back to the Mini — carefully, at a quiet moment, and never against a
> deliberate choice you made.

## The problem in one breath

You already told the mesh the Mini is the preferred captain, but that preference
only stops the Laptop from GRABBING the role while the Mini is healthy — nothing
ever hands the role BACK after a failover. So the mesh drifts onto the wrong
long-term machine until a human runs the manual flip playbook. That's the exact
class of manual surgery this project exists to eliminate.

## What the review process changed

The first draft invented a second "preferred machine" setting stored in replicated
data — killed twice over: a competing copy of an authority that already exists in
config, and an unsigned field a misbehaving peer could forge to redirect the role
to itself. The converged design is the missing RECONCILER for the EXISTING
preference setting — no new authority anywhere. Review also caught the worst bug a
healer could have: the draft's hand-off ordering could leave ZERO machines in
charge (nobody polling Telegram — the silent-loss class, caused by the fix
itself). The final ordering makes that impossible: the Mini claims the role FIRST
with a one-time, signed, expiring consent token the current holder issued; the
Laptop steps down only after seeing the claim land; if the claim never lands, the
Laptop just keeps holding.

## What this adds

- The current holder watches the preferred captain's health on the existing mesh
  tick; only after ten continuous healthy minutes does a hand-back arm.
- It fires at a quiet moment (no in-flight messages), with any queued messages
  drained across first; a busy stretch defers it, but never forever — after two
  hours you get one notice and it takes the next safe opening.
- **You always win:** a deliberate manual flip writes a suppression latch — the
  automation goes fully inert for a day (visible in status) rather than fighting
  your choice ten minutes later.
- Bounded everywhere: at most two hand-backs per six hours (then it goes sticky
  and tells you once), hand-backs count toward the existing flip breaker, a
  refused or unanswered offer backs off instead of looping, and everything is
  suppressed during a split-brain.
- After a hand-back, a real end-to-end delivery test verifies the Mini is
  actually answering — a failed verification escalates loudly, never silently.

## The safeguards

The consent token is single-use, time-boxed, and bound to the exact lease epoch —
it cannot be replayed or reused. An older-version peer that doesn't understand the
offer refuses it safely and the holder simply keeps holding. The feature ships
hard-dark like its sibling lease-authority features and cannot leave observe mode
until a live two-machine drive proves the whole cycle — failover, recovery,
hand-back, verified ingress — on the real pair. Requires the poller-follows-lease
automation to be live first (otherwise the role would move while Telegram polling
stayed behind — refused loudly at the config gate, never assumed).

## What you actually need to decide

Nothing — the preference knob already exists and stays yours; unset means today's
sticky behavior. Approval of the converged spec is the only step.
