# Side-effects review — LocaltunnelProvider (PR 4 of tunnel-failure-resilience chain)

**Scope (PR 4 of the chain):** Add the `LocaltunnelProvider`
implementation of the `TunnelProvider` interface from PR 1. The class
is added in isolation — NOT wired into the manager's active pool —
so PR 5 can ship the consent state machine + inline-button UX +
relay-active activation path with the provider already in place
under separate review. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged
+ approved on main.

**Files touched:**
- `src/tunnel/LocaltunnelProvider.ts` — NEW. Implements
  `TunnelProvider` with `name: 'localtunnel'`, `tier: 2`. Dynamic
  import of the `localtunnel` npm package; graceful "unavailable"
  return path when the dep isn't installed. Failure classification
  preserves the `ProviderFailureReason` enum surface from PR 1
  (rate-limited / network / process-exit / binary-missing).
- `tests/unit/localtunnel-provider.test.ts` — NEW. 7 tests covering
  the provider's surface (name + tier), graceful degradation when
  the npm package is absent (isAvailable=false; start() rejects
  binary-missing; verdict cached across calls), and constructor
  option acceptance.

**Under-block**: None — the provider is added but NOT wired into the
manager's active pool. The manager's existing `buildDefaultPool`
returns Cloudflare-named + Cloudflare-quick only, and the driver
filters Tier-2 providers (`if (provider.tier !== 1) continue;`).
User-facing behavior is unchanged.

**Over-block**: None. The provider class is purely additive; no
existing behavior changes.

**Level-of-abstraction fit**: The provider implements the same
interface as the Cloudflare providers, so PR 5's state-machine
changes can use it through the existing pool abstraction without
needing provider-specific code paths. Tier-2 trust classification
lives on the provider (`tier: 2` field), which is correctly the
manager's structural signal for "consent required."

**Signal vs authority**: Compliant. The provider raises errors with
classified reason strings (the SIGNAL); the manager classifies them
into `ProviderFailureReason` (the AUTHORITY). The consent gate (PR 5)
will be a separate AUTHORITY layer above the manager's driver — the
provider never makes consent decisions on its own.

**Interactions**:
- Dynamic import: the provider does `await import('localtunnel')` at
  first `isAvailable()` call. On environments without the dep, the
  import throws and the provider caches the "unavailable" verdict.
  This is deliberately a runtime check, not a build-time one — instar
  ships without the `localtunnel` dep in `package.json` (per the
  spec's supply-chain hardening — Tier-2 backup capability is opt-in,
  installed explicitly by operators who want it).
- The `subdomain` constructor option is operator-controlled. The
  comment documents the privacy posture: never use the agent's
  identity as a subdomain hint — it would be publicly visible on
  `*.loca.lt`.

**External surfaces**:
- New exported class `LocaltunnelProvider` from `src/tunnel/`.
- No new npm dependency — `localtunnel` is NOT added to
  `package.json` in this PR. The provider degrades gracefully when
  the dep is absent. Operators add the dep explicitly to enable the
  capability. This matches the spec's supply-chain posture (Part 7).
- No new API endpoint, no new CLI command, no new config field
  (Part 4 fields land with PR 5 alongside the consent flow).

**Migration parity**: N/A. The provider is server-side code only;
no agent-installed file change.

**Rollback cost**: Trivial. Delete two files (`src/tunnel/Local-
tunnelProvider.ts` and the test). The provider is isolated; nothing
else references it.

**Tests**:
- 7/7 tests in `tests/unit/localtunnel-provider.test.ts`.
- 70/70 tunnel-related tests from PRs 1–3 unaffected.
- `tsc --noEmit` clean. `npm run lint` clean.

**Decision-point inventory**:
1. Dynamic import (vs. static `import localtunnel from 'localtunnel'`)
   — keeps `localtunnel` out of the build-time type-check graph so
   instar can ship without the dep. Operators add it explicitly per
   the spec's supply-chain stance.
2. `localtunnel` NOT added to `package.json` in this PR — landing the
   dep before the consent gate ships would expose users to an
   unchecked Tier-2 capability. The dep lands in PR 5 alongside the
   consent flow that gates its use. This is intentional and
   per-spec — Part 7 frames the capability as opt-in regardless.
3. `subdomain` is operator-controlled and documented as
   non-identifying. The provider does not auto-generate one.
4. Failure classification matches PR 1's enum — no new failure
   reasons needed; the manager's existing logic handles localtunnel
   failures the same way as cloudflared failures.
