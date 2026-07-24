# Side-Effects Review — Pool-scope multi-rope endpoint resolution

**Version / slug:** `pool-scope-multi-rope-endpoints`
**Date:** `2026-07-17`
**Author:** `instar-codey`
**Second-pass reviewer:** `independent high-risk review — CONCUR, no required fixes`

## Summary of the change

The server's shared `resolvePeerUrls` callback now resolves every active remote
machine through the existing `peerUrl` helper instead of filtering exclusively
on the legacy `lastKnownUrl` field. That helper already delegates to
`PeerEndpointResolver`, which validates and prioritizes enrolled LAN,
Tailscale, and Cloudflare endpoints. Every route that consumes
`resolvePeerUrls` therefore sees the same reachable peer set as routing and
lease traffic.

The live single-agent CROSS-MACHINE failure was a reachable Mini with enrolled
LAN/Tailscale endpoints but no `lastKnownUrl`: four `?scope=pool` surfaces
returned HTTP 200 with `peersQueried=0` and no failure marker.

## Decision-point inventory

1. Active remote machine resolves to a validated endpoint: include it in pool
   fanout. Pinned by source-wiring regression and real two-machine proof.
2. Active remote machine has no resolvable endpoint: omit it from the URL list,
   preserving the callback's typed contract and preventing an invalid request.
3. Self machine: exclude it, preserving the no-recursive-self fanout invariant.
4. Endpoint priority, subnet validation, health scoring, and fallback selection:
   unchanged and owned by the existing `PeerEndpointResolver`.
5. Route-specific timeout, failure markers, merge behavior, auth, and cache:
   unchanged; only peer discovery is corrected.

## Over-block / Under-block

Over-block risk is limited to a peer whose enrolled endpoints all fail the
existing resolver's validation or health policy; it remains absent exactly as
an unusable legacy URL was absent. Under-block risk is that a resolver-selected
endpoint later fails during the route fetch; each pool surface already contains
that fault as an explicit per-peer failure rather than failing the whole view.

One limitation remains: `resolvePeerUrls` returns only resolvable peers, so a
registered machine with no usable endpoint is not itself represented as a
named `no-known-url` failure on these routes. `/guards?scope=pool` has a wider
accounting roster for that purpose. This change fixes the demonstrated silent
omission of a machine that *does* have usable enrolled endpoints.

## Level-of-abstraction fit / Signal vs authority

The change is at the single shared peer-discovery boundary used by all
pool-scope routes, not duplicated into individual routes. Endpoint selection is
connectivity signal used for read-only fanout; it does not grant ownership,
write authority, or placement authority. Existing authenticated peer requests
and route-local authorization remain unchanged.

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

## External surfaces / Rollback

External behavior changes only for `?scope=pool` and other existing consumers
of `resolvePeerUrls`: enrolled peers can now contribute through non-legacy mesh
ropes. No schema, config, state, migration, secret, or destructive action is
introduced. Rollback is the isolated resolver callback change.

## Evidence pointers

- `tests/unit/peer-presence-wiring.test.ts` pins that pool discovery calls the
  shared `peerUrl` helper and forbids the legacy-only filter/mapping.
- 34/34 focused tests passed across peer-presence wiring and sessions/jobs/
  attention/subscription pool-scope integration suites.
- `npm run build` passed on Instar 1.3.863.
- Live candidate on the Laptop against the real Mini changed all four surfaces
  from `peersQueried=0` to `peersQueried=1`, `peersOk=1`, `failed=[]`; jobs and
  attention returned rows stamped with both machine IDs.
- Filed live defect: `fb-3b3996dd-374`.
- Independent review concurred that the change reuses the validated endpoint
  authority at a read-only boundary, preserves self/active/null filtering and
  route-local auth/failure handling, and honestly states the unresolved-peer
  omission limitation.
