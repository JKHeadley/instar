# Helper sessions an agent starts can go to a machine with room

<!-- bump: patch -->

## What Changed

Before this, every session an agent started itself (`POST /sessions/spawn`) began on the machine that received the call. Only a person's new conversation was placed by load. On a pool where one machine does most of the work, that machine filled up while the others sat idle.

Now, on development agents (off on the fleet until reviewed):

- Every agent-started spawn writes one line to `logs/agent-session-placement.jsonl` saying where it would have gone and why. The line has no prompt text, and the spawn itself is unchanged. This measures how much load could move.
- A topicless helper can ask with `"placement": "auto"`. It stays on this machine while there is room. When this machine is busy, the helper starts on a peer with room through that peer's own `/sessions/spawn`. Busy means its own verdict is saturated or impaired, it is short of memory, or its load is at or above 1.0 per core. A peer that is short of memory never receives one.
- A durable record (`state/agent-session-placements.json`) is written before each hand-off, so a slow or lost answer never starts a second copy. A name with an unresolved placement is read-only. A timed-out hand-off answers `202 unconfirmed` and does not start the helper here. The pool tick keeps checking, and one attention item is raised if the start can't be confirmed.
- `GET /sessions/<name>/output` reads a placed helper from its machine. A kill answers `409 placed-on-peer`.
- Spawns forwarded by `/pool/heavy-work/spawn` now carry `X-Instar-Placed: 1`, so they are never placed a second time.

Switch: `multiMachine.placement.agentSessions.enabled` (omitted = on for a development agent, off on the fleet; a restart applies a change).

## What to Tell Your User

- **Helpers spread out**: "When this machine is busy or short of memory, helper sessions I start can run on one of your other machines that has room, instead of piling onto this one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Where agent-started sessions would go | `logs/agent-session-placement.jsonl` |
| Place a topicless helper by load | `POST /sessions/spawn` with `"placement": "auto"` |

## Evidence

- Unit: `tests/unit/agent-session-placement.test.ts` 35 passed: busy by load, verdict and memory; memory-short and quota-blocked peers excluded; burst spreading; store restart, corrupt file and capacity; every live outcome; same-name serialization; reconciler states.
- Related suites: awareness registry, dev-gated wiring, coherence manifest, PlacementExecutor (416 passed); no-silent-fallbacks and no-empty-catch ratchets at baseline; dev-agent dark-gate lint clean.
- Integration (`tests/integration/agent-session-placement-routes.test.ts`) and e2e alive (`tests/e2e/agent-session-placement-alive.test.ts`): run by Local Verify (no local integration/e2e lane on the verify machines).
