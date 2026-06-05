# Side-effects review — TunnelManager unit-suite rewrite + quarantine re-arm

Closes the durable commitment "Rewrite TunnelManager unit suite" opened during
the 2026-06-05 full-suite triage (the one knowingly-stale entry left parked by
the test-debt re-arm PR #837).

## 1. The change

- **`tests/unit/TunnelManager.test.ts`** — full rewrite. The old suite
  predated the tunnel provider/tier rewrite: it mocked the `cloudflared`
  module directly, while production drives a provider pool with a REAL
  reachability probe (`driveTier1` → `probeReachability` fetches
  `<url>/health` and requires 2xx), so 22/29 tests could never pass. The new
  suite uses the constructor injection seams exclusively
  (`injections.providers`, `injections.fetch`) plus the public deterministic
  drivers (`runSelfHealCheck()`, `grantConsent()`, `declineConsent()`):
  51 tests covering constructor/persisted-state restore, the happy start
  path, provider-pool fallback (unavailable / start-throw / probe-fail /
  fetch-throw), Tier-2-never-auto-started, exhaustion + relaysEnabled /
  relayConsent config gates, the consent flow (nonce issuance, wrong-nonce
  rejection, single-use replay, decline cooldown, timeout, cooldown
  suppression across restart, post-grant probe/start failure), the self-heal
  stability gate (reset / progress / switched, counter reset on flap,
  throwaway-probe release, self-healed event), stop semantics (relay-stop
  rotates credentials, plain stop doesn't, pending consent cleared), and
  credential rotation (no-op when not pending, failure retains the flag +
  emits rotation-failed, boot recovery, unwired-rotator loud-clear).
- **`vitest.push.config.ts`** — `tests/unit/TunnelManager.test.ts` REMOVED
  from FLAKY_TESTS (re-armed) with a dated comment. No other entries touched.

## 2. Blast radius

- Zero production code changed — test + CI-config only.
- CI runs 51 additional deterministic tests (~0.8s, no network/timers/
  processes). Risk is future-positive: tunnel-lifecycle regressions now fail
  PRs instead of rotting behind the quarantine.
- Honest overlap note: the rewrite-era sibling suites
  (tunnel-manager-rewrite.test.ts, tunnel-self-heal.test.ts,
  tunnel-consent-state-machine.test.ts, tunnel-credential-rotation.test.ts —
  39 tests, already in CI) cover parts of this surface. The new suite
  consolidates manager-level coverage under the canonical filename and adds
  edge paths they don't exercise (persisted-state restore + corrupted state
  file, concurrent-start coalescing, start-after-exhaustion semantics, nonce
  replay, cooldown suppression across construction, rotation-failure flag
  retention, probe-handle release). Redundancy between them is cheap and
  deliberate.

## 3. Test coverage

- New suite: 51/51 green across three consecutive runs (including under the
  push config — proving the re-arm actually executes it).
- Full tunnel family (11 files incl. the 4 rewrite-era siblings): 165/165.
- `npx tsc --noEmit` clean.
