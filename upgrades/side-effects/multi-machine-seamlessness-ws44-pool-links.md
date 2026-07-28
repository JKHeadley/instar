# Side-Effects Review — WS4.4: links that survive machine boundaries

**Version / slug:** `multi-machine-seamlessness-ws44-pool-links`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` §WS4.4 (converged + approved)
**Second-pass reviewer:** 3 adversarial security lenses (assertion-replay-forgery / credential-substitution / private-cache-and-logging) — verdicts folded below; 2 MEDIUM DoS findings FIXED.

## Summary of the change

WS4.4 (§WS4.4 a–f): the tunnel-fronting machine proxies `GET /view/:id` to the
machine that actually HOLDS the content, so a private-view link works no matter which
machine serves the dashboard. SECURITY-SENSITIVE — the cross-machine hop carries an
audience-bound, single-use, signed **user-auth assertion**, never the raw PIN/token.

New modules (all pure + dependency-injected, unit-testable):
- `src/core/PoolLinkAssertion.ts` — mint/verify the assertion. Audience triple
  (holder fingerprint + view-id + method), signed Ed25519 by the fronting machine's
  mesh key, verified by the holder against the EXPECTED issuer's REGISTERED key,
  freshness + a hard **TTL-span ceiling**, single-use jti.
- `src/core/PoolLinkJtiStore.ts` — holder-side durable single-use replay store
  (persisted across restart), now with a **fixed size cap** + **expiry clamp**.
- `src/core/PoolViewProxy.ts` — fronting holder-resolution (fan-out probe), capped
  streaming, honest offline verdict, `(f)` CPU load-shed with explicit staleness tag.

Wiring: `MeshRpc.ts` (`pool-view-fetch` verb + read/observe RBAC), `routes.ts`
(`GET /view/:id` gains the fronting branch + holder verify; flag-off ⇒ today's
local-only behavior byte-for-byte), `commands/server.ts` + `AgentServer.ts` (dev-gated
construction), `types.ts`/`ConfigDefaults.ts`/`devGatedFeatures.ts` (flag + tunable),
`PostUpdateMigrator.ts` + `templates.ts` (Migration Parity + Agent Awareness).

Deferred (tracked): the broader unification of ALL pool-scope poll caches
(attention/jobs/sessions/guards) into one shared per-peer cache. <!-- tracked: CMT-1416 -->

## Decision-point inventory

- `GET /view/:id` fronting branch — **add** — when this machine does NOT hold the
  view AND ws44 is wired, resolve the holder + proxy; else unchanged local serve.
- holder `pool-view-fetch` verify gate — **add** — the holder refuses to serve a
  private body to a mesh call lacking a valid user-auth assertion (holder is the sole
  authorizer; it relays its own 401/403 unchanged, never masked by a 200).
- TTL-span ceiling + jti-store cap — **add** — two bounded-by-construction guards
  (P19) closing the DoS findings from the security review.

---

## 1. Over-block
Flag-off (default): zero new behavior — local `/view/:id` is byte-for-byte unchanged
(verified by a flag-off test). Flag-on: a legitimate assertion (sub-second hop, 30s
default span) is never rejected by the 5-min TTL ceiling. The jti-store cap default
(100k) is far above any real per-window volume; eviction is oldest-expiry first
(closest to GC) so a legitimate in-window jti is not evicted under normal load.

## 2. Under-block
The fronting machine validates the END-USER credential locally BEFORE minting — the
assertion only attests "a user authenticated at the edge for THIS resource"; the
holder still applies its OWN per-view authorization on top (defence in depth). A
captured assertion cannot be replayed against another view/method/holder (audience
binding), by another machine (issuer bound to the mesh-authenticated sender), or twice
(single-use jti). Residual: a registered-but-compromised peer could still mint valid
assertions for resources a user genuinely authenticated to at its edge — but it can
NEVER substitute its machine credential for a user credential (verified by the
credential-substitution lens), and the holder's own per-view authz still gates.

## 3. Level-of-abstraction fit
Right layer. The assertion + jti store are pure primitives; the proxy is one module;
the route change is a thin branch. Holder resolution rides the existing pool fan-out
pattern (resolvePeerUrls + per-peer timeout + failed markers) rather than inventing a
replicated view-id→machine index (none exists; PrivateViewer stores views on the
creating machine's local disk — documented in code).

## 4. Signal vs authority compliance
The assertion VERIFY is an authority (it gates serving a private body), and it is
implemented with HARD cryptographic checks (Ed25519 over canonical bytes incl. the
audience), not brittle heuristics — appropriate for an authority. The load-shed +
holder-resolution caching are signals (staleness-tagged), never gates.

## 5. Interactions
- Flag-off path leaves `GET /view/:id` identical (no shadowing of the local serve).
- The MeshRpc `pool-view-fetch` verb is a NEW read/observe-class verb with its own
  RBAC case — does not collide with existing verbs.
- The jti store is holder-local; no cross-store contamination.
- Does NOT touch the WS4.1/WS4.3 pool caches (the cache unification is the tracked
  CMT-1416 follow-up), so no race with those routes.

## 6. External surfaces
- New cross-machine mesh verb (`pool-view-fetch`), authenticated by the existing mesh
  envelope (recipient-bound, signed, nonce, registered-peer). An old peer that doesn't
  implement it returns an error → the fronting machine degrades to an honest 503, never
  a stale body or bare 404.
- New config: `multiMachine.seamlessness.ws44PoolLinks` (dev-gated, ships dark) +
  `ws44LoadShedLoadPerCore` tunable; `seamlessnessFlags.ws44PoolLinks` capability
  advertisement (additive; absent = non-participant).
- The raw PIN/view-token NEVER crosses the boundary (verified by the
  private-cache-and-logging lens: no PIN/token/signature/jti/assertion is logged).

## Framework generality
No framework-launch abstraction touched — WS4.4 does not modify
`frameworkSessionLaunch.ts`. The proxy operates on HTTP view routes + the mesh layer,
both framework-agnostic. N/A beyond that.

## 7. Multi-machine posture (Cross-Machine Coherence)
**proxied-on-read** — this IS a multi-machine feature by construction: the fronting
machine proxies to the holder per request, resolving the holder by online-peer fan-out
(skips dark peers, honest 503 when the holder is offline). No durable cross-machine
state beyond the holder-local jti store. Single-machine install = strict no-op (no
peers → local serve only). Generated view URLs survive a machine boundary precisely
because of this proxy (the F6 goal). Phase-C clean: per-online-peer fan-out, no 2-peer
assumption, all new structures bounded independent of pool size.

## 8. Rollback cost
Trivial: ships dark behind the dev-gated `ws44PoolLinks` flag (omitted from
ConfigDefaults; the dev-gate decides). Reverting the flag restores today's local-only
`/view/:id`. The migrator bullet is idempotent + content-sniffed; the config migration
strips only a force-dark literal `false`, preserving an operator `true`. No durable
state migration.

---

## Second-pass review (3 adversarial security lenses)

The build ran 3 independent security lenses. Verdicts:
- **assertion-replay-forgery:** NO auth bypass — forge / cross-resource replay /
  cross-machine replay / algorithm-confusion all correctly blocked (issuer verified
  against the REGISTERED key, audience triple cross-checked against the actual request,
  expiry + single-use enforced). Found **2 MEDIUM DoS** issues — BOTH FIXED in this PR:
  1. holder did not bound the assertion TTL span (`exp − iat`) — a misbehaving
     registered peer could mint a far-future-exp and pin its jti for that span. FIX:
     `verifyPoolLinkAssertion` now rejects a span over `DEFAULT_POOL_LINK_MAX_TTL_MS`
     (5 min) as `ttl-too-long` BEFORE the jti is recorded (+ tests).
  2. `PoolLinkJtiStore` had no size cap (unbounded memory/disk). FIX: fixed
     `maxEntries` ceiling (default 100k) with oldest-expiry eviction + loss counter,
     AND the recorded expiry is clamped to `now + retention` so gc can never be pinned
     (+ tests). (P19 — both now bounded by construction.)
- **credential-substitution:** SAFE — dumb-relay / no-substitution invariant holds;
  holder is sole authorizer; raw PIN/token never crosses.
- **private-cache-and-logging:** SAFE — private bodies never cached; no
  PIN/token/signature/jti/assertion logged; offline → honest 503; PIN-gated views fail
  closed across the proxy.
- Residual LOW (tracked): the edge-auth precondition is enforced by middleware
  ordering but the unit security tests bypass the middleware, so the precondition is
  not covered by a route-level test. Enforcement is real; the test coverage gap is the
  follow-up. <!-- tracked: CMT-1416 -->

Verdict: the auth core is sound; the 2 MEDIUM DoS hardening gaps are fixed with tests.
Ship.
