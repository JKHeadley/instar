# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Multi-Machine Session Pool gains its activation wiring (still DARK): the SessionRouter
is constructed at boot and consulted on the inbound message path, and a forwarded message
now resumes the session on the owner machine — but ALL of this is gated on the rollout stage
being advanced past 'dark'. A single-machine, un-activated agent behaves exactly as before:
the interception is gated off on three independent conditions (no router without machine
identity, stage defaults dark, fail-safe to local dispatch).

## What to Tell Your User

Nothing changes yet — this is the plumbing that lets the session pool actually move
conversations between machines once it's staged on. It stays off until explicitly activated.

## Summary of New Capabilities

| Area | Capability |
| --- | --- |
| Multi-machine | Inbound dispatch can route a topic's message to the machine that owns the session, and the owner resumes it (gated; dark by default). |

## Evidence

- `tests/unit/session-pool-activation-wiring.test.ts` pins the safety invariants: gated on a
  non-dark stage, fail-safe to local dispatch, real-deps construction, owner-side resume bridge.
