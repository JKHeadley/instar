# Side-effects review: capability registry Increment 1

- Adds only an in-memory receiver and synthetic fixtures over already validated projections.
- No route, mesh verb, heartbeat emission, transport client, or durable store is added.
- Replay fixtures name their failure inputs: identical heartbeat digest/proof and identical pull response/nonce; both must fail to refresh freshness.
- Rollback is literally deleting the unreferenced receiver and its tests.
