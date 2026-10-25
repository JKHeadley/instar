# Side-Effects Review — ContextWedgeSentinel 1ms tick + the undefined-erasing-default class

**Version / slug:** `wedge-sentinel-undefined-tick`
**Date:** `2026-09-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — concur (round 2)`

## Summary of the change

`ContextWedgeSentinel` scanned every live session every ~1ms instead of every 20s.
`server.ts` builds its cfg as `{ enabled, tickIntervalMs: wedgeCfg.tickIntervalMs,
confirmWindowMs: wedgeCfg.confirmWindowMs }`; with the shipped config
(`{"enabled": true}`, or the `?? { enabled: true }` fallback) both timing keys are
explicit `undefined`, and the constructor's `{ ...DEFAULT_CONFIG, ...cfg }` copied
them over the defaults, so `setInterval(tick, undefined)` ran at Node's 1ms floor.
Each tick synchronously captured every live session's tmux pane
(`execFileSync tmux capture-pane`). Measured on inspec (5 live sessions, v1.3.1248):
78% of main-thread samples inside `SyncProcessRunner::Spawn`, 680 captures in a 20s
CPU profile, `/health` p50 52ms. That lag expired the 250ms Telegram origin capacity
grant (two lifeline IPC round-trips), so 34% of inspec's send attempts over 7 days
were held as `credential-capacity-unavailable` and recovered on the 15-minute pacing —
replies 5–25 minutes late and out of order. instar-codey measured 83%.

The change:
- **`src/core/mergeDefaults.ts` (new):** `mergeDefaults(defaults, ...overrides)` —
  spread semantics except an `undefined` override value never erases the value to
  its left (`null`, `false`, `0` are applied). Keys are written with
  `Object.defineProperty`, so a JSON `"__proto__"` key stays an own property exactly
  as spread leaves it (plain assignment would re-parent the object). `resolveTimerMs(value, fallback, floor)`
  — non-finite → fallback, below floor → floor.
- **`src/monitoring/ContextWedgeSentinel.ts`:** uses both; tick floored at
  `MIN_TICK_INTERVAL_MS = 1000`; confirm window falls back on non-finite but keeps
  small finite values (the e2e uses 20ms). New read-only `effectiveTiming` getter.
- **96 of the 98 instances in `src/` converted** (95 to `mergeDefaults(...)`, the
  sentinel's own included; one — a pure key-union in `routes.ts` — became an explicit
  `new Set([...Object.keys(...)])`), across 82 files. The remaining 2 live in
  `src/core/InboundDeliveryStore.ts`, a Stage-B CERTIFIED file whose edit requires a
  fresh approved canary + fingerprint rebind; both take overrides from JSON config
  (which cannot carry `undefined`). They are a capped (`max: 2`), reasoned lint
  allowlist entry tracked as ACT-1291 for the next rebind — any third violation in
  that file still fails. `mergeDefaults.ts` is recorded in the Stage-B manifest's
  `excluded` list (reached only via the already-excluded `SessionLivenessOracle.ts`);
  the certified fingerprint is unchanged (`stage-b-certified-fingerprint.mjs --check` OK). Covers `{ ...DEFAULTS, ...x }` and
  its `...(x ?? {})`, multi-line, three-way, member/element-access
  (`mod.DEFAULT_X`, `DEFAULT_LIMITS[trust]`), `*_DEFAULTS`, `this.configDefaults`,
  factory-call (`defaultCounters()`) and trailing-explicit-key variants. Sites with
  trailing explicit keys became `{ ...mergeDefaults(D, x), k: v }` so the explicit
  keys keep EXACT spread semantics.
- **`scripts/lint-no-undefined-erasing-default-merge.js` (new)** in the `lint`
  chain, built on the TypeScript AST (a first regex/stripper version was
  desynchronised by regex literals and nested templates — the second-pass review
  caught it): refuses an object literal in which a spread whose REFERENCE name says
  "default" is followed by any later spread, and the `Object.assign` equivalent.
  Replayed against the base tree it finds all 98 instances. Registered in
  `tests/unit/lint-chain-completeness.test.ts` REQUIRED_LINTS so a merge cannot drop it. Exit 2 (never a false
  clean) when nothing parses. Unit tests pin caught/ignored shapes, including
  regex-literal and nested-template fixtures, and assert the live tree is clean.
- `SystemReviewer`'s inline undefined-filter (the prior local fix for the same class)
  is replaced by the helper.

## Decision-point inventory

- `ContextWedgeSentinel` scan cadence — **modify** — restored to the documented 20s
  default; floor added. Detection, confirm, recovery policy and escalation unchanged.
- The 96 converted constructors/resolvers — **pass-through** — no decision logic
  changes; only the undefined-erasure is removed.
- No new decision point, gate, or blocking authority.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The lint is a build-time check
on source code, not a runtime gate. Its only "over-block" risk is flagging a
legitimate merge where undefined-erasure was intended; none exists in src/ (every
default in these sites is a `Required<>`/concrete value that downstream code reads
unconditionally), and the escape is the helper or `{ ...mergeDefaults(D, x), k: undefined }`
which still lets an author set an explicit undefined deliberately.

---

## 2. Under-block

No runtime block/allow surface. Lint blind spot (stated in its header): a defaults
object held under a name that does not say "default" (`{ ...base, ...cfg }`) is
invisible to it. Timers whose period comes from config WITHOUT any default at all
(`setInterval(fn, this.opts.tickMs)` with no fallback) are a sibling mechanism this
lint does not see; the audit of every `x: fooCfg.x` pass-through in server.ts found
each receiver either converted here or resolving with `?? default`
(CoherenceJournal, PromiseBeacon, AutonomousProgressHeartbeat, ProactiveSwapMonitor,
SleepWakeDetector, AmbientContributionGate, SingleInstanceLock).
`ReleaseReadinessSentinel` carries the same `tickIntervalMs: rrCfg.tickIntervalMs`
pass-through into a spread-merge, but it is NOT a live loop: its `start()` is never
called in production (the release-readiness-check job drives `tick()` via a route)
and its persisted config supplies every timing value. It is converted anyway.
`RopeHealthMonitor` merges defaults that drive a `setInterval` the same way; none of
its callers passes an explicit undefined today, and it is converted too.

---

## 3. Level-of-abstraction fit

Right layer. The defect lives where defaults meet overrides; fixing it at the merge
(a shared helper) fixes every caller shape at once instead of asking each wiring site
to pre-filter. The lint sits at the same layer as the existing structural lints
(`lint-no-unfunneled-tmux-literal-send`, etc.) and follows their conventions
(comment-stripping, direct-invocation guard, exported helpers + unit tests). The
timing floor belongs in the sentinel because only it knows a scan is expensive.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The sentinel remains a detector (regex + confirm window) feeding a bounded recovery
primitive; this change only repairs its scheduling. The lint is a CI check.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 1s tick floor is
an invariant (a wedge is a permanent state; sub-second rescans add nothing but load).

---

## 5. Interactions

- **Shadowing:** none. The sentinel's `isRecoveryActive` feeds the SessionReaper
  veto exactly as before; with a correct cadence a wedge is detected up to 20s later
  than under the bug — the documented design.
- **Double-fire:** none added. The bug itself caused excessive `withSyncOp` marker
  writes (every capture writes `tmux-inflight-sync-op.json` twice) — the fseventsd
  load seen 2026-09-14; the fix removes ~99.9% of that write volume on affected agents.
- **Races:** none. Conversions are constructor-time pure merges.
- **Feedback loops:** the bug was a feedback loop between event-loop lag and the
  origin capacity grant (lag → grant expiry → 15-minute recovery → late, out-of-order
  replies → users re-sending → more load). The fix removes the lag source.

---

## 6. External surfaces

- **Other agents / install base:** every agent whose config omits
  `monitoring.contextWedgeSentinel.tickIntervalMs` (the shipped default) stops
  spinning — lower CPU, lower tmux-server load (the tmux server is shared by all
  agents on a machine), faster server responses, far fewer held Telegram sends.
- **Persistent state:** none written or migrated. Agents that were hand-patched with
  an explicit `tickIntervalMs` (done on this machine 2026-09-21 as a stopgap) are
  unaffected — explicit values are honoured.
- **Timing:** wedge detection now happens on its designed 20s cadence (was ~1ms).
- **Operator surface:** No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the sentinel scans the sessions running on the machine it
runs on, and its cadence is per-process. No user-facing notices added, no durable
state, no URLs. The merge helper is pure.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no config
migration. Rolling back would reintroduce the 1ms loop on agents without an explicit
`tickIntervalMs`; the per-agent config stopgap (explicit `tickIntervalMs: 20000`)
neutralises that without a release.

---

## Conclusion

The second-pass review changed the design in three ways: the lint was rebuilt on
the TypeScript AST after the first version was shown to miss files containing regex
literals; twelve further instances in forms the first lint could not see were
converted; and the helper now writes keys with `defineProperty` to keep spread's
own-property semantics for a `"__proto__"` key. A claimed second live loop
(ReleaseReadinessSentinel) was corrected: it is not started in production. No design
changes were needed beyond keeping trailing explicit keys on exact spread semantics
(`{ ...mergeDefaults(D, x), k: v }`) so the conversion changes nothing but the
undefined-erasure. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only), two rounds
**Independent read of the artifact: concur** (round 2)

Round 1 raised CONCERN with four specific issues, all resolved before commit:
- The first (regex/stripper) lint was desynchronised by regex literals and nested
  templates, missing 3 of 86 base-tree instances → lint rebuilt on the TypeScript
  AST; replay against the base tree now finds all 98.
- Seven same-class raw merges outside the first lint's name/shape reach
  (RopeHealthMonitor, MoneyLayerEnableSurface, server.ts inbound-queue configs,
  InboundMessageGate, routes.ts key union, TopicFrameworksStore,
  TopicLocalModelStore) → converted, plus five more the AST lint surfaced.
- The ReleaseReadinessSentinel "live 1ms loop" claim was false (its `start()` is
  never called in production) → corrected in this artifact and the upgrade note.
- `out[key] = value` diverged from spread for a JSON `"__proto__"` key (prototype
  setter) → `Object.defineProperty`, with a parity unit test.

Round 2 verdict: "VERDICT: CONCUR" — the reviewer's own independent AST scan finds
zero remaining raw defaults merges, tsc exits 0, focused tests pass (85).

---

## Evidence pointers

- Incident measurements (2026-09-21, inspec v1.3.1248): `sample` 78.2% main-thread
  in `SyncProcessRunner::Spawn` (codey 83.0%, echo 0.6%, sagemind 9.6% — sagemind's
  config pins `tickIntervalMs: 20000`); CDP CPU profile 91.4% of spawn time under
  `ContextWedgeSentinel.tick → scanSession → getRecentOutput`; 680 captures/20s with
  5 sessions. After the config stopgap + restart: 0.6% spawn, `/health` p50 3ms.
- Origin attempts (7d, inspec): 389/1131 `credential-capacity-unavailable`;
  272 of those had NO concurrent send within ±1.25s (not the 10/1.25s rate cap).
- Tests: `tests/unit/core/mergeDefaults.test.ts` (11),
  `tests/unit/monitoring/ContextWedgeSentinel.test.ts` (+5 regression),
  `tests/integration/context-wedge-sentinel-wiring.test.ts` (+1 cadence through
  `buildContextWedgeDeps`), `tests/e2e/context-wedge-sentinel-lifecycle.test.ts`
  (+1 real-timer: no scan in the first 300ms with the shipped cfg shape),
  `tests/unit/lint-no-undefined-erasing-default-merge.test.ts` (18, incl. regex
  literal / nested template fixtures, live tree clean, and exit 2 on no-parse),
  `tests/unit/core/mergeDefaults.test.ts` (12, incl. `__proto__` parity). The integration cadence test FAILS against the pre-fix sentinel
  (captures before the 20s period) and passes after.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (a monitor tick fired without a
  frequency bound — ~1000/s — because its period was erased).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{ enforcementType: lint, citation:
  scripts/lint-no-undefined-erasing-default-merge.js, howCaught: the lint refuses
  the { ...DEFAULT_CONFIG, ...cfg } merge that let tickIntervalMs: undefined erase
  the 20s default, so the constructor can only resolve its period through
  mergeDefaults (undefined never erases) + resolveTimerMs (non-finite → default,
  < 1s → 1s). Convergence: control-loop edge = tick → per-session capture →
  detected → confirm → recoverFn (SessionRefresh, rate-guarded); steady-state bound
  = at most one scan pass per tickIntervalMs ≥ 1s (default 20s) and at most one
  in-flight wedge state per session; settling brake = state is retained after
  dry-run/escalation so the same wedge is never re-reported, and recovery is
  opt-in + SessionRefresh-rate-limited. }`
- **`gap`** — n/a.
