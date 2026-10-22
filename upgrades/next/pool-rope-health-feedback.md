## What Changed

- **A route to another machine that stops working now demotes itself.** The previous change (shipped in the same release) made your agent pick the best *allowed* way to reach another of your machines. Allowed is not the same as alive. Pool reads now report each attempt's outcome into the same route-health record the rest of the mesh already keeps, so a route that is genuinely usable and then dies stops being chosen — and gets its place back when it starts answering again.
- **Who this actually matters for:** two machines on the same local network, where a local address is a real candidate. Where your machines are on different networks, a peer's local address was already being skipped, so the first change was enough on its own.
- **It judges the route, not the answer.** A reply that comes back — even an error reply — proves the route carried traffic, so only a genuine connection failure or timeout counts against it. Otherwise every machine answering "that feature is switched off" would have looked like a broken network.
- **One place does the dialling now.** Every cross-machine read goes through a single function, and a test fails the build if a future one is written the old way — so this cannot quietly stop working as new reads are added.

## What to Tell Your User

Nothing you need to do. If one of your machines sometimes seemed unreachable for the "all my machines" views even though it was running, this is the second half of that fix: your agent now remembers which routes failed instead of trying the same dead one every time.

## Evidence

- `tests/unit/pool-rope-health-feedback.test.ts` (12 tests): convergence using the real addresses from the incident — a local-network route that keeps failing stops being chosen and the tunnel takes over; the two network topologies kept distinct, because the live one would have passed against the broken code too; recovery (the demotion is not permanent); the error-reply-still-counts-as-working contract; and a structural guard that fails if a new cross-machine read is written the old way.
- 62 tests green across the five affected files; the spec addendum records a wrong claim I made about the merged code and the test-rig mistake behind it.

## Summary of New Capabilities

- No new capability. The feedback half of the cross-machine read fix: a dead-but-allowed route now demotes itself instead of being chosen forever.
