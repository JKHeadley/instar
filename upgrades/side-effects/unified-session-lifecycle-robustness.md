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

## Commit — P0 ReapAuthority gates + funnel killers #1/#2/#3

**Files:**
- `src/core/SessionManager.ts` — `terminateSession` gains `origin`/`disposition`/`knownDead` opts, a
  lease-holder gate, the mandatory ReapGuard consult, and a single `sessionReaped` emission;
  `setReapGuard()`/`setAwakeChecker()` DI seams. Killers funneled: #1 boot-purge (`knownDead:true`,
  lease-gated), #2 age-limit (inline kill → `terminateSession('age-limit')`), #3 idle-zombie (explicit
  `disposition:'terminal'`).
- `src/server/routes.ts` — `DELETE /sessions/:id` is now async and routes through
  `terminateSession(origin:'operator')` instead of the raw `killSession`.
- `src/commands/server.ts` — shared `reapGuardDeps` back BOTH the SessionReaper and the authority's
  ReapGuard (built `minAgeMs:0`); `setAwakeChecker` wires the lease gate (single-machine ⇒ always awake).

**Implementation decisions with side-effects (reviewed):**
1. **Operator kill bypasses `protected`.** The `protected` check moved *inside* the autonomous-only
   gate block, so an `origin:'operator'` kill is no longer blocked on protected sessions. Risk: an
   operator can now kill a protected (e.g. lifeline) session via the dashboard. Mitigation/justification:
   this *preserves* the prior behavior — the old `DELETE` route used `killSession`, which killed
   unconditionally — and matches the spec's "an explicit human kill must always happen". Autonomous
   reapers remain fully blocked on protected.
2. **`knownDead` bypass for boot-purge.** A `dead` verdict skips the KEEP-guard. Risk: a mis-verdict
   would skip protection. Mitigation: the oracle returns `dead` ONLY on tmux-server-reachable +
   exact-full-id-absent, never on timeout/unreachable/unknown — so `knownDead` is only ever passed for a
   provably-gone session, which has no liveness to protect. Without the bypass, the guard's
   liveness-blind topic-state KEEPs (recent-user-message / open-commitment) would pin a dead record in
   the running list and re-create the boot death-spiral.
3. **`DELETE` route now emits `beforeSessionKill`/`sessionComplete`/`sessionReaped`.** The old
   `killSession` path historically emitted none of these. Effect: resume-UUID listeners now fire on an
   operator kill (beneficial — a manually-killed topic session can be resumed), and the operator kill
   lands in the reap-log (P4). No double-emit: `killSession` is no longer on this path.

**Signal vs authority:** unchanged — killers *request*, the authority decides. The only callers that
may mint `origin:'operator'` are Bearer-authed HTTP routes; in-process killers default to `autonomous`
and so always pass through the gates.

**Re-entrancy:** the guard is consulted before the in-flight (`terminating`) lock is acquired, so the
authority never misreads its own lock as a KEEP (spec §P0 ordering).

**Rollback:** additive per killer; reverting restores the inline kills. P0 gates default to the prior
behavior when `setReapGuard`/`setAwakeChecker` are unset (tests/standalone) — no guard consult, treated
as awake.

**Tests:** terminate (9) + reaper (30) + guard (15) + oracle (15) + timeout (4+6) + async-monitor (6) +
lifecycle integration (6) green; typecheck clean. One brittle source-string test updated to the new
age-kill log + funnel contract.

## Commit — P3 reap-notify seam + P4 reap-log + Agent-Awareness + migration

**Files:**
- `src/monitoring/ReapNotifier.ts` (new) — single coalescing `sessionReaped` listener. Silent on
  `recovery-bounce` and `origin:'operator'`; isolated reap → bound topic (or lifeline); burst within
  the window → ONE consolidated lifeline message stating the EXACT total (count tracked separately from
  the bounded detail buffer, so an overflow never under-reports). User-controlled names/reasons wrapped
  as literal inline-code spans (inner backticks neutralized) so the downstream formatter never renders
  them as markup.
- `src/monitoring/ReapLog.ts` (new) — append-only JSONL audit at `logs/reap-log.jsonl`; records BOTH
  reaps (`sessionReaped`) and refused/skipped terminates (`reapBlocked`); JSON-encoded (no concat →
  no newline injection); read tolerates corrupt lines.
- `src/server/routes.ts` — `GET /sessions/reap-log` (Bearer-auth via router middleware, read-only,
  `?limit` capped at 1000, default 200).
- `src/server/AgentServer.ts` — `reapLog` option + ctx wire (mirrors `sessionReaper`).
- `src/commands/server.ts` — ReapLog + ReapNotifier built and the `sessionReaped`/`reapBlocked`
  listeners + `setAwakeChecker` wired BEFORE the boot purge, so boot reaps are lease-gated, logged, and
  notified. (The KEEP-guard is wired later, after its tracker deps exist — safe: boot-purge bypasses it
  via `knownDead`, and no monitorTick kill can fire in the first seconds.)
- `src/core/types.ts` + `src/config/ConfigDefaults.ts` — `monitoring.reapNotify {enabled, coalesceWindowMs}`,
  default ON.
- `src/scaffold/templates.ts` (Agent-Awareness) + `src/core/PostUpdateMigrator.migrateClaudeMd` (existing
  agents get the Reap-Log section) + `migrateConfig` via ConfigDefaults (existing agents get the
  `reapNotify` default automatically).

**Notify default = ON (deliberate, differs from sentinelTelegramEscalation).** The silently-stopped
sentinel escalation defaults OFF (post-2026-05-22 flood). The reap-notify defaults ON because the
incident this whole spec answers is *silent disappearance* — the user explicitly asked to be told. The
flood risk is bounded by: (a) coalescing a burst into one message, (b) staying silent on the common
recovery-bounce + operator paths, (c) SUMMARY tier (quiet-hours aware). A single config flag disables it.

**Discoverability:** `/sessions/reap-log` lives under the already-classified `sessions` prefix
(operator/dashboard-only in CapabilityIndex) — no new prefix, no lint change. Agent-awareness is carried
by the CLAUDE.md template + migrateClaudeMd instead (the template IS the agent's awareness).

**Ordering side-effect (reviewed):** the listeners attach pre-boot-purge; the guard wires post. The only
guard consumers besides boot-purge are monitorTick #2/#3, which require multi-hour age / 15+m observed
idle — unreachable in the sub-second guard-unset window. Documented inline.

**Tests:** ReapNotifier (10: silent dispositions/origins, isolated bound/unbound routing, burst
coalescing, overflow exact-count, auto-timer, malicious-name literalization, unreachable-channel drop)
+ ReapLog (6: empty, reaped/skipped fields, newline-injection→valid-JSON, tail, corrupt-line tolerance)
green; typecheck clean. Route integration + e2e land in the test-phase commit.

## Commit — P5 unkillability backstop

**Files:**
- `src/monitoring/StaleSessionBackstop.ts` (new) — signal-only. Per-tick forward-progress check; after
  M min of no-forward-progress OR N consecutive indeterminate probes, raises ONE per-episode-deduped
  Attention item (never auto-kills). Forward progress = meaningful transcript advance (≥floor AND new
  tail — guards the heartbeat/loop case) OR main-process CPU OR a prompt/idle-state change. A
  control-plane-unreachable tick raises ONE global item, not one per session.
- `src/core/SessionManager.ts` — `markLongIndeterminate()` + a `longIndeterminateSessions` set excluded
  from the ABSOLUTE `maxSessions × 3` spawn cap (so unverifiable panes can't lock out spawning);
  `probeLivenessBatch()` resolves tri-state liveness + reachability from ONE oracle snapshot.
- `src/core/types.ts` + `src/config/ConfigDefaults.ts` — `monitoring.staleBackstop`, default ON;
  propagates to existing agents via ConfigDefaults.
- `src/commands/server.ts` — backstop wired after the SessionReaper; snapshot built from probeTranscript
  (+ tail-hash read so a heartbeat byte isn't "progress"), captureOutput frame-hash, hasActiveProcesses;
  Attention via makeAttentionPoster.

**Never-auto-kills (structural):** the backstop's deps surface has NO terminate/kill function — it
physically cannot end a session. Asserted by a unit test. It only observes and asks.

**Oracle interaction (reviewed):** with the committed single-snapshot oracle, a session is only
`indeterminate` when the whole snapshot is non-authoritative (server unreachable). So the per-session
indeterminate-streak path is currently reached only under global unreachability (handled by the global
item); the live, reachable path is the M-minute no-forward-progress escalation for ALIVE-but-faking
sessions. The per-session indeterminate code is kept (defensive — correct if the oracle later adds
individual re-probes that return indeterminate while reachable).

**Spawn-cap exclusion:** long-indeterminate sessions are removed from the ABSOLUTE-cap count only; they
still count toward the soft scheduler cap. Cleared the moment a session is verifiable again.

**Tests:** StaleSessionBackstop (10: M-min escalation, no-re-raise-per-episode, heartbeat-not-progress,
meaningful-advance/CPU/prompt-change progress, per-episode re-raise after recovery, global-unreachable
dedup, long-indeterminate flag set+cleared, never-kills structural) green; typecheck clean.
