# Side-Effects Review — Dashboard pool-wide sessions (every session, every machine)

**Version / slug:** `dashboard-pool-sessions`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (additive read-only aggregation + UI; no authority, no mutation; every boundary test-pinned across three tiers)

## Summary of the change

`GET /sessions` self-tags each session with `machineId`/`machineNickname` when
the pool is wired, and `GET /sessions?scope=pool` aggregates every reachable
peer's plain `/sessions` (new `resolvePeerUrls` route hook off the machine
identity registry), tagging remote sessions with their machine + `remote:true`.
The dashboard polls the aggregate every 15s and renders a machine badge on
every session row; remote rows are informational (no subscribe/close). CLAUDE.md
template + idempotent migration carry the agent awareness.

## Decision-point inventory

1. Pool wired vs not → self-tag vs omit fields. Both sides pinned (integration).
2. `scope=pool` vs plain → envelope vs back-compatible array. Both pinned
   (integration + e2e).
3. Peer reachable vs dead → merged+tagged vs `pool.failed` entry. Both pinned
   against a REAL second HTTP server / a dead port.
4. Dashboard row local vs remote → interactive vs informational (click, close,
   active highlight, row key namespace). All pinned (unit).
5. Migration: section-present-without-marker / marker-present / no-section.
   All three pinned.

## 1. Over-block

Nothing rejected. The plain route's shape and fields are unchanged for
existing callers (additive fields only). `scope=pool` is opt-in.

## 2. Under-block

- Remote sessions are view-only — no remote kill or terminal streaming (named
  non-goals; the tooltip routes the user to the owning machine's dashboard).
- The aggregate trusts each peer's self-report; a peer that lies about its
  sessions is already inside the trust boundary (same authToken).
- The 15s poll means a remote session can be up to ~15s stale — acceptable for
  a visibility surface; local sessions remain real-time via the WebSocket.

## 3. Level-of-abstraction fit

Aggregation lives in the one route that owns session listing, reusing each
peer's EXISTING plain route (no new peer surface, no recursion — peers are
fetched without `scope`). Peer discovery (`resolvePeerUrls`) is wired in
`server.ts` from the same identity-registry source the lease/marker transports
already use. The dashboard keeps the WebSocket as the live local feed and
layers the poll on top — remote state is kept in a separate array precisely
because the WS replaces the local one each broadcast.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added anywhere: read-only aggregation, fail-soft per peer
(`failed` entries, never a 500), best-effort dashboard poll (a failed tick
retries next interval).

## 5. Interactions

- Cross-machine fetch uses the established Bearer-authToken pattern
  (placement-proxy precedent) with a 5s `AbortSignal.timeout` so a hung peer
  can't pin the route.
- No recursion: the aggregate always fetches peers' PLAIN `/sessions`.
- The WebSocket session feed is untouched; local rows merely inherit the self
  nickname at render time from the poll response.
- tmux-name collisions across machines are handled by namespacing remote row
  keys (`remote:<machineId>:<tmux>`).

## 6. External surfaces

One query param on an existing authed route; one optional RouteContext hook;
dashboard HTML/JS; CLAUDE.md template bullet + idempotent migration. No config,
no notifications, no new files on disk.

## 7. Rollback cost

Trivial — revert the PR. The plain route shape is unchanged, so nothing else
depends on the new fields; no state, no schema, no migration side effects
beyond an extra CLAUDE.md bullet (inert text).

## Conclusion

Additive, read-only, fail-soft visibility feature at the minimal scope that
satisfies the operator requirement verbatim: every session shows on the
dashboard, and every row states its machine.

## Second-pass review (if required)

Not required — see header.

## Evidence pointers

- `tests/unit/dashboard-sessionMachineBadge.test.ts` (8) — UI contract.
- `tests/unit/PostUpdateMigrator-poolSessionsVisibility.test.ts` (3) — parity.
- `tests/integration/sessions-pool-scope.test.ts` (5) — route contract incl. a
  REAL peer server + dead-peer degradation.
- `tests/e2e/sessions-pool-scope-lifecycle.test.ts` (3) — feature-alive on the
  production init path.
- `docs/specs/dashboard-pool-sessions.md` + `.eli16.md`.
