# Side-Effects Review — Mobile pairing link

**Version / slug:** `mobile-pairing-link`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Adds one-time pairing links that add an agent to the Instar iPhone app. New `src/core/MobilePairing.ts` (code store, limiters, v1 link builder, paired-devices log) and `src/server/mobilePairingRoutes.ts` (public redeem + ping registered before the bearer gate; mint + devices behind it). `AgentServer.ts` wires the service; `middleware.ts` gains two exact path+method bearer exemptions; `types.ts` adds `mobilePairing` config; dev-gated registry, capability index and CLAUDE.md template + PostUpdateMigrator section. `site/` gains the instar.sh `/pair` fallback page (client-side QR, no network) and the `apple-app-site-association` endpoint. Tier 2 (auth-adjacent): ~520 lines of source and tests; spec converged in 6 rounds (the Tier-2 cap).

## Decision-point inventory

- Redeem accept/refuse — add — exact code lookup (SHA-256), expiry, single use, bound to the token in force at mint.
- Redeem transport — add — `arrivedOverLocalTls` + named tunnel lifecycle active + Host equals the configured stable host.
- Redeem failure limiter — add — 30 failures / 10 min, applied after the code lookup so a valid code always redeems.
- Mint limits and address checks — add — Bearer, 10 live / 10 per hour (429), named tunnel with hostname, registry hostname uniqueness, eight self-probes.
- Bearer gate — modify — two new exact exemptions (`POST /mobile/pairing-codes/redeem`, `GET /mobile/pairing-codes/ping`).

## 1. Over-block

A real pairing can be refused when: the agent uses a quick tunnel (by design, 409); a named tunnel lacks a configured hostname (409 with the fix named); a sibling's stale registry entry still lists the same hostname (409 `not-the-tunnel-machine`, a false refusal costing one retry after the registry refreshes); a probe times out on a slow tunnel (409 `address-unverified`, retry); cloudflared is configured to rewrite Host (every redeem 403 — caught by the live proof). The PIN path keeps working in every case.

## 2. Under-block

A second connector on the same hostname that is missing from the registry and dodges all eight probes is not detected; the consequence is a failed redeem ("expired"), never a mis-issued credential. A code read from Telegram by someone else within ten minutes can be redeemed first (the operator then sees "already used"); mitigated by sending only to the verified operator's topic, single use and the short TTL. The token itself is still the all-powerful API token (existing over-grant), tracked by CMT-1179. A local process can redeem by sending a matching Host over loopback, but any local process already holds the token, so this adds nothing.

## 3. Level-of-abstraction fit

The authentication checks sit in the HTTP route layer beside the existing `/dashboard/unlock`, reusing its transport primitive (`arrivedOverLocalTls`) but not its counters. Code state is a small in-memory store, not a new persistence subsystem. The device log is a plain bounded JSON file. No higher-level gate should own this: it is an exact credential exchange.

## 4. Signal vs authority compliance

The blocking decisions are exact secret comparisons and fixed rate/transport checks on the agent's own credential, the hard-invariant case the principle exempts. The mint-side deployment checks only refuse (never grant) and their false refusals cost one retry. No brittle detector gains authority over agent behavior or messages.

## 4b. Judgment-point check

No competing-signals decision point is given a static heuristic. The one judgment point (where the agent sends the link) is left to the agent within the verified-operator floor, stated in the CLAUDE.md section.

## 5. Interactions

Does not touch the PIN route's counters, `pinAttemptStore` or the operator-session store. Reads the tunnel manager's lifecycle snapshot (read-only) and the machine registry (read-only). The bearer middleware gains two exact-path branches before the general check; the existing auth-deprecation warning for requests without `X-Instar-AgentId` applies to the app's later Bearer calls (the app sends the agent name it receives at redeem). The automatic token rotation after a relay episode now also signs out paired phones: the app shows "needs pairing again", and the rotation notice (`src/commands/server.ts`, via `pairedPhonesRotationNote`) gains one sentence telling the operator to ask for a fresh link when the device log is non-empty. The redeem route gets its own 4 KB JSON parser registered before the global 12 MB one.

## 6. External surfaces

New public endpoints on the agent's tunnel (redeem, ping) and on instar.sh (`/pair`, `/.well-known/apple-app-site-association`). The v1 link format is a published interface consumed by the iOS app. The AASA names only `AG9AE2H87X.io.sagemindai.instar`. Telegram messages may now carry a pairing link (sent only by the agent on request).

## 6b. Operator-surface quality

The instar.sh page is the operator surface: one host name in large type, a QR code, a Copy link button with the next step spelled out, and a plain "not valid" state. It works from a phone (copy → paste in the app) and a laptop (scan). It makes no network requests.

## 7. Multi-machine posture

Codes: ephemeral process memory on the machine serving the named tunnel (mint refuses elsewhere). Device log: proxied-on-read (`GET /mobile/devices?scope=pool`, failures listed). The phone holds one machine's origin and token; a tunnel-front move or a sibling with a different token means "pair again" until CMT-1179.

## 8. Rollback cost

`mobilePairing.enabled: false` (read live) → all four routes 503. Revert removes the routes and the instar.sh page; the device log is an inert file; live codes die on restart. Paired phones keep the token they already have (same as a browser that unlocked with the PIN).

## Conclusion

Ships dark on the fleet and live on development agents. The credential exchange is narrow, single-use, short-lived and grants nothing beyond the PIN (minus the operator session). The known gaps are stated and tied to CMT-1179.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concern → resolved, concur.** The reviewer confirmed the security core (no operator session, synchronous take-and-delete, valid code past the limiter, rotation binding, transport, exact exemptions, 503 gate, route order, no leaks) and raised one concern: the spec's rotation notice for paired phones was not built. Resolved by `pairedPhonesRotationNote` in the rotation notice plus a unit test. Minor notes also applied: the redeem body limit now actually applies (path-scoped parser before the global one), self-probe nonces are deleted on use, and the under-block section names local callers.

## Evidence pointers

- Spec + convergence report: `docs/specs/mobile-pairing-link.md`, `docs/specs/reports/mobile-pairing-link-convergence.md`.
- Tests: `tests/unit/mobile-pairing.test.ts` (14), `tests/integration/mobile-pairing-routes.test.ts` (10), `tests/e2e/mobile-pairing-alive.test.ts` (2).
