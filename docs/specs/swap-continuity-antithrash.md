---
slug: swap-continuity-antithrash
title: Swap Continuity Under Pressure — Anti-Thrash Brakes + In-Flight Work Deferral (Roadmap 4.4, F3/P1-A6)
status: draft
eli16-overview: swap-continuity-antithrash.eli16.md   # authored at convergence, per house convention
constitution: Bounded Blast Radius (a quota optimization must not silently expand into "all my subagents were killed"); Structure > Willpower (the anti-thrash rule lives at the swap chokepoint, not in prose); The User Experience Is the Product (F-series umbrella — the safety/continuity mechanism must not BE the disruption)
earned-from: 2026-07-02 proactive-swap thrash day (echo dev agent, v1.3.722 — 36 executed proactive swaps / 72 [SessionRefresh] account-swap log lines across 8 waves; repeated kills of six parallel build subagents during the U4 and Session-A autonomous runs); F3 finding family (inbound eaten by respawn) and P1-A6
roadmap: Session A item 4.4 — "Continuity under pressure: proactive/reactive swap + model-swap + refresh defer while a turn or live subagents are in flight, or re-inject the last unanswered inbound + enumerate killed subagents"
review-convergence: null   # DRAFT — has not entered the convergence ceremony
approved: false
---

# Swap Continuity Under Pressure (roadmap 4.4 + thrash brake)

Two composable pieces, independently shippable, sharing one observability spine:

1. **Anti-thrash brakes on the proactive account swap** — stop the ping-pong that
   moved the same sessions between the same hot accounts 3× in 27 minutes.
2. **In-flight work deferral** for every session-killing mutation (proactive swap,
   model-swap, agent/API refresh) — a swap waits for the turn/subagents to land,
   bounded by a ceiling; only a genuine wall may override, and then only with the
   F3 mitigations (enumerate killed subagents, re-inject the last unanswered
   inbound).

Piece 1 removes most of the kills. Piece 2 makes the remaining, genuinely-needed
kills non-destructive to in-flight work. They compose but do not depend on each
other.

---

## 1. What broke, stated honestly (the 2026-07-02 evidence)

All timestamps 2026-07-02 UTC, from `logs/server.log` on the echo dev agent
(v1.3.722, `subscriptionPool.proactiveSwap.enabled: true` with shipped defaults).

**Volume.** 36 executed proactive swaps in one day (each `[ProactiveSwap] …
pre-emptively swapped off A → B` line), in 8 waves (05:45, 08:19–08:22,
09:19–09:23, 12:33–12:36, 15:22–15:25, 16:34–16:37, 16:46–17:01, 20:48–20:51).
Each swap emits two `[SessionRefresh] account-swap` lines
(onboarding-readiness + transcript-continuity) — the 72 events observed. Every
observed session respawn that day matches one of these swaps.

**Thrash proof — the same sessions, round-tripped between the same accounts:**

| time (UTC) | session | swap |
|---|---|---|
| 15:22:17 | echo-llm-pathway-characterization | adriana → justin-gmail |
| 16:34:25 | echo-llm-pathway-characterization | justin-gmail → adriana |
| 16:46:43 | echo-llm-pathway-characterization | adriana → justin-gmail |
| 16:58:38 | echo-llm-pathway-characterization | justin-gmail → sagemind-justin |

`echo-instar-evolution` and `echo-postmortem-silent-loss-blind-spots` show the
same 16:34 → 16:46/16:49 → 16:58/17:01 reversal pattern. Twelve minutes between
reversal waves — just past the 10-minute per-session cooldown, so the cooldown
never braked anything.

**The simultaneous source-and-target signature.** At 16:46:39 one session was
swapped OFF justin-gmail (→ sagemind-justin); at 16:46:41 — two seconds later —
two sessions were swapped ONTO justin-gmail (adriana → justin-gmail). The same
account was "at pressure, evacuate" and "eligible target, move here" inside one
monitor tick. That is not a tuning problem; it is a decision-consistency seam
(§2.2).

**Cost.** Each swap is a kill+respawn (`SessionRefresh` → `killSession` →
respawner). Killing the session kills every in-flight Agent-tool subagent and
interrupts the session's turn. During the U4 and Session-A autonomous runs, six
parallel build subagents were killed repeatedly by these respawns — the F3
finding family, filed upstream. The continuity mechanism (never die at the quota
wall) became the primary source of work destruction on the agent — the same
inversion as the 2026-06-25 reachability postmortem ("the safety mechanism
BECAME the outage").

**What the feature got right, kept:** the reactive continuity guarantee (a
session that hits a real wall resumes on another account, never dies) is
correct and is explicitly untouched by this spec (§3.4, invariant I6).

## 2. Root cause, grounded in the code

### 2.1 No hysteresis anywhere in the loop

- Source pressure: a session is a candidate when its effective account's
  binding-window utilization ≥ `thresholdPct` (80) —
  `ProactiveSwapMonitor.mapCandidates` → `accountAtPressure(acct, minPct)`
  (`src/core/ProactiveSwapMonitor.ts:277-301`, predicate at
  `src/core/QuotaAwareScheduler.ts:160-165`).
- Target eligibility in the monitor's own precheck: an alternate exists below
  the SAME 80 (`src/core/ProactiveSwapMonitor.ts:226-231`).
- So an account pair hovering at 79/81 oscillates on poll jitter: 81 evacuates
  to 79; the landed sessions push 79 over 80 while the drained account's
  5h-window reading drifts back under; the reciprocal swap follows next wave.
  There is no "target must be MATERIALLY better" bound and no dwell longer than
  10 minutes (`cooldownMs` default 600 000, `src/core/ProactiveSwapMonitor.ts:137`),
  which the 12-minute wave period cleared every time.

### 2.2 The double-threshold seam: the checked target is not the executed target

The monitor prechecks "an alternate below 80 exists"
(`src/core/ProactiveSwapMonitor.ts:226-231`, `selectAccount(…, {softThresholdPct:
this.thresholdPct}, c.accountId)`), then executes via the injected swap
(`src/core/ProactiveSwapMonitor.ts:248-256`) which is wired to
`QuotaAwareScheduler.onQuotaPressure` (`src/commands/server.ts:16028-16031`).
`onQuotaPressure` **re-selects the target itself**
(`src/core/QuotaAwareScheduler.ts:224-228`) with a DIFFERENT threshold — the
scheduler's `softThresholdPct` = `config.subscriptionPool.swapSoftThresholdPct`,
default **90** (`src/core/QuotaAwareScheduler.ts:41`, wiring at
`src/commands/server.ts:15938`).

Consequences when the pool is hot (everything measuring 80–89%):

- The monitor's precheck can pass on one account while `onQuotaPressure`
  executes onto a different one, because `selectAccount`'s use-before-reset
  scoring (`scoreAccount`, `src/core/QuotaAwareScheduler.ts:79-89`:
  `unusedHeadroom × 1/hoursUntilReset`) actively PREFERS a soon-resetting
  account at 85% over a far-resetting one at 60%. Correct for reactive draining
  ("use it before it resets — you're dead anyway"), wrong as a proactive
  optimization: it moves a live session onto an account that is itself at
  pressure by the monitor's own definition. That is the observed "least-bad
  target that itself measures ≥80%".
- Poll-lag double-counts compound it: the target's reading trails the landed
  sessions' burn by up to a poll interval, so the target looks better than it
  is at decision time and crosses 80 minutes later — manufacturing the next
  wave's source.

### 2.3 Nothing consults in-flight work before the kill

`SessionRefresh.refreshSession` kills unconditionally
(`this.deps.sessionManager.killSession(stateSession.id)`,
`src/core/SessionRefresh.ts:348`). Its only guards are the per-session
rate-counter (5 per 10 min, `src/core/SessionRefresh.ts:204-205`) and the
in-flight-REFRESH guard (`src/core/SessionRefresh.ts:216` — prevents two
concurrent refreshes, not a refresh during work). The kill is what destroys
subagents and eats the turn.

Meanwhile the codebase already HAS both detection primitives, used elsewhere:

- **In-flight turn:** `SessionManager.isSessionActivelyWorking(tmuxSession)`
  (`src/core/SessionManager.ts:3095-3105`) — true when the captured pane shows
  Claude Code's mid-turn footer (`paneShowsClaudeWorking`,
  `src/core/claudeActivityIndicators.ts:30-44` — "esc to interrupt" family) OR
  the session has a live non-baseline child process. Built for
  compaction-recovery exactly because a long extended-think writes nothing to
  JSONL until the turn lands.
- **Live subagents:** `SubagentTracker.hasActiveSubagents(sessionId)`
  (`src/monitoring/SubagentTracker.ts:163-165`, O(1) in-memory) and
  `getActiveSubagents(sessionId)` (`:151-153`, returns `agentType`/`startedAt`
  per record — enumeration-ready). Keyed on the Claude session id; the state
  session record already carries it (`stateSession.claudeSessionId`, used at
  `src/core/SessionRefresh.ts:396`).
- **Prior art for gating on them:** the model-swap engine already refuses
  non-idle sessions (`paneIdleWithEmptyInput`,
  `src/core/ModelSwapService.ts:119-136` — fail-closed, refusal is retryable),
  and the reaper's `terminateSession` re-checks keep-conditions including
  active-subagent before a pressure kill (`src/core/SessionManager.ts:1034`).
  The account-swap path is the only session-killing mutation with NO work gate.

### 2.4 Brake state is in-memory only

`ProactiveSwapMonitor.lastSwapAt` (`src/core/ProactiveSwapMonitor.ts:127`) dies
with the server process. On a restart-heavy day (the sleep/wake crash-loop
family) every cooldown resets to zero.

---

## 3. Piece 1 — Anti-thrash brakes on the proactive swap

All brakes live at the proactive DECISION chokepoint
(`ProactiveSwapMonitor.evaluate`). The reactive path is untouched (§3.4).

### 3.1 Brake (a) — the all-hot brake

**Rule:** a proactive swap is REFUSED unless at least one eligible target
measures below the **target ceiling** (§3.3). When every alternate is at/above
the ceiling, the pool is "all hot": staying on the least-used account is as
good as moving — the move buys no material margin and costs a kill+respawn.
Only a hard rate-limit wall justifies a move then, and that is the reactive
path's job.

Refusal is per-candidate-session and logged with reason `all-hot` (§6). The
monitor keeps ticking; the moment a window resets and a genuinely-cool target
appears, proactive swapping resumes on its own.

**The honest tradeoff, argued.** A refused proactive swap can mean the session
hits the wall and takes the REACTIVE swap instead — one interruption at a
genuinely-forced moment. The alternative demonstrated on 2026-07-02 is N
proactive interruptions that buy nothing: each one kills subagents and eats a
turn, the landed sessions heat the target, and the wall often still arrives —
or never does (the 5h window resets before the wall on most waves; every one of
the 8 waves subsided without any observed hard wall). One reactive swap
strictly dominates N proactive thrashes:

- worst case with the brake = 1 forced interruption (reactive, with §4's F3
  mitigations attached);
- observed case without it = 3+ interruptions per session per afternoon, plus
  the wall risk unchanged (the thrash doesn't remove pressure, it relocates it).

What the brake gives up: the pre-wall margin in the narrow case where one
account is at 95% and every alternate sits at 80–84% — the swap that would have
avoided one reactive blip is refused. Accepted: that margin is exactly what the
reactive guarantee exists to absorb, and the blip costs one interruption
either way.

### 3.2 Brake (b) — per-session dwell

**Rule:** a session that was account-swapped (proactively OR reactively) within
the last `dwellMs` is not proactively swapped again. Refusal reason: `dwell`.

- Default `dwellMs`: **2 700 000 (45 min)** — chosen against the evidence: the
  16:34→16:46→16:58 reversals were 12 min apart; the standing wave period
  across the day was ~2.5–3 h. 45 min kills intra-wave ping-pong while still
  allowing one proactive rescue per standing wave. (The old `cooldownMs` 10 min
  demonstrably braked nothing; it is subsumed — see §8 migration.)
- Dwell also counts REACTIVE swaps as its clock-start (a just-rescued session
  is not immediately re-optimized), but dwell never BLOCKS a reactive swap
  (I6).
- Dwell state is persisted in the swap ledger (§3.5) so a server restart does
  not reset it (fixes §2.4).

### 3.3 Brake (c) — target-materially-better

**Rule:** the executed target must satisfy BOTH bounds, evaluated on the same
snapshot that the decision logs (§6):

1. **Absolute ceiling:** `bindingUtilization(target) < thresholdPct −
   targetHeadroomPct` — default ceiling **80 − 15 = 65%**. A target in the
   79%-band is never "better" in any way that survives the landed sessions'
   own burn plus poll lag.
2. **Relative improvement:** `bindingUtilization(source) −
   bindingUtilization(target) ≥ minImprovementPct` — default **15 points**.
   Guards the case where the source reading is barely over threshold (80–81%)
   and jitter alone created the "pressure".

**Closing the §2.2 seam (the load-bearing design decision):** the monitor
performs ONE authoritative target selection under these bounds and passes the
chosen target THROUGH the swap call — `cfg.swap` gains an optional
`targetAccountId`. `QuotaAwareScheduler.onQuotaPressure` honors an explicit
target instead of re-selecting, after re-validating it against a fresh
snapshot at execute time (target gone / no longer under the ceiling →
structured refusal `target-revalidation-failed`, retried next tick — never a
silent fallback to the 90-threshold re-selection). Reactive callers pass no
target and get today's behavior byte-for-byte, including the drain-first
scoring, which remains correct there. The checked target IS the executed
target (invariant I1), and the proactive and reactive paths stop sharing a
threshold they were never supposed to share.

Selection among targets under the ceiling stays `selectAccount`'s
use-before-reset scoring (drain the soonest-resetting COOL account first) —
the scoring was never the bug; applying it over the hot band was.

### 3.4 The reactive path is untouched

`autoSwapOnRateLimit` → `rate-limit:escalated` → `onQuotaPressure` with no
explicit target (`src/commands/server.ts:15965-15981`) keeps its exact
semantics: 90-threshold eligibility, drain-first scoring, `onNoAlternate`
attention item. A genuinely walled account still swaps, immediately, even in
an all-hot pool, even inside another session's dwell window. The brakes bind
the OPTIMIZATION, never the GUARANTEE. (Piece 2 adds only the short
mitigation grace + F3 payload to the reactive respawn — §4.3 — never a
refusal.)

### 3.5 Thrash detection + the swap ledger

Every proactive decision — executed, refused, deferred — and every reactive
swap is appended to a durable JSONL ledger: `state/swap-ledger.jsonl`
(`{ts, kind: proactive|reactive, decision: swapped|refused|deferred|proceeded,
session, topicId?, from, to?, fromUtilPct, toUtilPct?, reason, dwellRemainingMs?,
inFlight?: {turn: boolean, subagents: number}}`). The ledger is the restart-safe
source for dwell (§3.2) and reversal detection:

- **Reversal:** a proactive swap intent whose `(from,to)` is the inverse of the
  same session's most recent executed swap within `reversalWindowMs` (default
  **1 800 000, 30 min**). A reversal intent is refused outright (reason
  `reversal`) and increments the **thrash counter**.
- **Thrash episode / breaker:** ≥ `thrashBreakerThreshold` (default **2**)
  reversals pool-wide within `reversalWindowMs` opens a breaker that suppresses
  ALL proactive swaps for `thrashBreakerBackoffMs` (default **3 600 000, 1 h**),
  raises ONE deduped attention item ("proactive account-swap is thrashing —
  suppressed for 1h; accounts A/B/C all ≥80%"), and logs every suppressed
  intent with reason `thrash-breaker`. The breaker auto-half-opens after the
  backoff (P19 family: a guard's own failure mode must be bounded and loud,
  never a silent permanent off). Reactive swaps ignore the breaker (I6).

With brakes (a)+(c) working, reversals should be structurally impossible — the
breaker is the belt-and-suspenders detector that PROVES it, and the alarm if a
future change reopens the hole (the same role the guard-posture tripwire plays
for config flips).

---

## 4. Piece 2 — In-flight work deferral (the 4.4 core, F3/P1-A6)

### 4.1 The gate

A new small module — `SwapWorkGate` (`src/core/SwapWorkGate.ts`) — answers one
question at every session-killing mutation chokepoint: **does this session have
in-flight work right now?**

```
busy(session) :=
     sessionManager.isSessionActivelyWorking(session.tmuxSession)     // turn in flight (footer/child-proc)
  || (session.claudeSessionId != null
        && subagentTracker.hasActiveSubagents(session.claudeSessionId)) // live Agent-tool subagents
```

Grounding: both predicates exist today (§2.3) — the gate composes them, it
invents no new detection. Direction of uncertainty is caller-class-dependent
(I7): for a PROACTIVE/optimization caller, a failed pane capture or missing
`claudeSessionId` on the subagent leg resolves to **busy** (fail toward not
killing work — mirrors `paneIdleWithEmptyInput`'s fail-closed); for a REACTIVE
caller the same uncertainty resolves to **not busy** (fail toward the
continuity guarantee — a walled session must never be stranded by a broken
detector). Note the asymmetry inside the proactive arm: `claudeSessionId`
missing disables only the subagent leg's confidence, the footer leg still
decides; only when BOTH legs are unreadable does the proactive arm defer on
uncertainty, and such deferrals carry reason `busy-indeterminate` so a broken
detector is visible in the ledger rather than masquerading as real work.

### 4.2 Who consults it, and what "defer" means per caller

| Caller | Today | With the gate |
|---|---|---|
| ProactiveSwapMonitor (account swap) | kills unconditionally via refresh | busy → **defer**: keep the intent, retry each tick; the swap runs when the work lands. Bounded by `deferralCeilingMs`. At ceiling: **the wall wins** — the intent is DROPPED (reason `deferral-ceiling-dropped`), the session keeps working, and if the account genuinely walls the reactive path fires with §4.3 mitigations. Rationale: a proactive swap is an optimization; killing six subagents to pre-empt a wall that may never arrive inverts the priority order. Dropping is safe precisely because the reactive floor exists. |
| Reactive swap (`autoSwapOnRateLimit`) | kills unconditionally | busy → wait at most `reactiveGraceMs` (default **120 s**, single re-check cadence of 10 s) for the current tool-write to land, then **proceed with F3 mitigations** (§4.3). Never refused: a walled session's turn is failing against a rate-limited account anyway — deferring long has no upside. The grace only absorbs a mid-write tool call. |
| Model-swap (`ModelSwapService`) | refuses non-idle (retryable) — `src/core/ModelSwapService.ts:119-136` | unchanged refusal semantics, plus the subagent leg is added to its idle check (a session at an idle prompt CAN have live background subagents — today's pane-only check would swap under them; same footer blind spot F3 hit). Its existing retry surface is the deferral. |
| Agent/API session refresh (`POST /sessions/refresh`, MCP-lifecycle restarts, topic-profile respawns) | kills unconditionally | busy → structured refusal `session-busy` with the live work summary (turn? N subagents + ages), so the caller (agent or operator surface) decides: wait, or re-issue with `force: true`. An operator `force` proceeds with §4.3 mitigations. No silent queueing on this path — the caller is interactive and can carry its own retry. |
| Sentinel recovery respawns (ContextWedge, stuck-signature) | kill/respawn | exempt — by definition the session is wedged, its "work" is not progressing; gating recovery on a broken pane's indicators would deadlock recovery. Exemption is explicit in code (a `callerClass: 'recovery'`), not an accident of wiring. |

Deferral bookkeeping is in-memory per intent with the ledger row (§3.5) as the
durable trace; a server restart drops pending deferrals (safe: the intent
regenerates on the next monitor tick from live quota state — deferral state is
derived, never authoritative).

`deferralCeilingMs` default: **1 800 000 (30 min)** — long enough for a real
build/turn to land (p95 turn length on the autonomous runs is minutes, not
hours), short enough that a stuck-forever footer (the 90 min frozen-indicator
family `ActiveWorkSilenceSentinel` watches) cannot starve the swap intent
indefinitely. Starvation is structurally impossible in both directions: the
proactive intent dies at the ceiling (never blocks the wall), and the reactive
path never waits more than `reactiveGraceMs`.

### 4.3 The F3 mitigations (attached to every forced kill)

When a swap DOES proceed over in-flight work — reactive after grace, or
operator `force` — the respawn carries a mitigation payload. Both hooks
already exist; this wires them:

1. **Enumerate killed subagents.** Before the kill, snapshot
   `subagentTracker.getActiveSubagents(claudeSessionId)`
   (`src/monitoring/SubagentTracker.ts:151`) → `[{agentType, startedAt,
   ageMinutes}]`. The list goes (a) into the ledger row, and (b) into the
   respawned session's `followUpPrompt` — the parameter that already flows
   `SessionRefresh → respawner → respawnSessionForTopic`
   (`src/core/SessionRefresh.ts:428`, `src/commands/server.ts:15905-15919`) —
   as a plain-language block: *"This respawn interrupted N running subagents:
   [type, running for M min] … Their work may be partial; re-dispatch what's
   still needed."* The resumed conversation can act on it immediately instead
   of discovering half-finished worktrees by surprise.
2. **Re-inject the last unanswered inbound.** If the topic has an unanswered
   inbound at kill time — readable from the `currentInboundByTopic` map (set on
   inbound at `src/server/routes.ts:17199`, cleared on reply at
   `src/server/routes.ts:11346-11352`) with the message body resolved from the
   message ledger by dedupe key — append it to the `followUpPrompt`: *"Before
   the restart, this message arrived and was not yet answered: «…» — answer it
   first."* This is the F3 fix at the swap chokepoint: today the kill eats the
   turn that was answering the user, and the respawned session greets the void.
3. Payload hygiene: the followUpPrompt block is length-clamped and the inbound
   is quoted as data (same envelope discipline as replicated-store injections);
   subagent `lastMessage` bodies are NOT included (transcript paths land in the
   ledger row only).

Mitigations are additive to the respawn and never gate it — a failure to
enumerate or resolve the inbound logs and proceeds (the kill is already
justified when we reach here; the mitigation must not become a new wedge).

---

## 5. Invariants

- **I1 (checked = executed):** a proactive swap executes only onto the exact
  target that passed brakes (a)+(c); execute-time revalidation refuses, never
  re-selects. The two-threshold seam (§2.2) is structurally closed for
  proactive callers.
- **I2 (all-hot ⇒ zero proactive):** when no eligible target is under the
  target ceiling, zero proactive swaps execute; each candidate logs one
  `all-hot` refusal per tick (deduped in the attention surface, not in the
  ledger).
- **I3 (dwell):** a session account-swapped at T is not proactively swapped
  again before T+`dwellMs`, across server restarts (ledger-backed).
- **I4 (no proactive kill of live work):** a proactive swap, model-swap, or
  agent-initiated refresh never kills a session that the gate reports busy —
  it defers or refuses. Only reactive-after-grace and operator-`force` may,
  and then always with the §4.3 mitigation payload attached.
- **I5 (nothing silent):** every refused, deferred, dropped, suppressed, or
  proceeded-over-work decision writes one structured ledger row with its
  reason, and the counters are readable on the status route (§6).
- **I6 (the guarantee is untouched):** the reactive swap path never waits more
  than `reactiveGraceMs`, ignores dwell, reversal, the all-hot brake, and the
  thrash breaker, and with Piece 1+2 dark its behavior is byte-identical to
  today's.
- **I7 (uncertainty direction):** detector uncertainty resolves busy for
  proactive callers (protect work) and not-busy for reactive callers (protect
  continuity); indeterminate-detector deferrals are distinguishable in the
  ledger (`busy-indeterminate`).
- **I8 (breaker is bounded and loud):** the thrash breaker always half-opens
  after its backoff, and opening it raises exactly one deduped attention item
  per episode. No permanent silent suppression state exists.

## 6. Observability

- **Log lines (grep-stable):** `[ProactiveSwap] REFUSED session=… from=…
  reason=all-hot|dwell|no-material-target|reversal|thrash-breaker|
  target-revalidation-failed fromUtil=… bestAltUtil=…` · `[SwapWorkGate]
  DEFERRED session=… caller=proactive-swap reason=busy-turn|busy-subagents(N)|
  busy-indeterminate deferralAgeMs=…` · `[SwapWorkGate] PROCEEDED-WITH-
  MITIGATIONS session=… caller=reactive-swap killedSubagents=N
  reinjectedInbound=true|false`.
- **Durable ledger:** `state/swap-ledger.jsonl` (§3.5) — every decision, both
  pieces, one schema. Bounded by size-rotation (10 MB, keep 2), like the other
  state JSONLs.
- **Status surface:** `GET /subscription-pool/proactive-swap` (existing route
  for the monitor's `status()`) grows `brakes: {refusals: {byReason},
  thrash: {reversalsDetected, breakerState, breakerOpenedAt, episodes},
  deferrals: {active, byReason, dropped, proceededWithMitigations}}` — the
  **thrash-detected counter** the operator asks for lives here.
- **Guard posture:** both pieces register in the guard manifest
  (`src/monitoring/guardManifest.ts`) so `GET /guards` grades them
  (`on-dry-run` during soak, `dark-default` on the fleet) and a load-shed
  disable trips the posture tripwire like every other guard.
- **Attention items:** one per thrash episode (§3.5); one if the ledger is
  unwritable (observability loss is itself surfaced, not swallowed).

## 7. Config surface (all additive; shipped defaults shown)

```jsonc
{
  "subscriptionPool": {
    "proactiveSwap": {
      // existing: enabled, thresholdPct: 80, watchMarginPct: 15,
      //           maxSwapsPerCycle: 3, tickMs: 180000
      // cooldownMs (10m) is SUBSUMED by antiThrash.dwellMs — kept working
      // for back-compat when antiThrash is dark (§8).
      "antiThrash": {
        "enabled": true,          // sub-feature of an already-opt-in feature; see §9 ladder
        "dryRun": true,           // log would-refuse/would-defer, change nothing
        "targetHeadroomPct": 15,  // target ceiling = thresholdPct - this (→ 65)
        "minImprovementPct": 15,  // source - target must be ≥ this
        "dwellMs": 2700000,       // 45 min
        "reversalWindowMs": 1800000,
        "thrashBreakerThreshold": 2,
        "thrashBreakerBackoffMs": 3600000
      }
    },
    "swapContinuity": {           // Piece 2 (the work gate)
      "enabled": false,           // OMITTED in shipped config → dev-agent gate resolves it
      "dryRun": true,             // log would-defer/would-mitigate, change nothing
      "deferralCeilingMs": 1800000, // 30 min
      "reactiveGraceMs": 120000,    // 2 min
      "recheckMs": 10000            // busy re-check cadence inside a grace window
    }
  }
}
```

All numeric reads use nullish coalescing (`?? default`, never `||` — zero is a
legal disable for several of these). Both blocks are read live where feasible
(the monitor tick re-reads its config object per pass); the gate's wiring into
SessionRefresh requires a server restart, stated honestly in the migration
notes.

## 8. Migration & back-compat

- **Config:** `migrateConfig()` adds nothing (absence = defaults; both blocks
  are optional). No existing key changes meaning. `cooldownMs` keeps its exact
  current semantics whenever `antiThrash` is disabled/dry-run; when antiThrash
  is live, dwell (the stricter bound) governs and `cooldownMs` is ignored with
  one boot-log notice — never a startup error.
- **Behavioral back-compat:** antiThrash `dryRun:true` + swapContinuity dark ⇒
  every decision byte-identical to v1.3.722, plus ledger/log rows. The seam
  closure (§3.3) only activates for calls that pass an explicit target — the
  reactive path and any third-party `onQuotaPressure` caller are untouched by
  construction.
- **API:** `cfg.swap`/`onQuotaPressure` gain optional fields only; `status()`
  gains additive fields; the `/subscription-pool/proactive-swap` response stays
  a superset. No route is renamed; nothing 503s that didn't.
- **Ledger:** new file; absence = cold start (dwell begins un-primed — the one
  accepted gap: the first post-upgrade 45 min can proactively swap a session
  that was swapped pre-upgrade. One-time, bounded, logged).
- **Template awareness (Agent Awareness Standard):** the CLAUDE.md template's
  proactive-swap bullet gains the refusal semantics + "why didn't my session
  swap?" → read `GET /subscription-pool/proactive-swap` brakes/deferrals, and
  "why did my swap wait?" → the work gate. `PostUpdateMigrator` carries the
  section per Migration Parity.

## 9. Rollout ladder (graduated, per house convention)

1. **Dark (fleet):** both features ship in code, OFF. `proactiveSwap.enabled`
   is already fleet-dark; `antiThrash` nested under it inherits that darkness.
   `swapContinuity.enabled` omitted → dev-agent gate → dark on fleet.
2. **Dev-gate, dryRun (echo, immediately on merge):** antiThrash
   `enabled:true, dryRun:true` and swapContinuity live-on-dev `dryRun:true`.
   Soak target: one full all-hot afternoon. Success = the ledger shows
   would-refuse rows covering ≥90% of the swaps that a replay of §1 would have
   executed, and zero would-refuse rows against a genuine wall event.
   (Dark-but-load-bearing note: while in dryRun these guards are
   `loadBearingSoaking` on `/guards`, with the bounded soak window — they lapse
   loud if the flip stalls.)
3. **Live on dev:** flip both `dryRun:false` on echo. Run the §10 live proof.
4. **Fleet default:** antiThrash defaults `enabled:true, dryRun:false` for any
   install that opts into `proactiveSwap.enabled` (the brake becomes part of
   the feature's definition — a proactive swapper without anti-thrash is the
   bug, not a configuration); swapContinuity graduates to fleet default-on one
   release later (it touches every refresh path, wider blast radius, longer
   soak).

Rollback levers at every rung: `antiThrash.dryRun:true` restores v1.3.722
decision behavior without losing observability; `swapContinuity.enabled:false`
un-wires the gate entirely (SessionRefresh reverts to unconditional kill).

## 10. Live-proof clause (gate for "built", not for this draft)

Run on the dev agent, real pool, real sessions:

1. **All-hot afternoon replay:** with ≥3 accounts measured ≥80% (arrange by
   scheduling normal autonomous work; the state recurs most afternoons), over a
   ≥4 h window: **zero executed proactive swaps; zero ping-pong reversals;**
   ledger shows `all-hot`/`no-material-target` refusals; `GET
   /subscription-pool/proactive-swap` counters match the ledger.
2. **Genuine wall still swaps:** drive one account to an actual rate-limit
   escalation (or replay the sentinel event on a tagged test session): the
   reactive swap fires exactly once, within `reactiveGraceMs`+one tick, onto a
   least-bad target per today's semantics, breaker/dwell notwithstanding.
3. **Subagent survival:** in a session with 6 live Agent-tool subagents,
   trigger a proactive swap intent (lower the threshold on a test config):
   the intent defers (`busy-subagents(6)` rows), the subagents run to
   completion untouched, the swap executes after they land. **Zero subagent
   kills attributable to proactive swaps in the window** (cross-check
   SubagentTracker stop records vs swap-ledger timestamps).
4. **Forced-kill mitigations:** force a reactive swap over a busy session:
   the respawned session's first prompt contains the enumerated-subagent block
   and the re-injected unanswered inbound; the topic receives the honest
   respawn notice; ledger row carries `killedSubagents=N,
   reinjectedInbound=true`.
5. **Breaker proof:** with brakes (a)/(c) artificially disabled in a test
   config, manufacture one reversal: the breaker opens at the threshold,
   raises ONE attention item, suppresses proactive swaps for the backoff, and
   half-opens on schedule.

## 11. Failure modes

| Failure | Behavior |
|---|---|
| Pane capture fails / tmux busy (proactive check) | busy-indeterminate → defer (I7); persistent indeterminate rows in the ledger are the detector-broken signal |
| `claudeSessionId` missing on the state record | subagent leg silently unavailable → footer leg decides; ledger rows flag `subagentLeg:absent` so the blind spot is measurable |
| Swap ledger unwritable/corrupt | treated as empty (dwell un-primed, reversal detection cold), ONE attention item; decisions continue — observability loss never blocks the guarantee |
| Thrash breaker wedges open | impossible by construction (time-based half-open, no external latch); posture visible on `/guards` |
| Deferral records accumulate | per-session keyed map, entries die at execute/drop/ceiling; hard cap = live session count |
| QuotaPoller stale during grace window | execute-time revalidation (§3.3) uses the freshest snapshot and refuses on ceiling breach — stale data fails toward NOT swapping (proactive) |
| Server restart mid-deferral | pending deferrals dropped; intent regenerates from live quota state next tick (deferral state is derived) |
| Both detector legs broken for a genuinely idle session | proactive swaps defer until the 30 min ceiling then drop — cost is a missed optimization, never a stuck session; reactive unaffected |

## 12. Open questions for the convergence ceremony

1. **Dwell default (45 min) vs wave period:** the 2026-07-02 standing wave was
   ~2.5–3 h; is 45 min too permissive (allows one mid-wave re-swap) or should
   dwell scale from the observed poll interval instead of a constant?
2. **Should brake (c)'s relative-improvement bound also apply to REACTIVE
   target selection?** This draft says no (a walled session takes any port in
   the storm, drain-first scoring is correct there) — but a reactive swap onto
   an 89% target will likely wall again within minutes. Is one more hop
   acceptable, or should reactive prefer the coolest target when one exists
   under the ceiling? (Changes the guarantee's target choice, not its
   existence — flagged because I6 currently promises byte-identical reactive
   behavior.)
3. **Untagged-session default-account swaps:** a proactive swap of an UNTAGGED
   session changes which account the DEFAULT config serves for every future
   untagged spawn, not just the moved session (`resolveDefaultAccountId`
   coupling). Does the dwell key belong on the session, the account-pair, or
   both? Draft says session-keyed with the reversal detector as the pair-level
   backstop; a pair-keyed dwell is stricter and simpler to reason about but
   would have blocked the legitimate 08:19 wave (different sessions, same
   pair).
4. **`currentInboundByTopic` lifetime:** the map is in-memory and cleared on
   reply; across a server restart the "last unanswered inbound" is lost and
   mitigation (2) silently degrades to absent. Is the durable inbound queue
   (CMT-1118 family) the right future source, and should the ledger row
   distinguish `inbound:none` from `inbound:unknown`?
5. **Model-swap subagent leg (§4.2 row 3):** adding the subagent check to
   `ModelSwapService`'s idle gate changes an existing live-on-dev feature's
   refusal surface (more refusals). Ship it inside Piece 2's flag, or as its
   own micro-flag on the model-swap config?
6. **Does the deferral ceiling need a per-caller override for autonomous
   runs?** A 12 h autonomous run with rolling subagents could see every
   proactive intent die at the 30 min ceiling (acceptable per §4.2 — the wall
   wins by design), but if operators find reactive swaps too disruptive
   mid-run, a "swap at the next turn boundary" hook (the same boundary the
   pool-transfer consent gate uses) is the finer instrument. Deferred here as
   scope discipline; name it so it isn't silently dropped (Close the Loop).

---

*Draft authored 2026-07-02 (Session A, roadmap 4.4 + operator-priority thrash
brake). Evidence: `logs/server.log` (echo, v1.3.722). No convergence ceremony
has run; nothing here is approved for build.*
