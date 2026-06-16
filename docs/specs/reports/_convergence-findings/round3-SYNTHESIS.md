# Round 3 — Synthesis (convergence check on round-2 rewrite)
CONVERGED lenses: decision-completeness (0 parked, counts 4/0/1), lessons (No-Deferrals satisfied, §6.4 grounded), scalability (N2/N5 verified CORRECT).
Externals: re-check below.

## NEW material → round-3 fixes
- **R3-2 (adversarial A1 HIGH + scalability) — §4.5 N1 fix was MIS-GROUNDED, simplify.** The crash premise is FALSE for the `Promise.race([tp.evaluate(), timeout])` form the codebase already ships safely (InputGuard precedent, Node-confirmed: race attaches a rejection handler to each input, so a late reject is handled, not unhandled). And `AbortSignal` has NO receiver (no `signal` on IntelligenceOptions; CLI providers `execFile` without it). FIX: use Promise.race (handles late rejection — drop the `.catch`/`unref`/AbortSignal prescription); the REAL subprocess-kill is the CLI providers' EXISTING `timeoutMs→SIGTERM` (wired on all 4 CLI providers) — pass a tight per-attempt `timeoutMs` so the provider self-terminates its subprocess at the cap. Simpler, reuses shipped primitives, no new engine API.
- **R3-1 (security R3-S2 MEDIUM) — §4.6 memoized resolveConfig DECOUPLES from CartographerSweep live override.** CartographerSweep mutates config.sessions.componentFrameworks live (server.ts:~11268) to inject its own routing; a memoized computed-default resolveConfig that ignores the live object silently makes the freshness sweep refuse-to-author on every default-policy agent. FIX: resolveConfig reads LIVE each call; when operator didn't set componentFrameworks at boot, return the computed default MERGED UNDER any live in-memory componentFrameworks (a live override — CartographerSweep's component override — still wins for its component). Memoize only the active-framework SET, not a frozen config object.

## Precision (fold in)
- R3-3a (integration) — §8 migrateClaudeMd marker must NOT contain the literal `pi-cli` token (collides with the pi-cli migration guard at PostUpdateMigrator.ts:5525). Use "run off Claude by default". (Already the primary; add an explicit warn-off.)
- R3-3b (integration) — §5 state swapAttemptTimeoutMs is INLINE-defaulted, no ConfigDefaults/migration entry (codexExecJson precedent).
- R3-4 (scalability + conformance Observability) — a timed-out swap attempt emits a distinct onDegrade reason (machine-readable, e.g. `swap-attempt-timeout: <target>`) so the cap firing is visible in DegradationReporter + /metrics/features.
- R3-5 (security R3-S1 LOW) — minor test-design refinement, fold into §7.
