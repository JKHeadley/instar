# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Agents are no longer assigned a network port that the multi-machine mesh secretly can't reach.

The mesh talks between machines using Node's built-in web-request function, which refuses a short standard list of "bad ports" (for example 4045, the old file-lock service port). That list includes a port inside the default range agents were picked from — so an agent could be handed a port on which it would silently fail to pair or fail over, with no error in normal tools. The port picker now skips those bad ports, and any agent already running on one prints a clear startup warning telling you to change its port.

## What to Tell Your User

Nothing to do for new agents — they'll automatically avoid the handful of reserved ports that break multi-machine networking. If you run multiple machines and one happens to be on a bad port, the agent now warns you at startup with the exact fix (change its port and restart). This removes a silent, very-hard-to-spot failure where an agent looked healthy but could never join the mesh.

## Summary of New Capabilities

- The agent port allocator skips WHATWG fetch "bad ports" (4045, 6000, 6566, 6697, …), so a new agent never lands on a port the mesh's node-fetch comms can't reach.
- A new exported helper, isFetchBlockedPort, plus an unconditional server-startup warning when an existing agent's configured port is on that list (the migration path for already-running agents).

## Evidence

- Root cause of a real 2026-06-02 failure: a paired test agent on port 4045 could never be joined ("fetch failed: bad port") even though curl reached its pairing endpoint; moving it off 4045 fixed the join immediately.
- `tsc --noEmit` clean; 34 agent-registry unit tests green, including 3 new ones covering the blocklist helper (both sides of the boundary) and the allocator skipping a blocked port. Side-effects review: upgrades/side-effects/fix-fetch-blocked-ports.md.
