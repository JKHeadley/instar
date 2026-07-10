# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Unified Self-Action Backpressure, Increment B (docs/specs/unified-self-action-backpressure.md; the normative companion `unified-self-action-backpressure.companion.md` is the implementation authority; CMT-1911/CMT-1928). ONE in-process admission chokepoint — the `SelfActionGovernor` (`src/monitoring/selfaction/`) — that every registered self-triggered action rides via `admit()`: per-target + census-scaled total count ceilings (fixed-bucket sliding windows, no epoch reset for relief classes), token-bucket rate ceilings, P19 brakes, a bounded coalescing queue with drain-time re-validation (incarnation fence + eligibility predicate), single-consume capability tokens (runtime consume at the sink is the authority), an ALWAYS-ALLOW audited principal lane (a human action always wins; PIN-distinguishable from bare Bearer at the operator kill routes), durable admission state that survives restarts (event-aware eager flush — a crash-loop bouncing faster than the flush debounce still accretes the floor), and a per-class fail matrix (cost/safety fails CLOSED-to-QUEUE; relief fails OPEN-with-audit paced by a config-immune last-resort floor; respawn-recovery fails OPEN unconditionally).

**Ships OBSERVE-ONLY on every class, fleet-wide (FD1):** admit() records would-deny verdicts and blocks NOTHING. The per-class enforce flip is the operator's later deliberate action (FD8), and pool-shared classes (swap/notify) additionally auto-demote whenever the registered machine count exceeds one (FD9) — no pool-shared enforce exists in this increment. The retrofit is ADDITIVE: none of the incident-earned bespoke brakes (AgeKillBackoff, swap anti-thrash, beacon suppression, the external-hog kill ledger) is removed or weakened.

Retrofitted in this increment: the five registry-modeled controllers — the age-limit kill path (SessionManager), the proactive account swap (ProactiveSwapMonitor, braked + legacy paths), the PromiseBeacon progress heartbeat + liveness line (two controllers, one file), and the external-hog kill path (ExternalHogScanTick). Remaining emit sites land as staged follow-up PRs <!-- tracked: CMT-1911 -->.

Enforcement tooling: a new codebase-wide usage-scan lint (`scripts/lint-emit-without-admit.js`, wired into `npm run lint`) binds controller identity at registration + sink (marker↔file↔registry `modelsPath` licensing, no dynamic ids, no handle export/pass-as-value, principal API import-restricted, admit targets must be canonical `deriveTargetKey` derivations). Observability: `GET /self-action-governor` (lock-free scrubbed read; `?scope=pool` merges pool-shared class counters), a GUARD_MANIFEST entry with synthetic enabled-polarity posture (`intelligence.selfActionGovernor.enabled` computed from the inverted kill-switch), three COHERENCE_CRITICAL_FLAGS rows (inverted governor row + live-read pool-shared class-mode rows via a governor-state accessor on the advert view), a transitions-only audit stream, and six Standard-B operator notices (demote-exhaustion alarm, coalesced dead-letter shed, errored-posture alarm, emergencyDisable flip, principal volume page, observe-limbo nudge). Config: `intelligence.selfActionGovernor` (live-read `emergencyDisable` kill-switch + sparse per-class overrides, validated at load); the PATCH /config path gets a nested-path validator scoped to exactly that subtree with deep merge, and the DISABLE direction is dashboard-PIN-gated.

## What to Tell Your User

- I now measure every self-triggered action I take — session cleanups, account swaps, my own status notices — against one shared safety meter, the same way my process spawns are already capped. Nothing is blocked yet: this ships in watch mode, gathering evidence first.
- If you ever wonder why a cleanup was held or a swap was queued once enforcement is turned on class by class, I can name the exact rule that decided it — nothing is silently dropped.
- Your actions always win: an emergency stop or a kill you order rides an always-allowed lane that the meters can never pace.
- There is one master off switch for the whole brake, and flipping it is loud on purpose — you get told, because a disabled safety brake is itself an incident.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Self-action admission posture (per-class modes, counters, deciding-layer reasons) | `GET /self-action-governor` (Bearer); `?scope=pool` for pool-shared classes across machines |
| Guard posture visibility | `GET /guards` row `intelligence.selfActionGovernor.enabled` (synthetic enabled polarity; load-bearing) |
| Machine-coherence mode-skew alarm inputs | advert rows `selfActionGovernor.emergencyDisable` + per-class `…mode` (live-read) |
| Kill-switch + per-class overrides | `intelligence.selfActionGovernor.emergencyDisable` (live-read) / `…classes.<id>.*`; PATCH /config nested validator (disable direction PIN-gated) |
| Usage-scan lint | `node scripts/lint-emit-without-admit.js` (in `npm run lint`) |

## Evidence

- Tier 1: `tests/unit/self-action-governor.test.ts` (34 tests — admission battery, fail matrix, census, tokens, queue, demote latch, FD9 gate), `self-action-governor-snapshot.test.ts` (8 — durable floor across bounces incl. sub-debounce crash-loop), `self-action-governor-anchor.test.ts` (5 — dual-load collision + attach), `self-action-token-coverage.test.ts` (9 — sink inventory), `lint-emit-without-admit.test.ts` (15 — every lint rule + the real tree passes clean), and the generalized convergence ratchet (`self-action-convergence.test.ts` now drives every registered controller through the governor in enforce mode).
- Tier 2: `tests/integration/self-action-governor-route.test.ts` (10 — real routes pipeline, lock-free pure read, scrubbed projection, pool scope, nested PATCH validator + PIN gate both directions).
- Tier 3: `tests/e2e/self-action-governor-alive.test.ts` (4 — production init path serves 200 with live counters; guard-posture + coherence view-seam wiring integrity).
- Observe-only safety: every retrofitted emit path verified byte-equivalent in behavior under observe mode (admit always allows; sink guards proceed); full regression sweep over PromiseBeacon / SessionManager / ProactiveSwapMonitor / external-hog / coherence-manifest / capability suites green.
