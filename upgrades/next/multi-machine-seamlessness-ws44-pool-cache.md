# Multi-machine seamlessness — global pool-cache unification (WS4.4(f))

## What Changed

- **Every pool-scope dashboard view now shares ONE per-peer poll cache.** Before,
  `/sessions?scope=pool`, `/jobs?scope=pool`, `/attention?scope=pool` and
  `/guards?scope=pool` each fanned out to every peer machine independently — once per
  tab, per client, per poll interval. With a dashboard polling several tabs at once,
  the same peer got hit N times an interval. Now one fan-out per interval feeds every
  pool-scope surface, cutting wasted egress + peer CPU that scaled with open tabs.
- **Single-flight coalescing:** a burst of tab-loads asking the same peer in the same
  window collapses to ONE in-flight request, not one per caller.
- **Honest CPU load-shed:** when the fronting machine is over a load-per-core threshold,
  a pool view serves its last-cached peer data tagged `stale: true` (and the merge
  carries `pool.stale: true`) instead of re-fanning — load-shed that is always labeled,
  never silent staleness. A first-ever read (empty cache) always fetches.
- **A failed peer fetch is NEVER cached** — a transient peer error can't stick for the
  whole TTL; the next read re-fetches.
- **New read-only `GET /pool/poll-cache`** reports whether the cache is wired, its TTL +
  load-shed threshold, the live load-per-core, whether it's currently load-shedding, and
  the cumulative counters (fan-outs avoided via cache hits + load-sheds, single-flight
  coalesces). 503 while the flag is dark — the ships-dark contract.
- Ships **dark** behind `multiMachine.seamlessness.ws44PoolCache` (dev-gated);
  flag-off behavior is byte-for-byte today's direct per-peer fetch. Single-machine
  installs are a strict no-op (no peers). CLAUDE.md awareness + idempotent
  config/migration/shadow-marker parity included.

This completes the WS4.4 work begun with pool-stable links. <!-- tracked: CMT-1416 -->

## Evidence

- `tests/unit/pool-poll-cache.test.ts` (9): within-TTL hit vs expired re-fetch;
  single-flight coalescing; load-shed over/under threshold; load-shed with an empty
  cache still fetches; failed fetch never cached; per-(peer, route) keying; snapshot
  wiring + threshold boundary on both sides.
- `tests/integration/ws44-pool-cache-route.test.ts` (4): real second-server peer that
  COUNTS its hits — the fan-out goes THROUGH the shared cache (proven via the cache's
  OWN stats counters, not the maskable per-route "1 hit"); a later poll is served from
  the shared cache without re-hitting the peer; merged body byte-identical wired vs
  unwired; the route 503s dark / 200s wired.
- `tests/e2e/pool-poll-cache-alive.test.ts` (3): the feature is alive (200, not 503) on
  the production AgentServer path; behind auth; the dark default 503s.
- `tsc --noEmit` clean; docs-coverage, no-silent-fallbacks, feature-delivery, and the
  dev-agent dark-gate line-map all green.

## What to Tell Your User

On a multi-machine setup, your dashboard no longer hammers your other machines. When you
have several pool-scope tabs open (sessions, jobs, attention, guards), each of your other
machines is now polled once per interval and that single result feeds every tab, instead
of every tab polling every machine on its own. If your fronting machine gets busy, a pool
view will briefly show its last-known data clearly marked as stale rather than piling on
more cross-machine traffic. Single-machine setups see no change at all.

## Summary of New Capabilities

- Shared per-peer poll cache for all pool-scope surfaces: one fan-out per interval feeds
  every view, single-flight coalescing, and honest CPU load-shed with an explicit
  staleness tag. Read it at GET /pool/poll-cache. Ships dark behind
  multiMachine.seamlessness.ws44PoolCache.
