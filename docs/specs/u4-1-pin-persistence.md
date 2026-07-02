---
title: "U4.1 — Pin Persistence Across Lease Handover (a deliberate placement must survive a handoff)"
slug: "u4-1-pin-persistence"
author: "echo"
status: "draft"
parent-principle: "Verify the State, Not Its Symbol — a pin is durable operator intent, not transient in-memory placement"
sibling-principles: "The User Experience Is the Product; Cross-Store Coherence Is an Invariant; Know Your Principal"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "GET /pool/placement (reason pinned|placed); coherence journal (replicated); topic transfer (POST /pool/transfer)"
---

# U4.1 — Pin Persistence Across Lease Handover

## 1. Problem

When the operator deliberately pins/moves a topic to a machine ("run this on the
mini" → `GET /pool/placement` reason `pinned`), that pin can silently EVAPORATE after
a lease move or a machine bounce, reverting to load-balanced placement. Recorded in
the `mesh-captain-flip-playbook` memory: "pins can evaporate — re-check placement."
The operator who chose a machine finds their topic elsewhere after a handoff, with no
notice — a direct violation of "the user shouldn't have to think about which machine
runs the agent" (they made a choice; the mesh forgot it).

Root cause: the pin lives in transient placement state that a handover/rebuild does
not replay.

## 2. Design

**Make a pin a DURABLE, replicated intent that a new captain REPLAYS before
load-balancing.**

- **Durable record:** `{topicId, pinnedMachineId, pinnedAt, pinnedBy}` persisted to
  the coherence-journalled placement store (already replicated across machines), so
  it survives a lease move, a server restart, and a machine bounce. `pinnedBy`
  records the VERIFIED operator (Know Your Principal — a pin is operator intent, never
  set from message content).
- **Replay on handover:** when a machine becomes the placement router (lease move or
  boot), it REPLAYS outstanding pins BEFORE running load-balanced placement — a pinned
  topic goes to its pinned machine, not the least-loaded one.
- **Honest pending state:** a pin to a machine that is currently OFFLINE holds as
  `pending-pin` (surfaced on `GET /pool/placement` as `reason: pinned, pinState:
  pending, pinnedMachine: <nickname> (offline)`) rather than silently reverting to
  load-balanced. When the pinned machine returns, the topic moves to it.
- **Safety — a pin is intent, not an override of hard constraints:** a pin overrides
  LOAD-BALANCING but NOT a quota-block (a pinned machine that is rate-limited surfaces
  `pinned-machine-quota-blocked` and the topic runs elsewhere until the pinned machine
  has quota — exactly today's behavior for a live pin) and NOT the autonomous-run
  consent gate on transfer (moving a topic with a live autonomous run still asks
  first, per the existing 409 needsConfirmation).
- **Read surface:** `GET /pool/placement` gains `pinSource: durable|inferred` and
  `pinHeldSince`, so "why is this here?" is answerable after a handover, not guessed.

## 3. Multi-machine posture (mandatory)

The pin record is REPLICATED (it rides the existing coherence journal / placement
replication) — a pin set on machine A is honored by machine B when B becomes router.
This is the whole point: the pin must survive crossing a machine boundary. Concurrent
pins to the same topic during a partition resolve by the journal's existing
last-writer/`pinnedAt` rule (a pin is low-conflict operator intent; the most recent
verified-operator pin wins, and a divergence is surfaced, never silently dropped —
consistent with the One-Memory conflict model). Single-machine install = the pin is
trivially always honored (one machine).

## 4. Tests

- `pin-survives-lease-move` (pin on A → lease moves to B → B replays it → topic stays
  on A).
- `pin-survives-machine-bounce` (restart the pinned machine → pin still honored).
- `pin-to-offline-machine-holds-pending-not-reverts`.
- `pin-yields-to-quota-block` (pinned machine rate-limited → runs elsewhere, flagged).
- `pin-does-not-bypass-autonomous-run-consent`.
- `pinnedBy-is-the-verified-operator-never-content` (KYP).
- Multi-machine: `pin-set-on-A-honored-by-B-as-router`; `concurrent-partition-pins-resolve-by-pinnedAt-and-surface-divergence`.

## 5. Rollback / rollout

Ships dark → dry-run (logs "would replay pin" without changing placement) → dev-agent
→ fleet, gated by `multiMachine.sessionPool.pinPersistence`. Rollback = drop the flag;
pins revert to transient (today). Reuses the coherence journal + placement store — no
new store.

## Frontloaded Decisions

1. **Durable + replicated, not transient** — the evaporation IS the bug; a pin must
   cross machine boundaries.
2. **Offline pinned machine → pending-pin, not silent revert** — honesty over a
   surprising placement.
3. **Pin overrides load-balancing but not quota/consent gates** — a pin is a
   preference within safety constraints, not a hard override.
4. **pinnedBy = verified operator only** (Know Your Principal).

## Open questions

None.
