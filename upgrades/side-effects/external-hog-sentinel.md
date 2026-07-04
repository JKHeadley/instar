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

## Phase 5 — Second-pass review

REQUIRED (touches "sentinel" / kill-adjacent decision logic). Two decision-adjacent slices
have landed with independent review: the floor (3) and the CPU-delta signal (4).

### Slice-3 (floor) reviewer verdict

### Reviewer verdict

**Round 1 — Concern raised (VALID, fixed):** the module header + Slice-3 review claimed an
ABSOLUTE fail-closed guarantee, but 4 of 8 hard invariants (`isInstarProcess`,
`ownerRootDaemon`, `hasLaunchctlLabel`, `ownerAppRunning`) were tested with plain truthiness
`if (facts.X)`, so a missing/`undefined` value would fail OPEN (skip the veto). Masked today
by the required TS types + the sampler contract, but a kill floor must not delegate its
fail-closed property to the type system or sampler correctness — exactly the layer that
degrades under the starvation this sentinel hunts (a sampler that times out computing
`ownerAppRunning` and drops the field would yield a permitted kill of a never-established
orphan). The reviewer also confirmed everything else sound: no path initiates a kill (pure,
permit-or-veto return), the only `permitted:true` is after all guards, the anchored regex
rejects spoofed suffixes, euid===0 refused before uid-equality, attacker name/argv inert
beyond the allowlist.

**Resolution:** added a leading STRICT-boolean guard (step 0) — any required boolean that is
not a genuine `boolean` VETOES with `field-unknown:<field>` — so `undefined`/non-boolean now
fails CLOSED, matching the header claim. Added 6 fail-closed fixtures (each of the 5 required
booleans dropped → veto; a non-boolean string → veto). 30 tests pass, typecheck clean.

**Round 2 — Concur.** The independent reviewer re-checked the fix and CONCURRED: the
step-0 strict-boolean guard runs before every truthiness check and vetoes with
`field-unknown:<field>` on any non-boolean among the 5 required booleans, so a
dropped/undefined field fails CLOSED; valid-boolean cases pass step 0 and still hit their
specific vetoes (no regression, confirmed by the 30 passing tests incl. the 6 new
missing-field/non-boolean fixtures). The original fail-open concern is fully closed.

### Slice-4 (CPU-delta) reviewer verdict

**Round 1 — Concern raised (VALID, fixed):** `computeCoreEquivalents` guarded an
implausibly-LARGE Δwall but had NO symmetric guard for an implausibly-SMALL Δwall — the
FALSE-HIGH (dangerous) direction. Since `ps time=` is 1-second-quantized, a sub-window
interval inflates the ratio: `computeCoreEquivalents(s(0,0), s(1,200), {window:30_000})` →
1/0.2 = 5.0 cores from an IDLE process, and `meetsThreshold(5.0,1.5)===true` — a false
sustained hog. The reviewer confirmed everything else sound (monotonic clock; large-Δwall,
non-positive, decreasing-counter, non-finite all fail closed; no other false-high path).

**Resolution:** added the symmetric lower bound — `dWallMs < intendedWindowMs / factor →
CPU_DELTA_UNKNOWN` — mirroring the large-side guard, so a sub-window interval fails CLOSED.
Added the reviewer's exact fixture (200ms interval → UNKNOWN, never a hog) + fixed the
"single core" test to sample a full window. 13 tests pass, typecheck clean.

**Round 2 — Concur.** The reviewer re-checked and CONCURRED: the symmetric lower bound
`dWallMs < intendedWindowMs / factor` (7500ms for a 30s window) fails the sub-window
false-high closed (the s(0,0)→s(1,200) fixture returns UNKNOWN); the [0.25×, 4×] accepted
band still passes the full-window and 90s-jitter cases; both bounds sit inside the
`intendedWindowMs > 0` block so a zero window disables them together as documented.

### Slice-5 (arm-marker) reviewer verdict

**Concur (no bug — carefully written after the slice-3/4 lessons).** The reviewer verified
all three properties fail CLOSED on every undefined/null/NaN/wrong-type/equal-epoch/proto-key
input: `isMarkerValid` rejects a falsy marker + non-finite epochs + uses strict `>` (equal
epochs INVALID, so disarm-at-same-epoch wins and the disarm→config→restart bypass is closed);
`classContentHash` is deterministic + change-sensitive (any realistic broadening → new hash →
rejected); `classIsArmed`'s `typeof armedHash === 'string'` guard blocks `undefined===undefined`
AND neutralizes prototype-chain keys (`__proto__`, `toString`); `canKillLive` requires
enabled===true + dryRun===false (`!== false` rejects dryRun:undefined/0/missing) + valid marker
+ armed class, with no path letting `config.dryRun:false` alone authorize.

### Slice-6 (kill-ledger / P19) reviewer verdict

**Round 1 — Concern raised (VALID, fixed):** `isBreakerTripped`'s fail-safe guard only tripped
on NON-FINITE window inputs, but a NON-POSITIVE `windowMs` (≤0 — finite) slipped past →
`since = now - windowMs >= now` → count collapses to ~0 → spurious NOT-tripped (the dangerous
unbounded-loop direction). Also flagged the `retentionMs >= windowMs` caller precondition
(recordKill can't see windowMs, so a shorter retention would prune in-window kills and
undercount). Everything else confirmed sound (per-key counting, `>=` trip, cross-key
isolation, boundary at now-window excluded, volatile→class fallback, in-flight pid+startTime
keying + TTL/confirmed-exit/non-finite eviction).

**Resolution:** the guard now trips unless windowMs AND maxPerWindow are BOTH finite AND
positive (`Number.isFinite(x) && x > 0`) — closing ≤0 and Infinity together. Documented the
`retentionMs >= windowMs` precondition on recordKill + a test proving the breaker still trips
at K when retention == window. 16 tests pass (added: ≤0/negative window trips, maxPerWindow:0
trips, retention==window still trips at K). Typecheck clean.

**Round 2 — Concur.** The reviewer re-checked and CONCURRED: the finite-AND-positive guard
closes the ≤0/negative/Infinity window and non-positive maxPerWindow gaps (all trip); the
retention==window test genuinely exercises the prune/window boundary (a shorter retention would
have pruned to 2 and not tripped — a real undercount guard, not a trivial pass); the change is
strictly stricter (positive path untouched), so no new spurious-not-trip path.

### Slice-7 (ownership walk) reviewer verdict

**Concur (no bug).** The reviewer verified adversarially that no path yields a false `true`
(owned) for an EXTERNAL process: to return owned the walk must reach a pid in `ownedRefs`
whose snapshot start-time matches — and both the tree and ownedRefs are built by instar from a
real `ps` read (the attacker controls neither); a recycled pid's start-time can never match the
recorded instar `lstart`, so pid-reuse spoofing is structurally defeated. Bounded (hop-bound +
`seen` cycle-guard). Every uncertainty (ppid-not-in-tree, cycle, hop-bound, ppid≤1, invalid/
NaN/negative inputs) fails to NOT-owned (the anti-evasion direction). The candidate-itself case
is checked before the ppid≤1 stop, so an owned root pid is detected.

### Slice-9 (ps parser) reviewer verdict

**Concur (no bug; one strict-only tightening applied).** The reviewer verified adversarially
that no realistic ps input yields a spuriously-high `cputimeSeconds` or a mis-attributed pid:
the `time=` column is ps-generated and LEFT-anchored (t[8]), comm is strictly rightward and its
control chars are ps-ESCAPED (empirically `\n`→`\012` on macOS, so no fabricated-row injection
via a newline in argv), a malformed time fails CLOSED to `undefined` (never a spurious number),
and <10-token / non-numeric-pid rows are skipped. Fixture honesty confirmed (dd- anchor,
embedded-space lstart+comm, <defunct>, malformed short; same-length redactions; honest
representative-vs-live meta). The one residual it flagged — an unbounded `(\d+:)*` in the time
regex, unreachable via t[8] — was tightened to `{0,2}` colon groups (strictly toward
fail-closed; accepts every valid `[dd-]hh:mm:ss.ff`), all 5 tests still pass.

### Slice-10 (sampler candidacy) reviewer verdict

**Round 1 — Concern raised (VALID cross-module bug, fixed).** All candidacy gates trace
correct (first-sight/uid/instar-own/unknown-cputime/UNKNOWN-delta skip; only core>=threshold
emits; pid-reuse → different key → first-sight; heartbeat advances only on a plausible parse;
map rebuilt each tick). BUT `computeCoreEquivalents` gated BOTH Δwall guards behind
`if (intendedWindowMs > 0)`, so a ≤0 `sampleWindowMs` (which advanceSampler passed through raw)
would SKIP the guards → a tiny inter-tick Δwall + a 1s quantization tick inflates the ratio
(1 CPU-s / 0.05s = 20 cores) → a FALSE stage-1 candidate. (Bounded: the §4 worker-side
micro-check still blocks an actual kill — so impact is candidate noise + classifier spend, not
a false kill — but a genuine false-candidate path in a kill pipeline.)

**Resolution:** made `computeCoreEquivalents` fail CLOSED on a non-positive window
(`intendedWindowMs <= 0 → CPU_DELTA_UNKNOWN`), so both bounds now apply unconditionally like
every other guard (matching the module's fail-closed philosophy). Added a CPU-delta test (≤0
window → UNKNOWN) and a sampler test (≤0 sampleWindowMs → no false candidate). 28 tests pass.

**Round 2 — Concur.** The reviewer re-checked and CONCURRED: the ≤0-window guard sits after
the finite + non-positive-Δwall guards so 0/-1 fail closed before any ratio; the large/small
Δwall guards now run unconditionally but are behaviorally identical for a positive window (no
regression — the math/jitter/large/small/decreasing cases all still hold); and the sampler
emits no false candidate under a ≤0 window (UNKNOWN → skip). Concern fully resolved.

### Slice-11 (classifier orchestration) reviewer verdict

**Concur (no bug; one trivial nit hardened).** The reviewer verified adversarially that
`parseClassifierVerdict` gates on a strict `===` allowlist of exactly {'kill','leave','alert'}
applied only to `raw`/`.action` (never reason/pid/argv), so every adversarial input — extra/
nested fields, `KILL`, `'kill; rm'`, whitespace, arrays, numbers, JSON-string `'"kill"'`, and
`__proto__` pollution (JSON.parse sets it as an own data prop, leaving `.action` undefined) —
falls through to `null → alert`. Selection (worst-CPU-first, over-cap + non-positive-cap both
degrade to alert, deterministic non-attacker tie-break) and the cache (full-tuple key so a
reused pid misses, correct TTL/LRU, non-finite now/ttl → miss at read) are sound. The one nit
— a NaN-clock `cacheSet` storing an immortal entry (not attacker-reachable, not a false-kill
path) — was hardened: `cacheSet` now returns the cache unchanged on a non-finite `nowMs`.

### Slice-12 (kill funnel) reviewer verdict

**Concur (no bug — the hardest review, clean).** The reviewer traced every signal-reachable
path adversarially and confirmed the WATCH-ONLY guarantee is AIRTIGHT: dryRun:true / not-armed /
disarmed all return `would-kill` at the pre-SIGTERM reCheck BEFORE any sendSignal (canKillLive
fails closed on config.dryRun!==false, marker null, and armEpoch<=lastDisarmEpoch). Even the
SIGTERM is gated by canKillLive + floor + class-re-match. SIGKILL is STRUCTURALLY IMPOSSIBLE
after a mid-grace disarm / identity-change / floor-veto — it requires reCheck to return null at
BOTH checkpoints, and every error/uncertainty path (a throwing dep, a would-kill post-grace)
aborts toward no-kill. The one residual — the funnel can't detect a dep that LIES about live
state — is the correct DI boundary (deps are contracted to read live; the epoch/content-hash
safety is proven airtight in ExternalHogArmMarker, which canKillLive ANDs), and the inherent
re-check→SIGKILL TOCTOU is unavoidable and placed as late as feasible (only the protective
fd-probe follows, which can only PREVENT a kill).

### Slice-13 (scan-tick orchestrator) reviewer verdict

**Round 1 — Concern raised (VALID observability bug, fixed).** The composition is correct: the
funnel is reached ONLY after verdict==='kill' && floor.permitted && !breaker-tripped (every
other branch `continue`s); recordKill fires ONLY on outcome.action==='killed' (would-kill/
deferred/aborted don't record → watch-only never trips the breaker); over-cap + breaker-tripped
+ leave + veto + decider-unavailable all surface. BUT a candidate with LIVE facts (present hog)
but a null `identityFor` was filtered out with NO notice + NO kill — the exact invisible-hog
failure §4 exists to prevent. Since the natural `identityFor` computes classId via
matchAllowlistClass (null for every non-editor hog), that whole broad-hog class would be silently
dropped, making the floor's outside-allowlist-surface branch dead code.

**Resolution:** the enrichment loop now SURFACES a present hog with a null identity as a
`hog-left-alive` notice (signature `pid startTime`) and skips only the VANISHED (factsFor-null)
case silently. Added a test (present hog + null identity → surfaced, no signal, not in outcomes).
7 tests pass.

**Round 2 — Concur.** The reviewer re-checked and CONCURRED: a present hog with a null identity
is now always surfaced as hog-left-alive (never silently dropped); the vanished factsFor-null
case is still correctly skipped without a notice; and the killed/would-kill/leave/veto/decider
paths + the funnel gating are unchanged (only fully-identified candidates reach the classify loop).
