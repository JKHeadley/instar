# Side-Effects Review — Unified Session-Lifecycle Robustness (implementation)

Spec: `docs/specs/unified-session-lifecycle-robustness.md` (converged 3 iterations, approved by Justin
topic 2169). Full adversarial/standards review in
`docs/specs/reports/unified-session-lifecycle-robustness-convergence.md`. This artifact tracks the
side-effects of the *implementation* commits as they land.

## Commit 1 — P1 SessionLivenessOracle + boot-purge fix

**Files:**
- `src/core/SessionLivenessOracle.ts` (new) — tri-state liveness oracle.
- `src/core/SessionManager.ts` — lazy oracle field + `setLivenessOracle()` DI seam; `purgeDeadSessions()`
  rewired to use the oracle (purge only on `dead`, keep on `indeterminate`/`alive`).
- `src/core/types.ts` — added optional `liveness?: Partial<SessionLivenessOracleConfig>` to
  `SessionManagerConfig`.
- `tests/unit/session-liveness-oracle.test.ts` (new, 15 tests) — incident fix (timeout→indeterminate),
  exact-id match, cache, retry, boot-cap, coalescing, config floors.
- `tests/unit/death-spiral-fixes.test.ts` — purge suite rewritten to oracle semantics + the 2026-05-27
  incident reproduction (timing-out tmux at boot → 0 purges).

**What changes behaviorally:** the boot purge no longer treats a slow/timing-out/unreachable
`tmux` probe as "dead." It resolves liveness from a single `tmux list-sessions` and purges ONLY when
the server is reachable AND the exact session id is absent. A timeout/unreachable result is
`indeterminate` → the session is KEPT and re-verified on the next monitoring tick.

**Over-block risk (a live session wrongly purged):** eliminated for the timeout case — the root cause
of the incident. Residual: a name-collision could in theory hide a live session, but matching is
exact-full-id against `list-sessions` output, not prefix/substring.

**Under-block risk (a dead session lingers):** bounded — a genuinely dead session absent from a
reachable `list-sessions` is still purged immediately. Only the *unverifiable* case lingers, and only
until the next tick (cheap). The §P5 backstop (later commit) escalates a permanently-unverifiable
session to the Attention queue so it can never leak forever or fill the spawn cap.

**Death-spiral (the original purge's reason for existing):** preserved and improved. The oracle is
async (never `execFileSync` on boot), resolves the whole set from ONE `list-sessions`, retries once
with backoff, and is bounded by a total boot-cap (default 8s) — on cap it returns `indeterminate`
rather than blocking boot. So conservatism does not re-introduce startup-blocking latency.

**Signal vs authority:** the oracle is pure-data (tier0) — it only *reports* alive/dead/indeterminate;
it never kills. The kill decision stays with `terminateSession()` (the authority, wired in a later
commit). No new kill authority is introduced here.

**Migration parity:** the oracle is server-side TS (ships with the server, no migrator needed). The new
`liveness` config block is optional (`Partial`), defaults applied in-code via `DEFAULT_LIVENESS_CONFIG`;
a `migrateConfig` entry + startup validation (`validateLivenessConfig`, rejects a sub-floor timeout)
land with the config-wiring commit.

**Rollback:** additive. Reverting the `purgeDeadSessions` change restores the old behavior; the new
module is unreferenced if the field/getter are removed. The DI seam (`setLivenessOracle`) is test-only
surface with no production caller.

**Tests:** 15 (oracle) + 14 (purge/death-spiral) green; typecheck clean. Reproduce-before-claim for
the live boot scenario is owed before declaring the incident fixed end-to-end (E2E tier, later commit).

## Commit 2 — P2 ReapGuard (stateless KEEP-guards extracted from SessionReaper)

**Files:**
- `src/core/ReapGuard.ts` (new) — `reapBlockedReason(session)` over the stateless guards: protected,
  spawn-grace (parameterized minAgeMs), recovery-in-flight, pending-injection, relay-lease,
  recent-user-message, open-commitment, active-subagent, structural-long-work, active-process,
  main-process-uninspectable/active. Cheap-first ordering; safe-by-default (a throwing signal →
  KEEP 'guard-error', never reap).
- `src/monitoring/SessionReaper.ts` — `evaluate()` now calls the shared guard first, then layers its
  STATEFUL checks (transcript-growth via per-instance `obs`, positive-idle via captured frame). Guard
  built in the constructor from the reaper's deps + cfg.
- `tests/unit/reap-guard.test.ts` (new, 15 tests) — both sides of every guard, cannot-inspect→KEEP,
  cheap-first ordering, throwing-signal→KEEP.
- `tests/unit/session-reaper.test.ts` — one label assertion updated ('eval-error'→'guard-error') for
  the throwing-stateless-signal case; the KEEP-never-reap behavior is unchanged and still asserted.

**Parity:** SessionReaper's 30 existing tests all pass post-extraction — the `keptBy` reasons are
identical for every extracted guard (the spec's required wiring/parity check). Only the diagnostic
label for a *throwing* stateless signal moved (the guard now catches it as 'guard-error' rather than
letting it propagate to the reaper's outer 'eval-error' catch — a safer default for the shared guard;
the reaper's outer catch remains live for throws in the stateful checks).

**Behavioral change:** none for the reaper (parity). The guard is not yet consulted by
`terminateSession` — that wiring is P0 (next commit). So no other killer's behavior changes yet; this
commit is a pure, parity-verified extraction.

**Signal vs authority:** the guard is a pure predicate (no kill power) — it only *reports* a KEEP
reason. The authority (terminateSession) decides; wired in P0.

**Rollback:** additive. Reverting restores the inlined guards in `evaluate()`; `ReapGuard.ts` is
unreferenced if the reaper's guard field + call are removed.

**Tests:** 15 (guard) + 30 (reaper parity) + 4 (wiring) green; typecheck clean.
