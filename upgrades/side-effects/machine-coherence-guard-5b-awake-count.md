# Side-Effects Review — machine-coherence-guard §5b: lease-live `awakeMachineCount`

**Version / slug:** `machine-coherence-guard-5b-awake-count`
**Date:** `2026-07-04`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/machine-coherence-guard.md` §5b (converged 2026-07-03, approved)
**Second-pass reviewer:** not-required (Tier 2; a read-only telemetry-derivation fix — no gate, no demotion authority, no mutation)

## Summary of the change

`/health.multiMachine.syncStatus.awakeMachineCount` reported **0** while both the
Laptop and the Mac Mini were online and the Mini correctly held the lease
(`leaseHolder` named the Mini). Root cause, confirmed in code: `getSyncStatus()`
derived the count SOLELY by counting `registry.machines[].role === 'awake'` rows
(`MultiMachineCoordinator.ts`) — a git-synced SYMBOL that lags the authoritative
lease and that a dead Cloudflare rope or a slow registry push can leave stale — so
it read 0 even though the lease (the same signal `leaseHolder` uses) named the
holder. The multi-transport hedge was NOT the wedge: it carries the lease over the
healthy Tailscale/LAN ropes (that is why `leaseHolder` was correct). The count
simply consulted the wrong source. This implements the spec's already-designed
§5b remedy: derive the count from LIVE lease observations, source-tagged and
honest.

Files modified:
- `src/core/LeaseCoordinator.ts` — new `deriveLiveAwakeCount(staleMs)`: `(self
  holds ? 1 : 0)` + distinct peers whose most-recent observation is FRESH, LIVE
  (not expired on our clock), and a SELF-CLAIM (`lease.holder === peerId`). The
  per-peer observation seam (`peerLeaseObservations()` / transport `observedByPeer()`)
  already existed; this wires the counting rule onto it. Advisory only.
- `src/core/MultiMachineCoordinator.ts` — `getSyncStatus()` rewritten to prefer
  the lease-live basis (when a lease coordinator with pull capability is attached),
  degrade to the registry-role basis on a git-only mesh, and yield `null` on a read
  failure; a new `leaseObservationStaleMs()` (3× lease-pull interval, floor 30s).
  `MultiMachineSyncStatus.awakeMachineCount` becomes `number | null` and gains
  `awakeMachineCountSource: 'lease-live' | 'registry-roles' | 'unavailable'`.
  `splitBrainState` now null-safely reads `count > 1` (degrades to the pull-contest
  latch alone when the count is null).
- `src/server/routes.ts` — `/pool` router block carries `awakeMachineCountSource`
  (`/health` spreads the whole object, so it flows automatically).
- `src/commands/machine.ts` — `instar doctor` labels the registry-role check as a
  "may-lag" VIEW and, when the server is reachable, adds a **Live lease view**
  check that prints the authoritative count + source and names any divergence.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — the two deployed
  CLAUDE.md mentions updated to the new shape (Agent Awareness + Migration Parity).

Tests: `tests/unit/multimachine-awake-count-lease-live.test.ts` (new; the
load-bearing "Cloudflare dead, Tailscale/LAN alive, Mini holds lease → count 1
lease-live, NOT 0" case plus stale/expired/hearsay/no-lease/registry-fallback/
unavailable), updated `tests/unit/multimachine-syncstatus.test.ts`,
`tests/integration/pool-routes.test.ts` (+ two other mocks), and an extended
`tests/e2e/multi-machine-lease-split-brain.test.ts` (lease-live convergence).

## Roll-up across the seven review dimensions

1. **Over-block**: none. Nothing is blocked, delayed, or rewritten — this is a
   read-only observability derivation. It NEVER drives a demotion (demotion
   authority stays exclusively with the strictly-higher-epoch supersede gate and
   the operator flow), so it cannot mis-fence a healthy holder.
2. **Under-block**: none. Genuine split-brain is still detected: `count > 1` OR
   the pull-contest latch → `splitBrainState: 'contested'`. The freshness (3×
   pull-interval), liveness (not-expired), and self-claim (no third-machine
   hearsay) gates prevent both over- and under-count.
3. **Level-of-abstraction fit**: correct. The count derivation lives in
   `LeaseCoordinator` (where the lease/clock/expiry logic already lives) behind a
   pure method; `getSyncStatus()` only chooses the basis and tags it.
4. **Signal-vs-authority compliance**: fully signal-only. Peer lease claims are
   self-asserted advisory data (L4/SEC-4); the count feeds dashboards + the
   existing human-decision attention flow, never an automatic action. No silent
   fallback: each `catch` yields an honest `null`+`'unavailable'` (tagged
   `@silent-fallback-ok` as a read-only health field), never a fabricated 0.
5. **Interactions**: the `MultiMachineSyncStatus` shape change (`number → number |
   null` + source tag) is swept across every consumer — `/health`, `/pool`, the
   two other route callers (leaseHolder-only, unaffected), the unit/integration/e2e
   fixtures, `instar doctor`, and both CLAUDE.md templates. `splitBrainState`'s
   three in-code consumers (ingress suppression, speaker-election, rope-health
   `splitBrainItemOpen`) keep their exact semantics.
6. **External surfaces**: none added. No new network path, no new egress. `instar
   doctor` adds a Bearer'd localhost `/health` read (the same host it already
   contacts) to fetch the live count.
7. **Rollback cost**: low. Additive method + a localized `getSyncStatus()` rewrite;
   revertable in one commit. No persistent state, no migration data. The
   `registry-roles` basis remains as the automatic git-only-mesh degrade (there is
   deliberately no config lever back to the old always-registry behavior — that
   would preserve the documented defect).

## Clock assumption

Lease liveness (`expiresAt` vs now) is judged on the OBSERVER's clock. A
clock-drifted machine could misjudge a peer lease's expiry and skew its own
published count; the mesh's existing per-peer clock-skew gate
(`MachinePoolRegistry`) marks a divergent machine placement-ineligible, and the
freshness bound caps how long any one misjudged observation can distort the count.
The count inherits the mesh's clock-sanity envelope rather than adding its own.

## Evidence pointers

- `npx tsc --noEmit` — clean.
- `npm run lint` — exit 0 (all ratchets green, including no-silent-fallbacks).
- `npm run build` — exit 0.
- `npx vitest run tests/unit/multimachine-awake-count-lease-live.test.ts` — 8/8
  pass (load-bearing Cloudflare-dead case asserts count 1 + `lease-live`, NOT 0).
- `npx vitest run` across the mesh/lease suites (MultiMachineCoordinator-leasePull,
  multi-machine-coordinator, HttpLeaseTransport, multimachine-syncstatus,
  lease-contested-resolution, pool-routes, multi-machine-lease-split-brain) — all
  green (59 + 9 pass).
