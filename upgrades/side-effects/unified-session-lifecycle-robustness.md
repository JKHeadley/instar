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
