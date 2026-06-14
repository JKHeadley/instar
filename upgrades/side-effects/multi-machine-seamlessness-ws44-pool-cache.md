# Side-Effects Review — WS4.4(f): global pool-cache unification

**Version / slug:** `multi-machine-seamlessness-ws44-pool-cache`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` §WS4.4 clause (f) (converged + approved; deferred second half of WS4.4, tracked CMT-1416)
**Second-pass reviewer:** not-required — pure read-side efficiency/observability; no new authority, no credential-bearing code, no destructive op, no third-party spend.

## Summary of the change

WS4.4 clause (f), the deferred second half of WS4.4: every pool-scope dashboard
surface (`/sessions?scope=pool`, `/jobs?scope=pool`, `/attention?scope=pool`,
`/guards?scope=pool`, …) used to fan out to every peer machine INDEPENDENTLY — once
per surface, per client, per poll interval. With a dashboard polling several tabs at
once, the same peer is hit N times per interval. This unifies all of them onto ONE
shared per-peer poll cache: one fan-out per interval feeds every pool-scope surface,
and under CPU load-shed the cache serves last-cached peer data tagged `stale: true`
instead of re-fanning (load-shed, honestly labeled).

New module (pure + dependency-injected, unit-testable):
- `src/server/PoolPollCache.ts` — `fetchPeer(peerMachineId, routePath, fetcher)`:
  within-TTL cache hit (one fan-out feeds two surfaces), single-flight coalescing of
  concurrent callers, CPU load-shed stale-serve (never from an empty cache — a first
  read always fetches), a failed fetch is NEVER cached (transient errors don't stick),
  per-(peer, route) keying, and a read-only `snapshot()` of live load + counters.

Wiring (all behind the dark flag):
- `routes.ts` — the `/jobs?scope=pool` per-peer fetch routes through `ctx.poolPollCache`
  when wired; `null` (flag dark / single-machine) ⇒ today's direct per-peer fetch
  byte-for-byte. New read-only `GET /pool/poll-cache` observability route (503 when
  dark — the ships-dark contract). A stale-served peer body surfaces an honest
  `pool.stale: true` tag on the merged response.
- `commands/server.ts` + `AgentServer.ts` — dev-gated construction (resolveDevAgentGate)
  in the mesh-setup block; `seamlessnessFlags.ws44PoolCache` capability advert.
- `types.ts` / `ConfigDefaults.ts` / `devGatedFeatures.ts` — flag (`ws44PoolCache`,
  DELIBERATELY OMITTED so the dev-gate decides) + `ws44PoolCacheTtlMs` tunable +
  `MachineCapacity.ws44PoolCache` advert field.
- `PostUpdateMigrator.ts` + `templates.ts` — Migration Parity (config strip-default +
  CLAUDE.md section + shadow-capability markers) + Agent Awareness.

## Decision-point inventory

- `/jobs?scope=pool` per-peer fetch through the shared cache — **add** — wired only
  when the dark flag is on; else the existing direct fetch is unchanged.
- `GET /pool/poll-cache` observability route — **add** — 503 while dark (ships-dark
  contract, like `/pool/queue`); 200 with the snapshot when wired.
- CPU load-shed stale-serve — **add** — over the load-per-core threshold, serve
  last-cached tagged `stale: true` rather than re-fanning; an empty cache still fetches.

---

## 1. Over-block
Flag-off (default fleet): zero new behavior — every pool-scope surface keeps its direct
per-peer fetch byte-for-byte (verified by the "NOT WIRED (cache null)" integration
test). Flag-on: the 3s default TTL matches the per-route pool caches already in use, so
no legitimate fresh read is starved. Load-shed only triggers at/above the load-per-core
threshold (default 1.5, the SessionReaper critical default) AND only when something is
already cached — a first read is never load-shed.

## 2. Under-block
Not an authority — this gates nothing. It only decides whether to reuse a recently
fetched peer body or re-fetch. The worst case is serving a body up to one TTL (or, under
load-shed, the last-cached) older than a fresh fan-out would produce — and load-shed is
HONESTLY tagged (`stale: true` on the body, `pool.stale: true` on the merge) so a stale
serve is never silent. A failed fetch is never cached, so a transient peer error cannot
stick for the whole TTL.

## 3. Level-of-abstraction fit
Right layer. `PoolPollCache` is a pure primitive (injected clock + load reader); the
route change is a thin branch that calls the fetcher directly when the cache is null.
It rides the existing pool fan-out pattern (resolvePeerUrls + per-peer timeout + failed
markers) rather than inventing new transport.

## 4. Signal vs authority compliance
Everything here is a SIGNAL, never an authority: the cache hit / load-shed staleness is
observability + an efficiency choice; it never gates serving anything, never mutates
state, and never caches private end-user content (the pool-scope surfaces are
operator-Bearer reads of mesh METADATA — `/view/:id` private bodies are handled by
WS4.4 pool-links, which explicitly never caches them).

## 5. Interactions
- Flag-off path leaves every pool-scope surface identical (no shadowing of the direct
  fetch).
- Coexists with the per-route payload caches (`jobsPoolCache`, etc.) — those dampen two
  rapid calls to the SAME surface; this shared cache dampens the cross-surface,
  cross-client per-peer fan-out. The integration test proves the shared cache is
  genuinely in the path by asserting on ITS OWN counters (`stats.fetches`,
  `cachedKeys`), not the maskable per-route "1 peer hit".
- Single-machine installs have no peers ⇒ a strict no-op (the cache is never
  constructed, surfaces never call it).

## 6. Rollback
Set/omit `multiMachine.seamlessness.ws44PoolCache` (dev-gated; dark on the fleet by
default). When off, the cache is never constructed and `/pool/poll-cache` 503s — fully
reverting to the direct per-peer fetch. No data migration, no persisted state to undo.

## Evidence

- `tests/unit/pool-poll-cache.test.ts` (9): both sides of every decision boundary —
  within-TTL hit vs expired re-fetch; single-flight coalescing; load-shed over/under
  threshold; load-shed with an EMPTY cache still fetches; a failed fetch is never
  cached; per-(peer, route) keying; snapshot wiring + boundary flip at the threshold.
- `tests/integration/ws44-pool-cache-route.test.ts` (4): real wiring (real second-server
  peer that COUNTS its `/jobs` hits) — the fan-out routes THROUGH the shared cache
  (asserted via the cache's OWN `stats.fetches` + `cachedKeys`, not the maskable
  per-route "1 hit"); a second poll past the per-route window is served from the shared
  cache WITHOUT re-hitting the peer; the merged body is byte-identical wired vs unwired;
  `GET /pool/poll-cache` 503-when-dark / 200-when-wired.
- `tests/e2e/pool-poll-cache-alive.test.ts` (3): the feature is ALIVE (200, not 503) on
  the real AgentServer stack; sits behind auth (no Bearer → 401/403); the ships-dark
  default 503s with `{ enabled: false }`.
- Gate checks green: `tsc --noEmit`; `docs-coverage --check`; `no-silent-fallbacks`
  (the one new fail-closed construction-catch is tagged `@silent-fallback-ok`);
  `feature-delivery-completeness` (new featureSection + both shadow-marker variants);
  `lint-dev-agent-dark-gate` (line-map recomputed for the +17 ConfigDefaults shift).
