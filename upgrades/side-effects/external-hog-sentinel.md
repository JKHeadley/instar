# Side-Effects Review — External-Hog Zombie Auto-Kill Sentinel

Spec: `docs/specs/external-hog-zombie-autokill-sentinel.md` (CMT-1901, converged 11 rounds, approved by operator 2026-07-03).
Build branch: `echo/external-hog-sentinel` off `JKHeadley/main` @ v1.3.748.
Tier: **2** (safety-critical, irreversible action — process kill).

## Phase 1 — Principle check (signal vs authority)

**Does this change involve a decision point?** YES — it gates an irreversible action
(killing an external OS process).

**Compliance:** The design is signal-vs-authority-COMPLIANT and this was the single
most-reviewed axis across 11 rounds. Split of authority:
- The **mechanical safety floor** is a VETO-ONLY hard-invariant guard on an
  irreversible action — the allowed "brittle blocker" class (a hard invariant guarding
  an irreversible action, per `docs/signal-vs-authority.md`). It can only ever BLOCK a
  kill (downgrade to alert); it can never trigger one.
- The **LLM classifier** holds the judgment authority (the smart gate) — kill/leave/
  alert — fed the deterministically-computed facts. Its authority is purely
  SUBTRACTIVE: `kill executes iff floor_pass && classifier === 'kill'`.
- The **observability floor** is a signal producer: every confirmed sustained hog that
  is not killed is surfaced; the model cannot suppress it.

This is the correct shape: brittle deterministic logic produces hard vetoes + signals;
the intelligent full-context gate makes the judgment call. Adding blocking authority to
a brittle check is exactly what the design AVOIDS — the floor never authorizes, only
refuses.

## Phase 2 — Plan (build location + interactions)

- **Build location (re-grounded):** FRESH worktree off `JKHeadley/main` @ **v1.3.748**
  (the agent-home checkout was 243 commits behind — building here would be stale). git
  remote = JKHeadley; per-worktree identity set by `instar worktree create`.
- **Re-grounding against master (all confirmed present):** `resolveOwningSession(pid,
  tree, tmuxPaneMap, maxHops)` (McpProcessReaper.ts:111); `parseProcTimeToSeconds`
  (SessionManager.ts:201) — the load-bearing parser to register in `SCRAPE_PARSERS`;
  `devGatedFeatures.ts` with `credentialRepointing` (the Posture-A precedent) + the
  sibling destructive killers `sessionReaper`/`agentWorktreeReaper`/`mcpProcessReaper`
  (DARK_GATE_EXCLUSIONS); `migrateDevGateTeethStrip` (PostUpdateMigrator.ts:1353,
  "Allowlist is HARDCODED"). `zombie-classify.json` benchmark brought into the branch
  (was not in master).
- **Interactions:** de-conflict with McpProcessReaper + SessionManager (exclude their
  pids from discovery + kill), suppress OrphanProcessReaper's legacy external-report for
  in-lane pids; ride the shared LlmQueue background lane + hostSpawnCap; wire into
  guard-posture + the Guard-Posture Tripwire.
- **Rollback path:** ships dev-gated dark-on-fleet + `dryRun:true` (kills nothing);
  live killing requires the PIN arm route. Back-out = disarm route (writes dryRun:true +
  invalidates the marker) or config `enabled:false`; no data migration; feature removal
  leaves inert leftover state (sampler snapshot, kill ledger, audit log).

## Phase 4 — Side-effects review (per-question)

_(Filled in progressively as slices land; this baseline commit is the spec + benchmark
+ plan artifacts brought into the branch — no runtime `src/` change yet.)_

1. **Over-block:** N/A for the baseline; the runtime design over-blocks toward NOT
   killing (every uncertainty → alert-never-kill), which is the safe direction.
2. **Under-block:** the narrow v1 allowlist deliberately does NOT auto-kill non-exthost
   hogs (they are surfaced, not killed) — an accepted, evidence-gated scope.
3. **Level-of-abstraction fit:** owns its own uid-scoped host-process discovery because
   the existing OrphanProcessReaper is structurally blind to the target class
   (framework-needle pre-filter). Correct layer.
4. **Signal vs authority:** compliant (Phase 1).
5. **Interactions:** de-conflicted (Phase 2).
6. **External surfaces:** new `GET/POST /external-hog*` routes (Bearer/PIN-authed);
   coalesced Telegram notice on the deterministic delivery path; guard-posture row.
7. **Multi-machine posture:** machine-local BY DESIGN (`hardware-bound-resource` — a host
   OS process is bound to one kernel); cross-machine visibility via each machine's own
   `GET /external-hog` + pool-scope `/guards`. Confirmed correct by review.
8. **Rollback cost:** low — disarm route / config flip; no migration.

## Slice log

### Slice 2 — config schema + dev-gate registration
Files: `src/core/types.ts` (the `externalHogSentinel?` interface), `src/config/ConfigDefaults.ts`
(defaults — `enabled` OMITTED, `dryRun: true`, all kill-gate knobs), `src/core/devGatedFeatures.ts`
(DEV_GATED_FEATURES entry with the credentialRepointing-style justification),
`tests/unit/external-hog-sentinel-config.test.ts`.
- **Side effects:** NONE at runtime — this slice adds a DORMANT config block + a registry
  entry. No code consumes it yet, so no behavior changes on any agent. It resolves the
  §7/§8 obligation that `enabled` be omitted (dev-gate) + registered in DEV_GATED_FEATURES
  (the #1001 wiring guarantee — auto-covered by `devGatedFeatures-wiring.test.ts`, 151 pass).
- **Over/under-block:** N/A (no decision logic yet).
- **Signal vs authority:** N/A (config only).
- **Multi-machine:** config is machine-local; the feature's posture is `hardware-bound-resource`.
- **Tests:** 6 focused (dev-gate live/dark, dryRun canary on both, enabled-omitted, all
  defaults, the `maxClassificationsPerScan < hostSpawnCap` invariant) + the 151-test wiring
  suite. Typecheck clean.

### Slice 3 — deterministic safety floor (the veto-only kill envelope)
Files: `src/monitoring/ExternalHogFloor.ts` (the `ExternalHogFacts` type, the code-defined
`EXTERNAL_HOG_ALLOWLIST` + `matchAllowlistClass`, and `evaluateKillFloor` — the pure
veto-only predicate), `tests/unit/external-hog-floor.test.ts` (24 tests).
- **Over-block:** the floor fails CLOSED — any unknown invariant (unknown uid, missing
  field) → NOT permitted → alert. It "over-blocks" toward NOT killing, which is the correct
  safe direction for an irreversible action. It does not reject any legitimate KILL that a
  real orphaned in-envelope zombie would need (the anchor case permits).
- **Under-block:** the floor is a NECESSARY, not sufficient, condition — it never authorizes
  a kill on its own (the caller must ALSO have `classifier==='kill'`). It cannot under-block
  a kill because it only ever removes kills.
- **Level-of-abstraction fit:** pure function over a normalized fact set; the discovery/
  sampler layer computes the facts, the floor evaluates them, the caller ANDs with the model
  verdict. Correct separation.
- **Signal vs authority:** COMPLIANT — this is the hard-invariant guard on an irreversible
  action (the allowed brittle-blocker class). It holds VETO authority only; the model holds
  the judgment. It can only BLOCK a kill, never trigger one (structurally: the return type is
  permit-or-veto, and the only `permitted:true` path requires every invariant to pass).
- **Interactions:** the allowlist is code-defined (not config), so no runtime widening;
  instar-own exclusion is checked first (defense-in-depth vs the discovery-layer exclusion).
- **Multi-machine:** pure logic, no state — N/A.
- **External surfaces:** none — no I/O, no routes, no messages. Dormant until a runtime
  consumer wires it (later slices).
- **Rollback:** delete the module; nothing consumes it yet.
- **Tests:** 24 — allowlist match (name+token, attacker-name inert, anchored regex), the
  anchor permits, EVERY invariant load-bearing (instar-own, other-uid, root-euid, unknown-uid,
  root-daemon, launchctl, live-parent, not-sustained, outside-allowlist ×2), and the 8
  zombie-classify cases as floor fixtures (permits only the exthost-kill case). Typecheck clean.

### Slice 4 — CPU-delta signal core (monotonic clock, fail-closed)
Files: `src/monitoring/ExternalHogCpuDelta.ts` (`monotonicNowMs`, `computeCoreEquivalents`,
`meetsThreshold`, the `CPU_DELTA_UNKNOWN` sentinel), `tests/unit/external-hog-cpu-delta.test.ts`
(12 tests).
- **What it is:** the pure `Δcputime / Δwall` core-equivalents computation feeding the
  `sustainedHighCpu` floor invariant. Δwall is a MONOTONIC clock (sleep-paused, NTP-immune).
- **Over/under-block:** it produces a SIGNAL, not a decision — it never kills. Its only
  safety obligation is to never produce a FALSE "sustained hog" (which the floor would then
  treat as a passing invariant). It fails CLOSED: non-positive Δwall, implausibly-large Δwall
  (a sleep slipped through), a decreasing counter (pid reuse), or any non-finite input →
  `CPU_DELTA_UNKNOWN`, and `meetsThreshold(UNKNOWN, …) === false` — so an unknown reading is
  NEVER a confirmed hog. It cannot over-report an idle process as sustained.
- **Signal vs authority:** signal-only; feeds the deterministic floor. Compliant.
- **Multi-machine:** pure logic, no state — N/A.
- **External surfaces:** none — no I/O, no subprocess (the actual `ps` sampling is a later
  slice; this is only the delta math over samples).
- **Rollback:** delete the module; nothing consumes it yet.
- **Tests:** 12 — core-equiv math (2 cores / idle / 1 core), fail-closed on every implausible
  interval (backward/same-instant Δwall, 3h-sleep Δwall, decreasing counter, NaN/Infinity),
  jitter tolerance within the factor, `meetsThreshold` (UNKNOWN never a hog), monotonicity.

### Slice 5 — armed-marker gate (the doubly-held "can this kill" logic)
Files: `src/monitoring/ExternalHogArmMarker.ts` (`classContentHash`, `isMarkerValid`,
`classIsArmed`, `canKillLive`), `tests/unit/external-hog-arm-marker.test.ts` (16 tests).
- **What it is:** the second key holding a LIVE kill (beyond enabled && !dryRun) — a valid
  PIN-written marker with the arm-epoch lifecycle + the per-class content-hash arm-scope.
- **Signal vs authority:** pure authorization predicate; never kills. Fails CLOSED on any
  missing/invalid input (no marker, non-finite epoch, dryRun:true, disarmed).
- **Security properties (round-9 review, now in code):** (1) armEpoch > lastDisarmEpoch — a
  disarm can never be silently un-done; `disarm→config dryRun:false→restart` boots UNARMED;
  config.dryRun:false is NEVER a positive arm. (2) per-class content-hash — new/broadened
  class → not armed → alert-only until PIN re-arm; unrelated class add doesn't disarm others.
- **External surfaces:** none yet (the arm/disarm ROUTES that write the marker are a later
  slice); this is the pure predicate they'll consume. Multi-machine: pure logic.
- **Rollback:** delete the module; nothing consumes it yet.
- **Tests:** 16 — content-hash determinism/change-sensitivity/order, epoch validity + the
  disarm-restart-bypass-closed, per-class armed/new/broadened/unrelated, canKillLive doubly-
  held (dryRun-never-kills, bare-config-flip-never-arms, enabled:false, unarmed class).

### Slice 6 — P19 loop brakes (kill-ledger + respawn breaker + in-flight set)
Files: `src/monitoring/ExternalHogKillLedger.ts` (`recordKill`, `isBreakerTripped`,
`killCountInWindow`, `shouldEvictInFlight`, `isInFlight`), `tests/unit/external-hog-kill-ledger.test.ts` (14 tests).
- **What it is:** the pure state machines that STOP a kill-respawn loop (#863). After K kills
  of the same respawn-surviving key in a rolling window → breaker trips (stop killing +
  surface). A VOLATILE key falls back to a CLASS-level breaker (a per-volatile-key count could
  never accumulate). The in-flight set stops re-killing a SIGTERM'd pid; eviction on confirmed
  exit or the TTL.
- **Safe direction:** for a LOOP BRAKE the safe failure is TRIP (stop killing) — a non-finite
  window/now returns tripped rather than risk an unbounded loop. The breaker shields same-key
  hogs from KILL only, never from the §4 observability floor.
- **Bounded:** `recordKill` prunes past the retention bound so the durable ledger can't grow
  without limit. In-flight eviction (confirmed-exit OR ttl, ~3×sigtermGrace) prevents a leak
  and prevents re-killing a mid-write LS early.
- **External surfaces:** none yet (durable persistence + the actual kill are the caller's);
  pure logic. Multi-machine: machine-local (the kill ledger is per-machine).
- **Rollback:** delete the module; nothing consumes it yet.
- **Tests:** 14 — append+prune, per-key breaker (trip at K, ignore out-of-window, a decoy
  can't shield another key), volatile→class fallback, safe-trip on bad window inputs, in-flight
  detect + pid-reuse distinction + TTL/confirmed-exit/non-finite eviction.

### Slice 7 — instar-own exclusion (ancestry walk, start-time-aware, own-root fallback)
Files: `src/monitoring/ExternalHogOwnership.ts` (`isInstarOwned` over a ProcTree snapshot),
`tests/unit/external-hog-ownership.test.ts` (11 tests).
- **What it is:** the pure ancestry walk that EXCLUDES a candidate whose chain reaches a
  start-time-verified instar-owned pid (tmux pane OR own-root), so own busy build children
  (vitest/tsc) aren't flagged as hogs. Extends resolveOwningSession with per-hop start-time.
- **Dangerous direction:** a false "owned" would HIDE a real external hog. That requires a
  start-time MATCH on an owned pid, so an external hog can't fake it. INCLUDE-on-uncertainty
  (anti-evasion): an unresolvable edge / cycle / hop-bound → NOT owned (candidate stays);
  instar-own KILL protection is carried by reparent-to-pid-1 + the §4 allowlist floor, not
  this walk — so INCLUDE-on-uncertainty costs only observability noise, never a wrong kill.
- **Signal vs authority:** produces a candidacy signal; never kills. Multi-machine: pure.
- **External surfaces:** none yet (the ps read that builds the tree + the owned-pid set are a
  later I/O slice). Rollback: delete; nothing consumes it yet.
- **Tests:** 11 — direct/deep/self owned; genuine orphan (ppid 1) not owned; start-time
  defeats pid reuse (reused number ≠ owned, matching start-time excludes); unresolvable edge
  / cycle / hop-bound → not owned; invalid inputs → not owned.

### Slice 8 — P17 notice coalescer (notification bounding)
Files: `src/monitoring/ExternalHogNoticeCoalescer.ts` (`coalesceNotices`),
`tests/unit/external-hog-notice-coalescer.test.ts` (9 tests).
- **What it is:** the pure P17 selection logic — one coalescing chokepoint over all notice
  classes (kill / decider-unavailable / floor-veto-downgrade / hog-left-alive) with
  per-signature dedup, a per-window budget, severity ordering on exhaustion, and live KILLS
  always piercing the budget. It NEVER kills — it selects which NOTICES to emit vs drop.
- **Signal vs authority:** notification bounding, NOT a kill/block decision. The safety-
  critical second-pass (kill logic) does not apply; the risk is bounded (worst case: a dropped
  LOW-severity notice — a kill notice can never be dropped, and dedup prevents a flood).
- **Multi-machine:** pure, machine-local (notices are per-machine). External surfaces: none
  yet (the actual delivery + window state are the caller's).
- **Rollback:** delete; nothing consumes it yet.
- **Tests:** 9 — dedup (in-batch, vs-window, different-class-not-deduped), budget + severity
  ordering (keeps highest severity, reports dropped-by-class), kills-always-pierce, robustness
  (zero/negative/NaN budget, malformed notice ignored, empty batch).

### Slice 9 — ps whole-table parser + realness fixture (load-bearing, SCRAPE_PARSERS)
Files: `src/monitoring/ExternalHogProcTable.ts` (`parseProcTable`),
`tests/unit/external-hog-proc-table.test.ts` (5 tests), the captured fixture
`tests/fixtures/captured/ps-proc-table/{table.txt,table.meta.json}`, and the SCRAPE_PARSERS
registration in `scripts/lint-scrape-fixture-realness.js`.
- **What it is:** the whole-table `ps -o pid=,ppid=,uid=,lstart=,time=,comm=` parse into rows
  (pid/ppid/uid/startTime/cputimeSeconds/comm) the sampler uses. LOAD-BEARING for kill
  eligibility (the CPU-delta pivots on `time=`), so REGISTERED in SCRAPE_PARSERS with a
  captured realness fixture (§Testing F1, resolves the round-9 lessons-aware blocker).
- **Dangerous direction:** a parse bug that OVER-reports cputime → a false sustained hog. The
  fixture proves the parser survives the real structural bytes (dd- day-prefix, embedded-space
  lstart + comm, <defunct>, malformed short) and fails CLOSED: unidentifiable pid/ppid/uid →
  row SKIPPED; malformed `time=` → cputimeSeconds undefined → CPU-delta UNKNOWN → alert-never-kill.
- **Signal vs authority:** parsing only; feeds the deterministic CPU-delta. Multi-machine: pure.
- **External surfaces:** the parser is pure (the actual `ps` spawn is the sampler slice).
  parseProcTimeToSeconds stays a non-blocking register-or-justify note (a field parser, not a
  whole-output parser — exercised transitively through this fixture).
- **Rollback:** delete the module + fixture + registration entry.
- **Tests:** 5 — the byte-for-byte fixture parse (7 rows, 1 malformed skipped; dd- anchor =
  106920s; comm-with-spaces preserved; <defunct>), the time= realness (dd- day-prefix), and
  fail-closed (malformed time → undefined, non-numeric pid → skip, non-string → []).

### Slice 10 — stage-1 candidacy state machine (pure)
Files: `src/monitoring/ExternalHogSampler.ts` (`advanceSampler`, `isSamplerDead`),
`tests/unit/external-hog-sampler.test.ts` (13 tests).
- **What it is:** the pure stage-1 candidacy computation — from two successive ps snapshots it
  selects external (own-uid, not instar-owned) processes whose cross-tick Δcputime/Δwall
  crosses the threshold. Integrates the CPU-delta + ownership walk + parsed rows. Rebuilds the
  identity map each tick (bounded). A liveness heartbeat advances only on a plausible parse.
- **Dangerous direction:** a false CANDIDATE (an idle process flagged as a hog). Guarded: uses
  the DELTA not lifetime average (emergent hog caught, idle not); different-uid / instar-owned /
  unknown-cputime / first-sight → never a candidate; UNKNOWN delta → excluded.
- **Signal vs authority:** produces a candidacy signal; never kills. The actual ps spawn + wall
  clock live in the thin I/O worker shell (later); this is pure. Multi-machine: pure.
- **Heartbeat:** advances on any plausible parse (≥1 row) regardless of candidate count (idle
  machine not sampler-dead); a failed/empty parse does NOT advance (→ eventually sampler-dead)
  and keeps the previous baseline (a transient hiccup doesn't lose the delta baseline).
- **Rollback:** delete; the sentinel class (later) consumes it.
- **Tests:** 13 — baseline/candidate/emergent-hog/low-cpu; exclusions (uid, instar-own, unknown
  cputime); heartbeat (advances on zero-candidate plausible parse, not on empty/non-finite);
  isSamplerDead (null=not-dead, fresh/stale, non-finite-now=not-dead).

### Slice 11 — classifier orchestration (pure: verdict parse, cap-select, cache)
Files: `src/monitoring/ExternalHogClassifier.ts` (`parseClassifierVerdict`,
`selectForClassification`, the TTL+LRU `VerdictCache`), `tests/unit/external-hog-classifier.test.ts` (13 tests).
- **What it is:** the pure orchestration around the model call (the actual LlmQueue call is the
  sentinel-class adapter). Verdict parse (bounded enum, fail-safe), worst-CPU-first selection
  under maxClassificationsPerScan, and the identity-tuple verdict cache.
- **Dangerous direction:** `parseClassifierVerdict` returning 'kill' when it shouldn't. Guarded:
  ONLY an exact `kill`/`leave`/`alert` (bare or `{action}`) parses; anything else → null →
  decider-unavailable → ALERT, never kill. NEVER extracts a pid/target from output.
- **Cap-select:** worst-CPU-first so a decoy flood can't starve the real hog; deterministic
  non-attacker tie-break; non-positive cap → classify none.
- **Cache:** keyed on the FULL identity tuple (pid+start-time+command-hash) so a reused pid
  can't inherit a prior `kill`; TTL+LRU; advisory (the §4 kill-time re-check is authoritative;
  a non-finite now/ttl → miss).
- **Signal vs authority:** the model decides WITHIN the floor; this is the pure plumbing. Rollback:
  delete; the sentinel class consumes it. Multi-machine: pure.
- **Tests:** 13 — verdict parse (enum, JSON, unparseable→null, no-pid-extraction), worst-CPU-first
  select (decoy-flood can't starve, tie-break, non-positive cap), cache (TTL, reused-pid-no-inherit,
  LRU eviction, non-finite→miss).

### Slice 12 — kill funnel (the hardened SIGTERM→SIGKILL sequence, the ONLY signal path)
Files: `src/monitoring/ExternalHogKillFunnel.ts` (`runKillFunnel`),
`tests/unit/external-hog-kill-funnel.test.ts` (10 tests).
- **What it is:** the ONLY place a real signal is sent. The watch-only guarantee is BY
  CONSTRUCTION: unless canKillLive (enabled && !dryRun && a valid PIN marker for this class) at
  BOTH re-check points, NO signal is sent (returns `would-kill`). All I/O injected → fully
  testable without killing anything. Sequence: pre-SIGTERM arm-gate + Stage-B floor re-check →
  SIGTERM → grace → exited? → pre-SIGKILL re-check (disarm/identity/floor mid-grace aborts) →
  fd-skip defer (bounded) → SIGKILL.
- **Dangerous direction:** sending SIGKILL without full authorization. Guarded: canKillLive at
  entry (would-kill/no-signal in watch-only) AND re-checked before SIGKILL; a disarm/identity-
  change/floor-veto mid-grace aborts the escalation (the graceful SIGTERM already sent is not
  forced to SIGKILL); class re-matched at kill time; fd-write defers (capped).
- **Signal vs authority:** executes the floor+model decision; never decides. Multi-machine:
  machine-local (a host process). Rollback: delete; the sentinel class consumes it.
- **Tests:** 10 — dryRun/not-armed/disarmed → would-kill NO SIGNAL; floor-veto/gone → aborted NO
  SIGNAL; sigterm-exit (SIGTERM only); full kill (SIGTERM+SIGKILL); disarm-mid-grace → aborted
  (SIGTERM only, no SIGKILL); fd-write defer (SIGTERM only); defer-cap-exhausted → SIGKILL.

### Slice 13 — scan-tick orchestrator (composes all modules; the feature is ALIVE)
Files: `src/monitoring/ExternalHogScanTick.ts` (`runScanTick`),
`tests/unit/external-hog-scan-tick.test.ts` (6 tests, end-to-end over injected I/O).
- **What it is:** the orchestrator tying every reviewed module into ONE scan tick: discovery
  (sampler) → worst-CPU-first classify under the cap → floor → P19 breaker → kill funnel → P17
  coalesced notices. All I/O injected (read ps, ownership, classify, funnel deps, clock,
  deliver) → the whole tick is end-to-end testable without a real ps/model/signal.
- **Dangerous direction:** driving the funnel toward a kill it shouldn't. Guarded: a kill is
  attempted ONLY when verdict==='kill' && floor.permitted && breaker-not-tripped; and even then
  the funnel is watch-only unless armed (so the orchestrator can never cause a signal the funnel
  wouldn't). Every non-killed sustained hog (leave / veto / decider-unavailable / breaker /
  would-kill / over-cap) is SURFACED (§4 observability floor — the model can't silence a hog).
- **Watch-only rides through:** in the shipped dryRun state the funnel returns would-kill → no
  signal → the tick produces would-kill records + observability notices, kills NOTHING.
- **Signal vs authority:** pure control flow composing the reviewed modules. Multi-machine:
  machine-local. Rollback: delete; the server wiring (later) consumes it.
- **Tests:** 6 — watch-only hog→would-kill NO SIGNAL + surfaced; armed hog→killed + kill notice;
  model-leave→alert-only+surfaced; decider-unavailable→notice; floor-veto→alert-only+notice;
  idle→nothing.

### Slice 14 — guard-posture status (pure §8 honesty rule)
Files: `src/monitoring/ExternalHogGuardStatus.ts` (`externalHogEffectiveState`),
`tests/unit/external-hog-guard-status.test.ts` (5 tests).
- **What it is:** the pure mapping of live state → a `GuardEffectiveState`. Enforces the §8
  honesty rule: `on-confirmed` ONLY when actually kill-capable (enabled && !dryRun &&
  marker-valid); the reachable config.dryRun:false + marker-absent state reads `on-dry-run`
  (armed-pending mapped to on-dry-run in v1), never on-confirmed; a dead sampler → `on-stale`.
- **Signal vs authority:** a STATUS signal — it never kills or gates. Not kill-decision logic,
  so the safety-critical second-pass does not apply; the honesty risk (a false on-confirmed) is
  covered by the exhaustive branch tests. Multi-machine: pure (per-machine posture).
- **Rollback:** delete; the guard-posture wiring (server slice) consumes it.
- **Tests:** 5 — off/on-confirmed/honesty-on-dry-run/dryRun-soak/sampler-dead-on-stale.

### Slice 15 — the composition shell (`ExternalHogSentinel`)
Files: `src/monitoring/ExternalHogSentinel.ts` (`ExternalHogSentinel`, `buildProcTree`),
`src/monitoring/ExternalHogScanTick.ts` (additive: `ScanOutcome` now carries `ledgerKey`/`classId`),
`tests/unit/external-hog-sentinel.test.ts` (5 tests).
- **What it is:** the ADAPTER LAYER that turns the reviewed pure modules into a live, tickable
  monitor. It adds NO kill decision — every tick delegates the whole decision to the reviewed
  `runScanTick`. Its only jobs: (a) hold cross-tick state the pure orchestrator cannot (sampler
  baseline + kill ledger + per-signature deferral count); (b) bridge the async real reads (ps
  spawn / owned-pid resolve) into the sync closures the orchestrator expects, by reading a
  snapshot BEFORE the tick and closing over it; (c) persist the per-signature deferral count so
  `maxKillDeferrals` actually bounds ACROSS ticks (proven behaviorally: an open-workspace-file
  hog defers each scan under the cap, then proceeds to SIGKILL at the cap); (d) deliver notices
  every tick; (e) expose the honest §8 `status()`.
- **The orchestrator amendment:** `ScanOutcome` gained `ledgerKey`+`classId` (additive — better
  audit + lets the shell persist deferral counts without re-deriving identity). Not a logic
  change; all 7 scan-tick tests stay green.
- **Watch-only ride-through:** in the shipped dryRun state a tick produces would-kill records +
  §4 observability notices and signals NOTHING (test: `on-dry-run`, zero signals).
- **Fail-safe:** a read failure degrades to an empty tick (sampler heartbeat does not advance →
  eventually on-stale); `auditTick` is best-effort (a write failure never breaks a tick).
- **Over-block / under-block:** none new — the shell cannot widen a kill (it only forwards to the
  funnel, which is watch-only + floor-vetoed + arm-gated). The one risk it introduces is
  UNBOUNDED memory in the deferral map; bounded by `deferralMapMax` (default 128, oldest-pruned)
  AND by terminal-clear (a resolved/killed/gone signature is deleted).
- **Signal vs authority:** pure forwarding — the shell holds NO authority the modules below don't.
- **Multi-machine:** machine-local BY DESIGN — a process hog + its ps table + owned pids are
  physical to ONE host's process table; the kill is a `process.kill` on THIS machine. `physical-
  credential-locality`-class locality (a host's live process table is hardware/OS-bound). Posture
  per §7 in the spec. No cross-machine state.
- **Rollback:** delete the file; the AgentServer construction (next slice) is what wires it in.
- **Tests:** 5 — buildProcTree, watch-only ride-through + delivery-every-tick + on-dry-run,
  armed→SIGKILL + on-confirmed, cross-tick deferral→SIGKILL-at-cap, sampler-dead→on-stale.

### Slice 16 — the N-window sustained-CPU confirmation (§1 anti-spike)
Files: `src/monitoring/ExternalHogSustained.ts` (`advanceSustained`/`isSustained`/`candidateSignature`),
`src/monitoring/ExternalHogScanTick.ts` (orchestrator amendment: ScanState.sustained,
ScanOpts.sustainedSampleCount, advance-after-candidacy, AND into sustainedHighCpu),
`src/monitoring/ExternalHogSentinel.ts` (state init gains sustained),
`tests/unit/external-hog-sustained.test.ts` (9), scan-tick +1 anti-spike test, sentinel opts.
- **What it is + why:** the spec §1 requires sustainedHighCpu to be an N-window confirmation
  (`sustainedSampleCount:3`) — a kill must NOT fire on a single-window CPU spike (a compile, a GC
  pause). The sampler only produces SINGLE-window candidates; this tracker holds the per-signature
  CONSECUTIVE-window streak and the orchestrator sets sustainedHighCpu authoritatively =
  (fact-builder single-window read) AND (streak ≥ N). A one-window spike (streak < N) is forced to
  sustainedHighCpu:false → the floor's HARD VETO downgrades it to alert — never a kill.
- **Where it lives (architecture):** the streak is stage-2 decision state that ONLY the
  orchestrator can coordinate — it alone has both the full tick candidate set (to advance streaks)
  AND the per-candidate fact call (to apply the result). So it is threaded through ScanState, not
  hidden in the adapter. Advanced ONCE per tick right after candidacy.
- **Safe direction everywhere:** absence resets the streak (strict consecutive — a one-window dip
  from ps quantization re-accumulates rather than shortening the path to a kill); a failed/empty
  parse resets EVERY streak (fail toward not-sustained); a bad N (≤0/non-finite) → isSustained
  false (a misconfigured N can never let a spike qualify). Bounded: the next streak map is rebuilt
  ONLY from this tick's candidates (≤ live candidate count).
- **Over-block:** a genuine hog that dips below threshold for one noisy window is delayed N more
  windows (≈90s at defaults) — an acceptable, deliberately-conservative delay, never a missed kill
  (it re-qualifies). **Under-block:** none — the gate only ever ADDS a precondition to a kill.
- **Signal vs authority:** pure predicate feeding the floor's veto; holds no authority itself.
- **Multi-machine:** machine-local BY DESIGN (a host's process CPU history is physical to one
  machine; `physical-credential-locality`-class). No cross-machine state.
- **Rollback:** revert the amendment (sustainedHighCpu falls back to the single-window read) +
  delete the tracker. **Tests:** 9 tracker + 1 orchestrator anti-spike (single-window+N=2 → veto,
  no kill); all 8 scan-tick + 6 sentinel stay green (N=1 preserves single-window behavior there).

### Slice 17 — the armed-marker persistence store (the live-kill authorization file)
Files: `src/monitoring/ExternalHogArmStore.ts` (`loadArmState`/`armStore`/`disarmStore`),
`tests/unit/external-hog-arm-store.test.ts` (9 tests).
- **What it is:** the durable 0600 file behind the reviewed marker VALIDATORS — the thing the PIN
  arm route writes, the disarm route bumps, and the poll loop reads. Upholds the two load-bearing
  properties by how it mutates epochs: ARM raises armEpoch strictly above both prior armEpoch AND
  lastDisarmEpoch (a fresh arm always wins); DISARM raises lastDisarmEpoch ≥ current armEpoch (the
  marker becomes invalid — a disarm can NEVER be silently un-done; returning to live-kill always
  needs a fresh PIN arm).
- **Fail-closed reads:** missing / unparseable / wrong-shape / non-string-hash / corrupt-epoch →
  `{marker:null, lastDisarmEpoch:0}` (marker null → not armed regardless of any epoch). No corrupt
  shape yields a marker `canKillLive` accepts. `coerceMarker` rebuilds an allowlisted object +
  strictly string-checks every snapshot hash (no prototype-pollution).
- **Durable atomic writes:** tmp → fsync → rename (0600). The fsync closes the Phase-5 residual —
  a power loss right after a DISARM must not revert to armed (the one safety-critical direction).
- **Over/under-block:** none — it never decides a kill; it only persists the authorization the PIN
  route grants. **Signal vs authority:** the PIN route is the authority; this is its durable record.
- **Multi-machine:** machine-local BY DESIGN — the arm is a physical, per-machine operator consent
  to kill on THIS host's process table (`physical-credential-locality`-class); it MUST NOT
  replicate (a PIN arm on one machine can never authorize a kill on another). No cross-machine state.
- **Rollback:** delete the file + module; with no marker the feature is watch-only regardless.
- **Tests:** 9 — fresh/corrupt/wrong-shape fail-closed, arm authorizes exactly the consented class,
  new/broadened class not armed, 0600 mode, disarm invalidates + monotonic + idempotent, and
  reboot-boots-unarmed (live config alone never re-arms).

### Slice 18 — the deterministic fact + identity builder (stage-2 derivation)
Files: `src/monitoring/ExternalHogFactBuilder.ts` (`buildFacts`/`buildIdentity`/`deriveOwnerAppRunning`/
`parseParentPid`/`lstartToEpochMs`), `src/monitoring/ExternalHogFloor.ts` (DOC-ONLY: fixed an
INVERTED comment on `ownerAppRunning`), `tests/unit/external-hog-fact-builder.test.ts` (18 tests).
- **What it is:** the PURE stage-2 derivation that turns a candidate's proc row + FULL argv (fetched
  off-loop by the adapter) into the `ExternalHogFacts` the floor evaluates and the identity
  (classId/commandHash/ledgerKey) the ledger + funnel key on. No process spawn, no clock — the
  impure edges (ps -o args=, launchctl, geteuid) are passed IN, so every derivation is testable.
- **The load-bearing derivation — `ownerAppRunning` polarity (§ round-6/round-8):** `true` = the
  specific `--parentPid` owner is alive OR cannot be established → floor VETO; `false` = that
  parent is dead (start-time-verified) → kill-eligible. Round-8 reused-pid rule: parent-pid absent
  → dead; parent-pid present but its lstart is LATER than the child's → pid reused, real parent
  dead; parent older-or-equal (or start-times un-orderable) → assume live → veto. EVERY
  un-establishable branch fails toward `true` (veto). Validated by running the built facts through
  the REAL floor (a genuine orphaned exthost PERMITS; root/launchctl/non-sustained VETO).
- **The lstart ordering parse:** the proc-table parser keeps `startTime` an OPAQUE equality token
  by design; this slice adds a CONFINED, fail-safe `lstartToEpochMs` used ONLY for the one
  reused-pid ordering comparison (parse ambiguity → null → conservative veto). Does not change the
  parser's opaque-token contract.
- **Floor doc-bug fix (doc-only, no logic change):** the `ownerAppRunning` field comment in
  ExternalHogFloor.ts read "parent is dead → true", the INVERSE of the floor's own step-5 logic
  (`ownerAppRunning` true → veto). Corrected to match the authoritative logic + the spec.
- **Identity:** `buildIdentity` is allowlist-gated (outside the code-defined allowlist → null → not
  kill-eligible, surfaced not killed); the command-hash STRIPS the volatile `--parentPid` so the
  P19 breaker counts respawns of the SAME command (proven: hash stable across a changed parentPid).
- **Over/under-block:** over-vetoes on uncertainty (the safe direction); the only under-block risk
  (a reused-then-immediately-hog parent) is the documented identity limit, fail-safe. **Signal vs
  authority:** pure derivation feeding the floor; holds no authority. **Multi-machine:**
  machine-local BY DESIGN (a process tree + argv are physical to one host; `physical-credential-
  locality`). **Rollback:** delete the module (the real adapter's factsFor would inline it).
- **Tests:** 18 — parentPid parse, lstart ordering + fail-safe null, all 5 ownerAppRunning
  branches, floor-validated permit/veto for orphan/root/launchctl/non-sustained, allowlist-gated +
  stable-hash identity.

### Slice 19 — the classifier prompt builder (injection-hardening boundary)
Files: `src/monitoring/ExternalHogClassifierPrompt.ts` (`buildClassifierPrompt`),
`tests/unit/external-hog-classifier-prompt.test.ts` (6 tests).
- **What it is:** the PURE composer of the kill/leave/alert prompt fed to the zombie-classify
  model. Carries the envelope-wrapped DERIVED facts (matched class, ownerAppRunning,
  sustainedHighCpu, launchctl-label, same-uid boolean) + the attacker-controllable name/argv
  wrapped as explicit untrusted data, and demands a strict `{"action":"kill|leave|alert"}` verdict.
- **Two spec §5 security properties enforced here:** (1) the raw (pid, start-time, command-hash)
  IDENTITY TUPLE is NEVER in the prompt (round-8 — denies an injection payload a concrete target
  to name); (2) the name/argv are wrapped in a `<untrusted-process-data>` envelope with a
  treat-as-data instruction, and the embedded values are delimiter-stripped (a process forging the
  close-tag can't break out) + length-clamped (no unbounded prompt growth). Unit-asserted.
- **Signal vs authority — why no second-pass:** the prompt holds NO kill authority. The model's
  verdict is SUBTRACTIVE (it can only SPARE an in-envelope process; the floor's two-key AND means
  a kill still needs `floor.permitted`), so a prompt bug (or even a fully-successful injection) can
  only cause a false-LEAVE / false-ALERT or a kill WITHIN the allowlist envelope the attacker
  crafted — NEVER a wrong-kill outside the floor. This is effectiveness, not kill-safety; the
  security properties are unit-asserted. (Consistent with the coalescer slice — not-kill-logic.)
- **Over/under-block:** a poor prompt lowers effectiveness (more false-leaves), never safety.
  **Multi-machine:** pure string builder, no state. **Rollback:** delete; the adapter would inline
  a prompt. **Tests:** 6 — derived facts present, strict verdict demanded, identity-tuple excluded,
  untrusted envelope + forge-resistance + length clamp.

### Slice 20 — the real-I/O adapter factory (the glue that makes it run)
Files: `src/monitoring/ExternalHogRealAdapters.ts` (`createExternalHogAdapters` + pure lsof/launchctl
parsers), `src/monitoring/ExternalHogKillFunnel.ts` + `ExternalHogScanTick.ts` + `ExternalHogSentinel.ts`
(async-ified factsFor / reReadFacts / hasOpenWritableWorkspaceFile), `src/monitoring/ExternalHogFloor.ts`
(additive `classRuleSources` export), `tests/unit/external-hog-real-adapters.test.ts` (13 tests).
- **What it is:** the impure edge binding the reviewed pure modules to the real OS. Every raw
  side-effect (spawn ps/launchctl/lsof off-loop, process.kill, the model call, raiseAttention,
  clock, arm-file read) is a single INJECTED primitive → the wiring is unit-testable with fakes and
  NO real process is spawned/signalled in a test. Holds NO kill decision — it READS the OS to
  produce facts and EXECUTES the signals the reviewed funnel decides on.
- **Async-ification (kill-path files):** factsFor (orchestrator) + reReadFacts/hasOpenWritableWorkspaceFile
  (funnel) genuinely need async I/O (a live ps+argv / lsof read). Widened to accept a Promise +
  `await` — NO decision change; every existing sync test fake still works via await; all 25
  prior funnel/scan-tick/sentinel tests stay green.
- **The §4.5 kill-time CPU RE-CONFIRM (a gap I caught + fixed mid-build):** reReadFacts must not
  assume the candidate is still a hog. Added a `cpuCoresOver(pid, windowMs)` micro-probe primitive;
  reReadFacts sets sustainedHighCpu from a FRESH sample — a below-threshold OR null reading →
  sustainedHighCpu:false → the floor re-check ABORTS the kill (the "went idle since classify" guard).
  Tested (still-pinning → true; idle → false; null → false).
- **classRuleSources (floor, additive):** the SINGLE source of truth for a class's content-hash,
  so the arm route's snapshot and the funnel's `currentClassContentHash` always agree (tested).
- **Fail-safe directions:** ps fail → empty table (→ on-stale); argv null → skip candidate; lsof
  error → DEFER (bounded); launchctl error → empty set (floor-bounded, feature keeps working);
  cpu null → not-sustained (abort); attention delivery best-effort (never throws into a tick).
- **Signal vs authority:** pure forwarding — no authority beyond the modules it wires.
  **Multi-machine:** machine-local BY DESIGN (spawns/signals THIS host's processes). **Rollback:**
  delete the factory; the server construction (next slice) is what instantiates it.
- **Tests:** 13 — pure lsof/launchctl parsers, readProcTable/ownedRefs/factsFor/identityFor/classify
  wiring, armStatus composition, deliverNotices, and the §4.5 CPU re-confirm + arm-scope hash agreement.

### Slice 21 — migration parity (existing agents get the dev-gated config on update)
Files: `src/core/PostUpdateMigrator.ts` (`migrateConfigExternalHogSentinelDevGate` + its registration
in `migrateConfig`), `tests/unit/PostUpdateMigrator-externalHogSentinel.test.ts` (7 tests).
- **What it is:** the Migration Parity Standard for the config. On update, an EXISTING agent gets the
  `monitoring.externalHogSentinel` DARK defaults block (dryRun:true + kill-gate knobs, `enabled`
  OMITTED) via ConfigDefaults + applyDefaults add-missing — no add-migration needed. The migrator
  handles the ONE case applyDefaults can't: it STRIPS a default-shaped `enabled:false` (the #1001
  force-dark mechanism that would dark even a dev agent), so `resolveDevAgentGate` resolves it
  live-on-dev / dark-fleet. Mirrors the credentialRepointing / playwrightRegistry precedents exactly.
- **Never clobbers:** an explicit `enabled:true` (an operator fleet-flip) is PRESERVED; the `dryRun`
  canary is left untouched. Existence-checked + idempotent.
- **Over/under-block:** none — it only removes a default-shaped literal that would misconfigure the
  gate. **Signal vs authority:** a config migration, no runtime decision. **Multi-machine:**
  machine-local config edit (each machine migrates its own config). **Rollback:** the strip is
  idempotent; re-adding `enabled:false` to config restores the old shape.
- **Second-pass not-required:** a config-defaults migration (not kill-logic), purely additive,
  mirroring two reviewed dev-gate precedents; the pure strip predicate + the through-migrateConfig
  behavior are unit-asserted. **Tests:** 7 — strip predicate (3), block-install / strip / no-clobber
  / idempotent through the real migrateConfig (4).
- **CLAUDE.md agent-awareness (Agent Awareness Standard) is a SEPARATE upcoming slice** (generateClaudeMd
  + migrateClaudeMd). <!-- tracked: CMT-1901 -->

### Slice 22 — the HTTP routes (status + PIN-gated arm + disarm)
Files: `src/server/routes.ts` (RouteContext.externalHogSentinel + GET /external-hog, POST
/external-hog/arm, POST /external-hog/disarm), `tests/integration/external-hog-routes.test.ts` (6).
- **What it is:** the operator surface. GET /external-hog (Bearer, read-only) returns
  sentinel.status() + the durable arm state (503 when the sentinel is dark). POST /external-hog/arm
  (PIN-gated via checkMandatePin — a Bearer token cannot arm a real kill; Know Your Principal)
  builds the per-class content-hash snapshot from EXTERNAL_HOG_ALLOWLIST via classRuleSources +
  classContentHash and calls armStore. POST /external-hog/disarm (Bearer — the SAFE direction, no
  PIN) calls disarmStore.
- **Why PIN on arm but not disarm:** arming turns ON an irreversible action (a real kill) → minimum
  rung 1 (PIN). Disarming returns to watch-only (the safe direction) → Bearer is sufficient.
- **Snapshot agreement:** the route arms every allowlist class with the SAME hash the funnel's
  currentClassContentHash re-checks (both derive from classRuleSources) — so a legitimately-armed
  class is recognized, and a matcher change forces a re-arm. Thin wiring over the reviewed
  armStore/disarmStore epoch machinery.
- **Over/under-block:** GET emits only the arm METADATA (armEpoch, armedAt, class NAMES) — never a
  secret. **Signal vs authority:** the PIN + the arm-store epochs are the authority; the route is
  the surface. **Multi-machine:** machine-local BY DESIGN (a PIN arm authorizes a kill on THIS
  host's process table; the marker must not replicate). **Rollback:** the routes 503/no-op when the
  sentinel is unwired.
- **Tests:** 6 (Tier-2 integration over the real HTTP pipeline) — 503-when-dark, status shape,
  arm-403-without-PIN, arm-403-wrong-PIN, arm-200-mints-epoch-1, and the full arm→disarm→re-arm
  (epoch 2) lifecycle through the routes + the durable marker file.

### Slice 23 — the server primitives (the §4.5 CPU probe + the primitive factory)
Files: `src/monitoring/ExternalHogServerPrimitives.ts` (`makeCpuCoresOver` + `createExternalHogServerPrimitives`
+ `parseTmuxPanePids`), `tests/unit/external-hog-server-primitives.test.ts` (7 tests).
- **What it is:** builds the real-OS ExternalHogPrimitives the server injects into the factory —
  kept OUT of the giant server command so the one non-trivial composed primitive (the §4.5 kill-time
  CPU micro-probe) is unit-testable. Thin over injected low-level deps (async exec, process.kill,
  monotonic clock, sleep, intelligence.evaluate, raiseAttention, resolved config, loadArmState).
- **The §4.5 probe (`makeCpuCoresOver`, kill-GATING):** samples a pid's cumulative cputime TWICE over
  windowMs (monotonic Δwall) and resolves core-equivalents via the REVIEWED computeCoreEquivalents
  (whose symmetric small/large-Δwall guards — the slice-4 fix — already block ps-quantization
  false-highs). Fail-safe to null (→ the reviewed reReadFacts aborts the kill) on: pid gone, ps
  unreadable/unparseable, pid-REUSED mid-window (startTime changed), or an UNKNOWN delta.
- **Over-block / under-block:** the false-HIGH direction (a non-hog reading as sustained → wrong
  kill) is guarded by computeCoreEquivalents + tested (idle → ~0 cores, not high); the false-low
  direction just spares (safe). **Signal vs authority:** a measurement primitive — no authority.
  **Multi-machine:** machine-local (samples THIS host's processes). **Rollback:** delete; the
  construction slice would inline the primitives.
- **Tests:** 7 — still-pinning → ~2 cores, idle → ~0, vanished → null, pid-reused → null, exec-throw
  → null, tmux-pane parse, and the factory assembly (config/loadArm/serverPid/tmux pass-through).

### Slice 24 — server construction (make it alive) + guard registration
Files: `src/commands/server.ts` (construct primitives → adapters → sentinel; guardRegistry.register;
the dev-gate-gated interval; pass to AgentServer), `src/server/AgentServer.ts` (the externalHogSentinel
option → ctx), `src/monitoring/guardManifest.ts` (expectRuntime false→true), `src/monitoring/
ExternalHogSentinel.ts` (guardRuntimeStatus getter), `tests/e2e/external-hog-routes-alive.test.ts` (4).
- **What it is:** the production composition root. Resolves the developmentAgent gate
  (resolveDevAgentGate) → live-on-dev / dark-fleet; builds the real primitives (execFileAsync
  ps/launchctl/lsof w/ 15s timeout + 8MB cap, process.kill, sharedIntelligence.evaluate,
  telegram.createAttentionItem, resolved config, loadArmState, the §4.5 probe); creates the adapters
  + the ExternalHogSentinel; ALWAYS registers the /guards runtime getter (honest posture even when
  dark); and starts the scan interval ONLY when the dev-gate resolves enabled (unref'd so it never
  holds the process open). Construction is TRY-guarded → a failure disables the feature this boot,
  never crashes the server.
- **The interval is dev-gate-gated:** when dark (fleet), no interval → NO tick → NO kill, ever. The
  dryRun canary flows to the sentinel's config() so even a live-on-dev tick is watch-only until a
  PIN arm. `guardRuntimeStatus().lastTickAt` = the sampler heartbeat, so /guards reads on-stale when
  blind (never a false on-confirmed).
- **guardManifest expectRuntime false→true:** now that the getter is registered at boot, /guards
  expects the runtime report (an un-registered expectRuntime would manufacture a phantom `missing`).
- **Over/under-block:** none new — the construction only WIRES reviewed pieces; the kill decision is
  entirely below it. **Signal vs authority:** composition, no authority. **Multi-machine:**
  machine-local BY DESIGN (each machine constructs its own sentinel over ITS process table; nothing
  replicates). **Rollback:** the try-guard + the dev-gate + the omitted config `enabled` mean the
  feature is dark-by-default; removing the construction block reverts cleanly.
- **Tests:** 4 (Tier-3 E2E "feature is alive" over the real AgentServer) — GET 200 with a live status
  (a benign tick advanced the sampler → on-dry-run), the arm→disarm→re-arm epoch-2 lifecycle
  end-to-end, dark → 503, and auth (Bearer required, arm needs the PIN not just Bearer).

### Slice 25 — CLAUDE.md agent-awareness (Agent Awareness Standard)
Files: `src/core/PostUpdateMigrator.ts` (`EXTERNAL_HOG_CLAUDEMD_SECTION` + the migrateClaudeMd
append), `src/scaffold/templates.ts` (import + concat into generateClaudeMd), the migration test
(+3 CLAUDE.md tests).
- **What it is:** the Agent Awareness Standard — an agent that doesn't know about a capability
  effectively doesn't have it. Adds a CLAUDE.md section teaching the agent the GET /external-hog
  status route, the PIN-gated arm + Bearer disarm routes, the two-key `floor_pass &&
  classifier==='kill'` rule, the watch-only/PIN-arm posture, and the proactive triggers ("what's
  pinning my CPU?", "why did an editor helper get killed?", "why is it only watching?").
- **Migration parity (existing agents):** migrateClaudeMd appends the section content-sniffed on
  'External-Hog Zombie Auto-Kill Sentinel' (idempotent, preserves prior content). generateClaudeMd
  (templates.ts) emits the SAME section so fresh installs get it too (parity between the two sources).
- **The PIN honesty rule is IN the section:** "NEVER ask the user to paste the PIN into chat — point
  them at the dashboard" (Operators-act-in-taps).
- **Not runtime behavior:** documentation/awareness only. **Second-pass not-required** (no decision
  logic). **Rollback:** the content-sniff guard makes re-running a no-op; removing the section
  function + the two callsites reverts. **Tests:** +4 — the section is added with the key routes +
  posture + the two-key rule; idempotent + content-preserving; and the generateClaudeMd template
  emits it (fresh-install parity).

### Slice 26 — CI ratchet fixes (route-prefix classification + bench-coverage decision)
Files: `src/server/CapabilityIndex.ts` (INTERNAL_PREFIXES += external-hog), `src/data/llmBenchCoverage.ts`
(ExternalHogClassifier bench decision). Two registry ratchets CI caught (the only 2 red tests among
7448; every other test + all my local suites were green):
- **capabilities-discoverability:** the `/external-hog` route prefix was registered in routes.ts but
  not classified. Added it to `INTERNAL_PREFIXES` — agent-read operational observability (status) +
  a PIN-gated operator action (arm/disarm), like `/green-pr-automerge`; dev-gated dark, 503 on the
  fleet, surfaced via the CLAUDE.md agent-awareness section (not a user-invokable capability).
- **llm-bench-coverage-ratchet:** `ExternalHogClassifier` (a new sentinel-category LLM component)
  needed a bench-coverage decision. Added `{ task: 'zombie-classify' }` — the operator-approved
  benchmark that IS this classifier's bench task (measures false-leave/false-alert EFFECTIVENESS;
  kill-SAFETY is carried entirely by the deterministic floor, so it never gates a kill). The task
  battery lives in the research tree; neither ratchet checks the task file on disk.
- **Over/under-block:** none — registry/ratchet entries. **Signal vs authority:** no runtime
  decision. **Rollback:** remove the two entries. **Tests:** both ratchet suites green (151 tests).

## Phase 5 — Second-pass review

### Slice 16 Phase-5 verdict — defect found + fixed → CONCUR
An independent reviewer read all six kill-path files and traced A–E:
- **A (false-sustained):** handled — `candidateSignature` is byte-identical to the sampler's
  `idKey`, the streak accrues to the right process, `startTime` defeats pid-reuse, duplicates
  dedupe.
- **B (AND-composition) — REAL DEFECT FOUND + FIXED:** `rawFacts.sustainedHighCpu && sustained`
  could LAUNDER a degraded truthy non-boolean (`1`) into boolean `true`, defeating the floor's
  round-11 `typeof !== 'boolean' → field-unknown` veto in the kill-PERMITTING direction. FIXED to
  the reviewer's exact prescription: `rawFacts.sustainedHighCpu === true ? sustained :
  rawFacts.sustainedHighCpu` — the N-window gate applies ONLY to a genuine boolean `true`; every
  other value (false / 1 / undefined / null) is PRESERVED verbatim so the floor still vetoes it.
  Added a regression test (a `sustainedHighCpu:1` fact + full streak → NO kill, alert-only,
  floor-veto-downgrade). Reviewer RE-CONFIRMED: "Category B is fully closed; the regression test
  pins it. Preserving `false` is identical to forcing it — introduces nothing."
- **C/D/E:** handled — bad-N fail-closed, empty-parse reset, bounded map, correct state threading,
  and the funnel's live re-read composes subtractively (no gate bypass).

Verdict: **Concur with the review** (after the category-B fix).

### Slice 17 Phase-5 verdict — CONCUR
An independent reviewer traced all five risks against the validators and found no safety defect:
no corrupt/crafted/torn-write path yields a marker `canKillLive` accepts.
- **A disarm durability:** `lastDisarmEpoch = max(cur, markerEpoch)` reads the CURRENT marker epoch
  → however high armEpoch, the marker reads invalid; a failed rename leaves the OLD state and
  throws (never a silent partial disarm).
- **B fail-closed:** any corrupt/NaN/negative/missing lastDisarmEpoch collapses the read to
  not-armed.
- **C monotonicity:** `max(prior, lastDisarm)+1` is strictly above both; 2^53 float precision fails
  SAFE (won't arm).
- **D atomicity:** tmp+rename atomic; readers only open the main file.
- **E laundering:** coerceMarker rebuilds an allowlisted object, rejects non-string snapshot values;
  `__proto__` keys can't pollute.
- **Residual (non-blocking, now CLOSED):** the reviewer noted writeState lacked fsync (a power loss
  after a disarm could revert to a PREVIOUSLY-authorized arm — never new/widened). CLOSED by adding
  the content fsync (tmp → fsync → rename) — strictly more durable, no behavior change.

Verdict: **Concur with the review.**

### Slice 18 Phase-5 verdict — CONCUR
An independent reviewer read the builder + the floor + ownership + the proc-table, and found no
wrong-permit after an adversarial walk:
- **A polarity:** correct — `deriveOwnerAppRunning` returns `false` (kill-eligible) ONLY when the
  parent-pid is absent from the tree OR its occupant started strictly after the child (reused pid);
  every uncertain/owner-alive branch returns `true` → floor step-5 vetoes. The floor comment now
  matches the logic exactly.
- **B ordering:** sound — a real parent's start is necessarily ≤ its child's, so `parentMs > childMs
  → dead` is valid; both lstarts parse through the same Date.parse in the same TZ (offset cancels);
  same-second ties → veto (safe); unparseable → veto.
- **Tree-completeness (where a wrong-permit could hide):** verified — buildProcTree uses the FULL
  ps output with NO cpu filter and macOS ps lists all same-uid processes, so a live parent is
  always present → branch-2 "absent" means genuinely dead.
- **C/D/E:** field derivations veto-leaning; `--parentPid`-strip hash collisions only shift breaker
  counts (never the envelope); same-uid + allowlist + sustained + orphaned conjunction bounds an
  argv-attacker to killing a zombie-shaped process they themselves crafted.

Verdict: **Concur with the review.**

### Slice 20 Phase-5 verdict — CONCUR
An independent reviewer read the factory + funnel + orchestrator + arm-marker + floor + the two
fail-safe dependency modules, and found no safety defect yielding a wrong-KILL or a skipped abort:
- **A async:** awaiting changes no logic — both funnel re-checks survive; every awaited path can
  only ABORT, never introduce a signal; the residual check-then-signal pid-reuse gap is inherent
  POSIX (identical to the sync version), bounded by the startTime-verified stillAlive.
- **B §4.5 CPU re-confirm:** `stillHog = cores!==null && finite && cores>=threshold`; null/NaN/below
  → false → floor `not-sustained-hog` veto. No non-hog reaches true through the glue. Strictly
  veto-STRENGTHENING.
- **C launchctl-empty:** contained — killing a real launchd job ADDITIONALLY requires same-non-root-
  uid + orphaned + sustained + the editor-exthost allowlist match (an unreachable conjunction for a
  managed daemon; the allowlist is the true containment).
- **D:** pid-reuse → startTime mismatch → null → abort; stale lastOwned → isInstarProcess:false can't
  open a kill (an instar process won't match the exthost regex — ownership isn't the kill-protection).
- **E arm-scope:** both sides derive from classRuleSources; a matcher change → new hash → re-arm
  required; snapshot keyed by classId (no cross-class arming); any divergence fails toward no-kill.
- **F:** deliverNotices / classify only raise attention / call the model.

Verdict: **Concur with the review.**

### Slice 22 Phase-5 verdict — CONCUR
An independent reviewer traced the load-bearing property (a live kill needs enabled && !dryRun &&
isMarkerValid && classIsArmed; the marker is written ONLY by armStore, whose sole caller is the
PIN-gated arm route — grep-confirmed) and found no safety defect:
- **A PIN gate:** checkMandatePin is the FIRST statement; every failure path (no dashboardPin→503,
  rate-limit→429, missing/non-string/wrong pin→403 timing-safe) sends a response + returns false
  BEFORE any write. Bearer-only / `{}` / PIN-in-wrong-field all yield pin===undefined → 403; even
  absent body-parsing, `req.body ?? {}` fails closed to 403.
- **B snapshot:** arm's classContentHash(classRuleSources(id)) is the IDENTICAL call the funnel's
  currentClassContentHash makes, same classId key — byte-identical, every allowlist class included.
- **C disarm:** no PIN (safe); lastDisarmEpoch = max(cur, markerEpoch) ≥ armEpoch invalidates; atomic
  + fsync write; fs error → 500, never a 200-without-write.
- **D leak:** returns only epoch/timestamps/class-ids — no token/PIN/secret (armedBy not even surfaced).
- **E monotonicity:** max(prior, lastDisarm)+1 mints strictly-higher, finite-guarded — stale markers
  can't re-authorize.

Verdict: **Concur with the review.**

### Slice 23 Phase-5 verdict — CONCUR
An independent reviewer traced the false-high direction adversarially and found no exploitable
false-high on an idle process:
- **A (false-high/window):** `at = nowMs()` is captured BEFORE each exec, so Δwall = exec-latency +
  windowMs (always ≥ the real window) → the denominator is if anything INFLATED → cores DEFLATED
  (safe). prev←a, curr←b order correct. An idle process accrues ~0 cputime between reads regardless
  of timing skew → cores ~0; reaching ≥0.5 cores needs ≥15 real CPU-seconds — a genuinely idle
  process cannot. The small-Δwall inflation guard never trips because the real sleep dominates.
- **B (pid-reuse):** startTime mismatch → null; negative Δcpu → UNKNOWN. Residual (non-blocking):
  a reused pid in the SAME 1-sec lstart that is ITSELF heavily busy could read high — but that is a
  real hog on the wrong-but-busy pid, the accepted lstart-granularity limit.
- **C:** pid-gone / undefined / NaN cputime / throw all → null; no parse path yields a spurious high.
- **D:** contract order correct; a swap → negative Δwall → UNKNOWN → safe.

Verdict: **Concur with the review** — fails safe in every direction.

### Slice 24 Phase-5 verdict — CONCUR (with one robustness nit folded)
An independent reviewer traced all five areas — the dark-on-fleet / watch-only-on-dev / PIN-to-kill
invariant holds:
- **A interval gating SAFE:** `_externalHogEnabled = resolveDevAgentGate(...) = explicitEnabled ??
  !!config.developmentAgent`. Fleet + enabled-omitted → false → NO setInterval, NO tick, NO kill.
  The interval runs only on developmentAgent:true or explicit enabled:true (both deliberate);
  enabled:false force-darks even a dev agent. guardRegistry.register installs a LAZY getter
  (reads arm/heartbeat only, never tick()).
- **B dryRun/PIN AIRTIGHT:** default dryRun omitted → true (watch-only). canKillLive needs enabled
  && !dryRun && isMarkerValid && classIsArmed; construction NEVER writes an arm marker → null →
  invalid. So even enabled:true+dryRun:false yields would-kill until a PIN-route epoch-fenced
  marker exists. NO real signal reachable from construction alone.
- **C SAFE:** setInterval sits after successful construction inside the try; any throw → undefined →
  routes 503, no timer. Timer unref'd.
- **D (robustness nit, FOLDED):** ehNum rejected NaN but passed negative/zero/huge finite — a garbage
  scanIntervalMs:0 could hot-loop the DEV tick (no kill-safety impact — the gate is unaffected).
  CLOSED: the interval-critical knobs are now positive-clamped (scanIntervalMs ≥ 1000, cpuCoreThreshold
  ≥ 0.1, sampleWindowMs ≥ 1000, sustainedSampleCount ≥ 1).
- **E SAFE:** externalHogSentinel threads options → ctx (`?? null`); routes get null when dark, no clobber.

Verdict: **Concur with the review.**

**Slice 26 (cont.) — the full per-component ratchet set.** CI's sharded run surfaced that a new
LLM component must carry a decision in EVERY per-COMPONENT_CATEGORY registry (not just bench-coverage).
Added `ExternalHogClassifier` to all of them, each an honest classification: `LLM_UNTRUSTED_INPUT: true`
(judges the attacker-controllable name/argv), `LLM_JUDGES_CLAIMS: false` (judges a process disposition,
not a completion/health claim), `LLM_PARSER_CONTRACT: { pending: 'contract-wave-2' }` + its pinned
baseline (its output is machine-parsed into a closed kill/leave/alert verdict), `LLM_ROUTING_NATURE:
{ nature: 'A', chain: 'SORT' }` (a background bounded verdict), plus the earlier bench-coverage
(`zombie-classify`) + the routing-registry row + componentCategories (sentinel) + the CapabilityIndex
prefix. All 7 ratchet suites green (198 tests). Registry decisions, not kill-logic.

**Slice 27 — rebase onto main + the four merge-point ratchet declarations.** CI's merge-commit run
(vs a main 28 commits ahead) surfaced four declaration ratchets the branch predated; all four are
registry/annotation decisions, ZERO kill-logic changes:
- **write-domain (§3.5):** `POST /external-hog/arm` + `POST /external-hog/disarm` classified
  MACHINE-LOCAL in `buildWriteDomainRegistry` with a two-axis convergence story whose logical story
  IS the file-level story: the arm marker (`state/external-hog-arm.json`) is per-machine PIN
  consent, and cross-machine convergence would BE the vulnerability (a synced marker silently arms
  a peer's sentinel the operator never consented to — the silent-re-arm class the armEpoch design
  prevents). File-level arm shipped as a `FileClassifier` sync exclusion for that exact path.
- **feature-delivery-completeness:** the 'External-Hog Zombie Auto-Kill Sentinel' CLAUDE.md section
  tracked in `legacyMigratorSections` — dark dev-gated monitoring guard, template+migrator parity
  via the shared `EXTERNAL_HOG_CLAUDEMD_SECTION` constant, NOT framework-shadowed (same class as
  'Machine-Coherence Guard' / 'Write Admission').
- **lint-dev-agent-dark-gate golden map:** the `monitoring.externalHogSentinel` ConfigDefaults block
  (28 lines, OMITS the `enabled` literal — rides resolveDevAgentGate, the #1001 anti-pattern
  avoided) adds NO attributed path; every `enabled: false` line below it shifts +28. Hand-verified
  per entry (path set unchanged, 25 entries).
- **no-silent-fallbacks:** the PR's 8 net-new flagged catches resolved honestly: the server-boot
  construction-failure catch now REPORTS via DegradationReporter (a guard disabled for the boot is
  a real degradation); the other 7 are reviewed fail-safe catches tagged `@silent-fallback-ok` with
  their safety direction inline (signal-false is the primitive's contract; tick errors are logged;
  verdict-parse falls to the enum shape then null=no-kill; launchctl-empty is the round-8 reviewed
  floor-bounded decision; argv-null skips the candidate; CPU-probe-null refuses the reading; tmux-empty
  leaves the orphan invariant blocking). Count back at main's own level (490 ≤ 491 baseline).
Also folded at the rebase merge-point: `templates.ts` import-line conflict (main's
DOORWAY_REGISTRY_CLAUDEMD_SECTION + this branch's EXTERNAL_HOG_CLAUDEMD_SECTION — both kept).
Rollback: revert the commit; every change is a declaration/annotation, no runtime behavior moves
except the added DegradationReporter report on a construction-failure path that previously only
console.error'd.

**Slice 27 (cont.) — Self-Action Convergence closure (guard).** Main's new Capacity-Safety gate
("No Unbounded Self-Action") landed while this branch was in flight; the sentinel IS the class's
subject (a killer on a 60s loop), so it gets the real closure, not a carve-out: registered
`external-hog-kill-breaker` in `SELF_ACTION_CONTROLLERS` — and unlike the seeded entries, the
model drives the REAL pure brake (`isBreakerTripped`/`recordKill` from ExternalHogKillLedger), so
the ratchet proves the shipped code converges, not a re-model. Pinned worst case: the same
respawn-surviving signature sustained-hot on every scan forever → kills settle at K=3 within the
rolling window (2N horizon = exactly one window, settle-is-real exact), then the brake holds; the
real steady state is the rate bound ≤K/window/signature with one deduped degradation, ledger
pruned to retention. `@self-action-controller` marker added to ExternalHogSentinel.ts. Convergence
ratchet green (30 tests).

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` → closure **guard**. The sentinel is a self-triggered kill controller (a
60s scan loop that can signal processes), i.e. the class's exact subject. Guard: registered
`external-hog-kill-breaker` in `SELF_ACTION_CONTROLLERS` (src/testing/selfActionRegistry.ts),
covered by the convergence ratchet `tests/unit/self-action-convergence.test.ts` (enforcement:
ratchet). The model drives the REAL pure brake functions (`isBreakerTripped`/`recordKill` from
src/monitoring/ExternalHogKillLedger.ts — K=3 per rolling 1h window per signature, class-level
fallback for volatile keys) under the pinned always-respawning fixture and settles at 3 kills,
horizon-independent within the window; the real steady state is rate-bounded at ≤K/window/signature
with one deduped degradation, ledger pruned to retention. Marker `@self-action-controller:
external-hog-kill-breaker` sits in src/monitoring/ExternalHogSentinel.ts for the forcing lint.
