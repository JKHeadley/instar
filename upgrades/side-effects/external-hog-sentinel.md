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
