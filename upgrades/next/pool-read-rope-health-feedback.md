# Pool reads learn which routes are dead

## What Changed

- **A route that stops working now demotes itself.** An earlier change chose the best *allowed* way to reach one of your machines; allowed is not the same as alive. Pool-scope reads now report each attempt's outcome into the same route-health record the rest of the mesh already keeps, so a route that is genuinely usable and then dies stops being chosen, and recovers its place when it starts answering again.
- **Who this actually matters for:** two machines on the same local network, where a local address is a real candidate. Where the machines are on different networks, a peer's local address was already being skipped, so the earlier change was enough on its own.
- **It reports the route, not the verdict.** A reply that comes back — even an error reply — proves the route carried traffic, so only a genuine connection failure or timeout counts against it. Otherwise every machine answering "that feature is off" would have looked like a broken network.

## What You Need To Do

Nothing. It applies to pool-scope reads automatically.

## Summary of New Capabilities

- No new capability. A correctness follow-up so route choice converges instead of staying lucky.
