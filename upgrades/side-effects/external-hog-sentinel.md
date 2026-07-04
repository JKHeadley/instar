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
