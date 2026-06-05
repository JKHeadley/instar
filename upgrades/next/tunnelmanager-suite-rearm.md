<!-- bump: patch -->

## What Changed

The last knowingly-stale entry from the 2026-06-05 test-debt triage is
resolved: the TunnelManager unit suite — parked in the CI skip-list because it
predated the tunnel provider/tier rewrite (22 of its 29 tests could never
pass) — has been rewritten against the current architecture and turned back
on. The tunnel layer's core lifecycle is now gated in CI at the manager level:
provider-pool fallback, the reachability probe, the owner-consent flow for
backup relays (including the single-use nonce and the decline cooldown), the
self-heal stability gate, and mandatory credential rotation after a relay
episode.

## What to Tell Your User

Nothing user-visible. This hardens the safety net around the tunnel/backup-
relay machinery your dashboard links depend on — regressions in that
machinery now fail PRs instead of shipping.

## Summary of New Capabilities

- `tests/unit/TunnelManager.test.ts` runs in CI again (removed from the
  vitest.push.config.ts quarantine): 51 deterministic tests driven entirely
  through the constructor injection seams (`injections.providers`,
  `injections.fetch`) and the public deterministic drivers
  (`runSelfHealCheck()`, `grantConsent()`, `declineConsent()`) — no real
  timers, processes, or network.
- Maturity: stable (test-only change + quarantine re-arm; no production code
  touched).

## Evidence

Three consecutive green runs (51/51, ~0.8s each), including under the push
config; the full 11-file tunnel test family passes together (165/165);
`npx tsc --noEmit` clean. The rewrite-era sibling suites
(tunnel-manager-rewrite / tunnel-self-heal / tunnel-consent-state-machine /
tunnel-credential-rotation) already covered parts of this surface — this
suite consolidates the manager-level coverage, adds the previously-untested
edge paths (persisted-state restore, corrupted state file, nonce replay,
cooldown suppression across restart, rotation-failure flag retention,
probe-handle release), and retires the stale file that occupied the
canonical TunnelManager.test.ts name.
