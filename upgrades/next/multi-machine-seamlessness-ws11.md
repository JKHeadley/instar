# Upgrade Guide — Dispatch-to-owner hardening: no twins, no theft, capability-gated forwards

<!-- bump: patch -->

## What Changed

WS1.1 of the converged multi-machine-seamlessness spec — the pieces the durable-queue
merge (#1079, which already shipped the receiver half) did not cover:

- **Drain spawn-boundary ownership re-check**: ownership moving between route()'s
  verdict and the spawn produced the F20 double-spawn; a non-owner spawn now bounces
  to `un-routable ('ownership-moved-before-spawn')` and re-queues for re-routing.
- **`MachineCapacity.seamlessnessFlags`** (spec invariant 5): bounded fixed-size
  capability advertisement (`ws11DeliverReceive`) on the authenticated heartbeat,
  live-only (a dark queue withdraws it next heartbeat). Absent = non-participant.
- **Sender-side skew gate** (`SessionRouter.ownerSupportsForward`): a live owner not
  advertising durable receive is never forwarded to — the 501→retry→failover path
  would STEAL the conversation from a healthy machine. Messages wait in the durable
  queue, self-healing on the owner's upgrade. Unknown/absent → exactly today's
  behavior.

Inert without the pool/queue layer (ships dark). Phase-C clean: fixed-size
advertisement, O(1) local reads, no LAN or interactive assumptions.

## What to Tell Your User

- "When my conversations move between machines, three new guards make the handoff
  airtight: no duplicate sessions from mid-move races, machines only receive
  forwarded messages they can durably accept, and a machine that's merely behind on
  updates never gets its conversations taken away — messages just wait safely until
  it catches up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Capability-gated cross-machine delivery | Automatic within the multi-machine layer (dark until enabled) |

## Evidence

- `tests/unit/SessionRouter.test.ts` +4: the skew gate's full decision table (true →
  forward; false → queue, NO deliver, NO cas-steal; null/absent → back-compat).
- `tests/unit/ws11-dispatch-to-owner-wiring.test.ts` — 6: flags heartbeat roundtrip
  incl. live-only withdrawal; the drain re-check seam + its exact placement (after
  direct-inject, before spawn) pinned by source indices.
- 163 tests green across the queue/router/handler suites; tsc clean; build green.
- Independent second-pass audit (mandatory — dispatch + ownership surface): CONCUR,
  6 verification notes, zero concerns — including proof the gate cannot lose a
  message (refused-queue falls through to delivery, never a drop) and never marks a
  flag-gated owner suspect. `upgrades/side-effects/multi-machine-seamlessness-ws11.md`.
