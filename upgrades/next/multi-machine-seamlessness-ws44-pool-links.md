# Multi-machine seamlessness — links that survive machine boundaries (WS4.4)

## What Changed

- **`GET /view/:id` now proxies to the machine that HOLDS the view** when this machine
  doesn't have it locally and the WS4.4 flag is on. A private-view link works no matter
  which machine is fronting the dashboard/tunnel — the fronting machine resolves the
  actual holder (by online-peer fan-out), proxies the request, streams the body back,
  and relays the holder's own status unchanged.
- **The cross-machine hop carries a signed user-auth assertion, never the raw PIN.**
  The fronting machine validates the end-user's credential locally, then mints a
  short-lived, **audience-bound** (holder + view-id + method), **single-use** (jti),
  Ed25519-**signed** assertion. The holder verifies it against the expected fronting
  machine's registered key and makes its OWN per-view authorization decision. Each
  machine's PIN secret never crosses the boundary.
- **Bounded by construction (P19):** the holder rejects an over-long TTL span
  (`ttl-too-long`) before recording a jti, and the single-use jti store has a fixed
  size cap with oldest-expiry eviction + an expiry clamp — closing two DoS vectors a
  misbehaving registered peer could otherwise use.
- **Honest under degradation:** an offline holder yields "content temporarily
  unavailable — its machine is offline" (never stale content, never a bare 404), and
  under CPU pressure the fronting edge serves last-cached holder-resolution with an
  explicit staleness tag instead of re-fanning.
- Ships **dark** behind `multiMachine.seamlessness.ws44PoolLinks` (dev-gated);
  flag-off behavior is byte-for-byte today's local-only `/view`. Single-machine installs
  are a strict no-op. CLAUDE.md awareness + idempotent config/migration parity included.

The broader unification of every pool-scope poll cache into one shared per-peer cache
remains a tracked follow-up. <!-- tracked: CMT-1416 -->

## Evidence

- `tests/unit/PoolLinkAssertion.test.ts` (27): mint/verify happy path; named attacks —
  wrong-holder / wrong-view / wrong-method / unexpected-issuer / forged-signature /
  expired / not-yet-valid / **ttl-too-long** / single-use replay (within TTL + across
  restart); raw-PIN-never-carried; **store size-cap eviction** + **far-future-exp
  clamp**; genuine Ed25519 crypto.
- `tests/unit/PoolViewProxy.test.ts` (18): holder resolution; offline → honest 503;
  concurrency cap; private-body-never-cached; load-shed staleness tag.
- `tests/integration/pool-view-link-proxy.test.ts` + `tests/integration/ws44-pool-view-proxy.test.ts`:
  real second-server holder, end-to-end proxy, auth-preservation invariant (no user
  PIN session ⇒ no valid assertion ⇒ holder refuses), flag-off = local-only.
- `tests/e2e/pool-view-link-alive.test.ts`: the feature is alive (200, not 503) on the
  production init path.
- `tests/unit/PostUpdateMigrator-ws44PoolLinks.test.ts` (10): migration + template
  parity, idempotent. `tsc --noEmit` clean.

## What to Tell Your User

On a multi-machine setup, a private-view link (and the dashboard) now works from any of
your machines — even when the content actually lives on a different one. The machine you
reach proxies securely to the real holder: your PIN is checked at the edge and never
sent across machines, and if the holder is offline you get an honest "temporarily
unavailable" instead of a broken page.

## Summary of New Capabilities

- Pool-stable `/view/:id` links: the fronting machine proxies to the content's holder
  with an audience-bound, single-use, signed user-auth assertion (raw PIN never
  crosses), honest offline handling, capped streaming, and CPU load-shed. Ships dark
  behind `multiMachine.seamlessness.ws44PoolLinks`.
