# Side-Effects Review — Mesh resolver startup fallback

## Summary

The session-pool peer URL closure now uses an undefined-safe resolution funnel.
The preferred behavior is unchanged when mesh initialization succeeds. When it
does not, routing degrades to the pre-mesh registry URL instead of terminating
the server process.

## Risks and boundaries

- A degraded mesh may temporarily use one legacy route instead of hedged routes.
- If neither a resolver candidate nor legacy URL exists, lookup still returns
  no route; it does not invent reachability.
- The change adds no external writes, credentials, schemas, or user actions.
- Rollback is a normal patch revert with no state cleanup.

## Evidence

- `tests/unit/resolve-mesh-peer-url.test.ts`
- `tests/integration/resolve-mesh-peer-url.test.ts`
- `tests/e2e/mesh-resolver-startup-lifecycle.test.ts`

