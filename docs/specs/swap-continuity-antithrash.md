---
slug: swap-continuity-antithrash
title: Swap Continuity Under Pressure — Anti-Thrash Brakes + In-Flight Work Deferral (Roadmap 4.4, F3/P1-A6)
status: draft (round-3 revision — all round-1 + round-2 findings folded; see §15/§16 dispositions)
author: echo
eli16-overview: swap-continuity-antithrash.eli16.md
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
constitution: Bounded Blast Radius (a quota optimization must not silently expand into "all my subagents were killed"); Structure beats Willpower (the anti-thrash rule lives at the swap chokepoint, not in prose); The User Experience Is the Product (F-series umbrella — the safety/continuity mechanism must not BE the disruption)
lessons-engaged: "P19 (three brakes + a bounded, loud breaker on a repeating loop — §3, §3.5; the monitor's pre-existing silent-retry gap is ALSO fixed, §3.6); P17 (ONE deduped attention item per thrash episode / per failure streak / per ledger loss — §3.5, §3.6, §6.4); P18 (every refusal, deferral, drop, and failure is a counter + a ledger row; dry-run counters soak before authority — §6, §10); P14-family flap accounting (dwell + reversal state persisted, restart-safe — §3.2, §3.5); F3 finding family (killed-subagent enumeration + unanswered-inbound re-injection at the swap chokepoint — §4.3); Bounded-Notification-Surface lesson shape (bind the PRIMITIVE with a default class, never a per-caller table — §4.2); #1001 anti-mechanism (dev-gated key OMITTED from shipped config, never an explicit false — §7, §10); dynamic-MCP half-enable precedent (per-key config-liveness table — §7.1); CMT-1118 durable inbound queue named as the future inbound-mitigation source (§4.3); Signal vs. Authority (the gate's blocking authority argued, bounded, and classed — §4.4); P20 Verify the State, Not Its Symbol (the work gate verifies live pane/process/subagent STATE before any kill and treats an unreadable symbol as indeterminate, never as idle — §4.1, I7); P7 supervision: Tier 0, declared (§4.4 — deterministic quota/state math at every decision point, no LLM policy judgment anywhere in either piece)."
earned-from: 2026-07-02 proactive-swap thrash day (echo dev agent, v1.3.722 — 36 executed proactive swaps / 72 [SessionRefresh] account-swap log lines across 8 waves; repeated kills of six parallel build subagents during the U4 and Session-A autonomous runs); F3 finding family (inbound eaten by respawn) and P1-A6
roadmap: Session A item 4.4 — "Continuity under pressure: proactive/reactive swap + model-swap + refresh defer while a turn or live subagents are in flight, or re-inject the last unanswered inbound + enumerate killed subagents"
review-convergence: null   # round 3 in flight — has not converged
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

(Readers who want the plain-English version first: the eli16 companion,
`swap-continuity-antithrash.eli16.md`, carries the whole design without the
internal idiom — wall, dark, dev-gate, F3, P19 — used below.)

## 0. The four operator-demanded properties (the non-negotiable core)

These four properties are the operator's direct demand after the 2026-07-02
thrash day. Every design decision below serves them; every round-1 finding was
resolved WITHOUT weakening any of them:

- **(a) The all-hot brake** — when every account is near quota, STAY PUT. A move
  between two hot accounts buys nothing and costs a kill. (§3.1)
- **(b) A per-session swap cooldown** — a session that was just moved is not
  moved again for a dwell window, restart-safe. (§3.2)
- **(c) Destination must be meaningfully better** — no swap onto a target that
  is itself hot, or only trivially cooler than the source. (§3.3)
- **(d) Never swap while work is in flight** — a session mid-turn or carrying
  live subagents is never killed by an optimization. The swap defers until the
  work lands, and if the wait runs out the swap is DROPPED, not forced. (§4)

**The one deliberate boundary on (d), stated up front (resolves the B10/S2
tension explicitly):** property (d) is ABSOLUTE for every optimization-class
caller — a proactive swap, a model-swap, an agent-initiated refresh can never
kill in-flight work; they defer or refuse, and the ceiling path DROPS the
intent rather than forcing it. The single, named exception is the REACTIVE
continuity guarantee: when an account genuinely walls, the session's work is
already failing against a rate-limited account, so after a short bounded grace
(§4.2) the swap proceeds — always carrying the §4.3 mitigations. "Never swap
while work is in flight" therefore means precisely: *no optimization ever
outranks live work; only a wall does, and even the wall waits briefly and then
pays the F3 mitigation toll.* This is not a softening of (d); it is (d) plus
the continuity guarantee the operator already relies on, with the priority
order stated instead of implied.

**One delivery-honesty note on (d) and model-swap (R2-M4):** the account-swap,
interactive-refresh, and unlisted-caller arms of (d) are delivered by the gate
at the chokepoint from Piece 2's first rung. The MODEL-swap arm has two legs:
its existing pane-idle refusal (live today) and the new SUBAGENT leg, which
ships **dark** behind its own micro-flag (`subagentIdleLeg: false`, §4.2/§14-Q5)
and graduates on its own rung (§10). Until that flip, a model-swap of a
pane-idle session carrying live background subagents remains today's behavior.
(d) is the design commitment this spec delivers; the model-swap subagent leg
is the one arm whose delivery is explicitly staged — stated here so §0 never
claims more than a given rung has actually shipped.

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
`QuotaAwareScheduler.onQuotaPressure` (`src/commands/server.ts:16022-16025`).
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

Meanwhile the codebase already HAS the underlying detection signals, used
elsewhere (though not in the shape this spec needs — see §4.1's honest note on
the new tri-state probe):

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
family) every cooldown resets to zero. (Also a pre-existing unbounded-growth
gap: `lastSwapAt` entries are never evicted — fixed alongside, §3.5.)

---

## 3. Piece 1 — Anti-thrash brakes on the proactive swap

All brakes live at the proactive DECISION chokepoint
(`ProactiveSwapMonitor.evaluate`). The reactive path is untouched (§3.4).

**Candidate-set rule (frontloaded decision Q3, §14):** UNTAGGED sessions —
sessions whose account resolves through the DEFAULT config slot rather than an
explicit account tag — are **excluded from the proactive candidate set
entirely**. Proactively swapping an untagged session mutates
`resolveDefaultAccountId`, i.e. changes which account EVERY future untagged
spawn lands on — a background optimizer must never mutate the default-slot
binding as a side effect (default-slot optimization is `POST
/credentials/set-default`'s job, an explicit operator-visible lever). Reactive
rescue of untagged sessions is unchanged (a walled untagged session still
swaps, forced); its ledger row carries `defaultAccountChanged: true` so the
side effect is visible, never silent.

### 3.1 Brake (a) — the all-hot brake

**Rule:** a proactive swap is REFUSED unless at least one eligible target
measures below the **target ceiling** (§3.3). When every alternate is at/above
the ceiling, the pool is "all hot": staying on the least-used account is as
good as moving — the move buys no material margin and costs a kill+respawn.
Only a hard rate-limit wall justifies a move then, and that is the reactive
path's job.

Refusal is per-candidate-session and logged with reason `all-hot` (§6). To
keep the ledger write rate sane during a sustained all-hot afternoon, all-hot
refusals are recorded as **state-transition rows**, not per-tick rows: one row
when a candidate ENTERS all-hot refusal, one when it LEAVES, plus a low-rate
heartbeat row (one per candidate per `allHotHeartbeatMs`, default 30 min,
while the state persists) so a long episode stays externally provable (the I2
proof is preserved at ~2% of the naive write volume). The same
enter/leave/heartbeat treatment applies to `thrash-breaker` suppression rows,
keyed on the episode's `episodeId` — the breaker evaluates before all-hot in
the pipeline, so without this it would relocate the exact per-tick write
pattern the state-transition scheme eliminates into every breaker-open hour.
The monitor keeps ticking; the moment a window resets and a genuinely-cool
target appears, proactive swapping resumes on its own.

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

**All-hot reactive cascade, accepted explicitly (frontloaded decision Q2,
§14):** in an all-hot pool a walled session's reactive swap lands on a hot
target and may wall again within minutes — a hop chain. This is accepted for
v1: each hop is a genuinely-forced move (the alternative is a dead session),
the chain is bounded by the pre-existing per-session refresh rate counter
(5 per 10 min, `src/core/SessionRefresh.ts:204-205`) which caps hops
mechanically, and every hop is a `reactive` ledger row so a chain is visible.
"Reactive prefers the coolest under-ceiling target when one exists" is a NAMED
follow-up (`reactive-coolest-target`), deliberately NOT in this spec: it
changes the reactive path's target choice, and I6 promises byte-identical
reactive behavior.

**The cascade carries its own P19 escalation (detection-only — I6-safe; closes
the round-2 Standards-Conformance flag):** accepting the cascade with only a
cap and passive ledger rows left "No Unbounded Loops" half-satisfied — the
principle demands that sustained degradation SURFACE once, not merely be
readable. Two detection-only triggers each raise ONE `episodeId`-deduped
attention item ("session X has emergency-hopped accounts N times in the last
30 min — the pool is genuinely saturated" / "session X is rate-capped on a
walled account and cannot swap again this window"): (1) the same session's
reactive hops reach `reactiveHopAlertThreshold` (default **2**) within
`reversalWindowMs`; (2) the pre-existing refresh rate cap refuses a REACTIVE
swap — the one state where a session is stranded on a walled account with no
further mechanical rescue, which today is fully silent. Neither trigger
refuses, delays, or re-targets anything (I6: reactive decision behavior stays
byte-identical); this is the escalate-once arm, and the reactive continuity
loop is hereby DECLARED the sanctioned Eternal-Sentinel exemption under P19
(it never gives up; it now also never degrades silently). Fix-alongside, one
layer below (the foundation gap the round-2 lessons audit surfaced): the
reactive path's failure today is silent — `refreshFn`'s `false` return is
discarded (`void`, `src/commands/server.ts:15974`) and a respawner throw is an
unhandled rejection — so reactive execution failures now also write `failed`
ledger rows through the §3.5 chokepoint and feed trigger (2)'s escalation.

### 3.2 Brake (b) — per-session dwell

**Rule:** a session that was account-swapped (proactively OR reactively) within
the last `dwellMs` is not proactively swapped again. Refusal reason: `dwell`.

- Default `dwellMs`: **2 700 000 (45 min)** — chosen against the evidence: the
  16:34→16:46→16:58 reversals were 12 min apart; the standing wave period
  across the day was ~2.5–3 h. 45 min kills intra-wave ping-pong while still
  allowing one proactive rescue per standing wave. Frontloaded decision (Q1,
  §14): a CONSTANT, not adaptive scaling, in v1 — the structural decision
  (constant vs derived) is frontloaded; the numeric default carries a justified
  cheap-to-change-after tag (a config constant behind a dry-run soak that
  measures exactly this number's effect, §10 rung 2).
- Dwell also counts REACTIVE swaps as its clock-start (a just-rescued session
  is not immediately re-optimized), but dwell never BLOCKS a reactive swap
  (I6).
- Dwell state is persisted in the swap ledger (§3.5) so a server restart does
  not reset it (fixes §2.4).
- The old `cooldownMs` (10 min) demonstrably braked nothing; it is subsumed —
  see §9 migration.
- **Index hygiene:** the in-memory dwell/reversal index prunes entries older
  than `max(dwellMs, reversalWindowMs)` on each tick; the pre-existing
  `lastSwapAt` never-evicted leak is fixed by the same sweep. Hard bound: the
  index never exceeds (live sessions + entries younger than the window).

### 3.3 Brake (c) — target-materially-better

**Rule:** the executed target must satisfy BOTH bounds, evaluated on the same
snapshot that the decision logs (§6):

1. **Absolute ceiling:** `bindingUtilization(target) < thresholdPct −
   targetHeadroomPct` — default ceiling **80 − 15 = 65%**. A target in the
   79%-band is never "better" in any way that survives the landed sessions'
   own burn plus poll lag. Stated explicitly: the 15-point headroom IS the
   proxy for projected post-swap utilization — it is the margin budgeted for
   the landed session's own burn plus one poll interval of reading lag, and
   the per-target-per-tick cap (below) bounds the immediate pile-on. A
   per-session burn-rate ESTIMATE feeding the filter is a named possible
   refinement (`burn-aware-targeting`), not v1 — the fixed margin plus the cap
   already bound the failure the estimate would predict.
2. **Relative improvement:** `bindingUtilization(source) −
   bindingUtilization(target) ≥ minImprovementPct` — default **15 points**.
   Guards the case where the source reading is barely over threshold (80–81%)
   and jitter alone created the "pressure".

**Note on shipped defaults (stated so retuning is safe):** at the shipped
numbers, bound 2 is mathematically implied by bound 1 (source ≥ 80 ∧ target
< 65 ⇒ improvement > 15) — `minImprovementPct` is inert until an operator
RAISES `targetHeadroomPct`'s ceiling (lowers the headroom). It exists so that
loosening one knob never silently removes the materially-better property; an
operator who sets `targetHeadroomPct: 5` still gets the 15-point improvement
floor.

**Normative selection order (order of operations is load-bearing):**

1. **FILTER** the alternate set to accounts whose `bindingUtilization` is
   under the absolute ceiling (bound 1). If the filtered set is empty → the
   all-hot brake refuses (§3.1).
2. **SCORE** with `selectAccount`'s existing use-before-reset scoring — over
   the FILTERED cool set ONLY (drain the soonest-resetting COOL account
   first). The scoring was never the bug; applying it over the hot band was.
3. **VERIFY** the survivor against bound 2 (relative improvement vs the
   source). Fail → refusal `no-material-target`.

A builder must NOT score the full alternate set and rely on execute-time
revalidation to catch a hot pick — the filter comes first, structurally. The
executed target is the survivor of filter→score→verify.

**Intra-tick pile-on cap:** at most **1 executed swap per target account per
monitor tick**. All `maxSwapsPerCycle` candidates evaluating against the same
stale snapshot could otherwise pass bounds against the SAME cool target and
pile onto it inside one tick — §2.2's poll-lag mechanism at intra-tick scale.
After a swap executes onto target T in a tick, T leaves the candidate target
set for the remainder of that tick (refusal reason `no-material-target` if no
other target survives).

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

**The funnel contract, stated (accepted-risk shape):** `onQuotaPressure` is a
public seam; the contract is — an explicit `targetAccountId` means "the caller
already ran the brake pipeline; revalidate, never re-select"; NO
`targetAccountId` means "reactive semantics: today's 90-threshold re-selection,
drain-first scoring". A future proactive-class caller that skips the brakes by
omitting the target gets reactive semantics, not silent brake bypass — the
worst-case failure of the contract is today's exact behavior, never something
new. This is the accepted funnel boundary, and the wiring test (§12) pins it.

### 3.4 The reactive path is untouched

`autoSwapOnRateLimit` → `rate-limit:escalated` → `onQuotaPressure` with no
explicit target (`src/commands/server.ts:15965-15981`) keeps its exact
semantics: 90-threshold eligibility, drain-first scoring, `onNoAlternate`
attention item. A genuinely walled account still swaps — within
`reactiveGraceMs` + one tick (§4.2), not "immediately"; the grace is Piece 2's
only touch on this path — even in an all-hot pool, even inside another
session's dwell window. The brakes bind the OPTIMIZATION, never the GUARANTEE.
(Piece 2 adds only the short mitigation grace + F3 payload to the reactive
respawn — §4.3 — never a refusal.)

### 3.5 Thrash detection + the swap ledger

Every proactive decision — executed, refused, deferred, dropped, invalidated,
failed — and every reactive swap is appended to a durable JSONL ledger:
`state/swap-ledger.jsonl`. The authoritative row schema is §6.1 (single
source; the sketch that used to live here was incomplete). The ledger is the
restart-safe source for dwell (§3.2), reversal detection, AND breaker state:

- **Write path (single chokepoint):** one `SwapLedger` module owns the file —
  the ONLY append site. Monitor, scheduler, and SessionRefresh all call it;
  none writes the file directly. Rotation uses the O(1) segment helper
  (`maybeRotateJsonlSegment` + a cached byte counter — NOT the legacy
  whole-file `maybeRotateJsonl` rewrite, which is marked non-conformant),
  size-rotated at 10 MB, keep 2 segments. **Durability rules for
  state-source duty (the ledger is both audit log AND restart-state
  source):** every append is a single atomic line write; on hydration a
  corrupt/partial trailing line is tolerated — treated as absent and counted
  (`corruptLinesSkipped` on the status route), never allowed to poison the
  derivation or abort the boot.
- **Read path (never a per-decision scan):** hydrate ONCE at boot. The
  hydration window is `hydrationWindowMs = max(dwellMs, reversalWindowMs,
  thrashBreakerBackoffMs)` — the breaker backoff (60 min) is deliberately
  inside the bound; a window that stopped at dwell (45 min) would silently
  lose a live breaker episode in the second half of its backoff, the exact
  §2.4 restart class this ledger exists to close. The read walks retained
  segments NEWEST-FIRST (active file, then rotated segments) until the oldest
  row read is older than the window — bounded by `keepSegments` = 2, so at
  most active + 2 segments (~30 MB) at boot, one-time, off the hot path. If
  retention cannot cover the window (all retained rows are younger than the
  bound and a segment was evidently lost to rotation), the boot flags itself
  UNDER-PRIMED honestly: one log line + a `hydration: 'under-primed'` status
  field — never a silent cold index masquerading as a complete one. After
  boot: an in-memory per-session index, write-through on append. No decision
  ever re-reads the file.
- **Reversal (refusal — same-session keyed):** a proactive swap intent whose
  `(from,to)` is the inverse of the same session's most recent executed swap
  within `reversalWindowMs` (default **1 800 000, 30 min**) is refused outright
  (reason `reversal`) and increments the thrash counter.
- **Reversal (detection — pair-level, any session):** a proactive EXECUTION
  whose `(from,to)` inverts ANY executed swap on the same account pair within
  `reversalWindowMs` — regardless of session — ALSO increments the thrash
  counter (detection-only; it never refuses). Same-session keying alone is
  blind to the multi-session ping-pong shape a brake-(c) regression would
  actually take (session A goes X→Y while session B goes Y→X); the pair-level
  detector sees it. Refusal stays same-session-keyed on purpose — the
  legitimate 08:19 wave (different sessions, same pair, same direction under
  real pressure) must not be refused by a pair-level rule.
- **Rotation (detection — direction-agnostic frequency, closes the N≥3
  blind spot):** both reversal detectors key on pair INVERSION, so a
  consistent-direction rotation (A→B→C→A) never trips them — it produces no
  reverse edge while dwell merely PACES it (~one hop per session per 45 min:
  incident-scale churn with every pair detector green). The third detector is
  frequency, not direction: a session whose PROACTIVE executions reach
  `swapFrequencyThreshold` (default **3**) within `swapFrequencyWindowMs`
  (default **10 800 000, 3 h** — three hops in three hours means the session
  is being moved at nearly the dwell floor, the rotation signature; a
  legitimately-optimized session is moved once per standing wave, ~2.5–3 h)
  ALSO increments the thrash counter (detection-only — refusal semantics
  unchanged; dwell already paces the session, the breaker is what stops a
  systemic rotation).
- **Thrash episode / breaker:** ≥ `thrashBreakerThreshold` (default **2**)
  thrash-counter increments pool-wide within `reversalWindowMs` opens a breaker
  that suppresses ALL proactive swaps for `thrashBreakerBackoffMs` (default
  **3 600 000, 1 h**), raises ONE deduped attention item ("proactive
  account-swap is thrashing — suppressed for 1h; accounts A/B/C all ≥80%"), and
  logs every suppressed intent with reason `thrash-breaker`. The breaker
  auto-half-opens after the backoff (P19 family: a guard's own failure mode
  must be bounded and loud, never a silent permanent off). Reactive swaps
  ignore the breaker (I6).
- **Breaker state survives restart (this spec must not re-create §2.4):**
  breaker state is DERIVED, not stored as separate authority — and the
  derivation is anchored on the EPISODE, not on the reversal rows that opened
  it (which age out of any window while the episode is still live). Every
  episodeId-stamped row — the open-marker row written at episode open, every
  suppressed/enter/leave/heartbeat row — carries `breakerOpenedAt` and
  `breakerDeadline` (§6.1), so the deadline is IN the schema. At boot, the
  hydration (whose window includes the full backoff — see the read path above)
  re-derives from the MOST-RECENT episodeId-stamped row of ANY decision kind:
  if its `breakerDeadline` has not elapsed, the breaker boots OPEN with the
  ORIGINAL deadline. This works precisely when suppressed rows vastly
  outnumber reversal rows (the normal shape of an open episode). The episode
  attention item is deduped on the ledger-persisted `episodeId`, so a
  reconstructed episode does NOT re-alert — the restart-heavy day that
  motivated §2.4 gets a breaker that holds, silently, exactly as if the
  process had lived.

With brakes (a)+(c) working, PAIR reversals (2-cycles) should be structurally
impossible — the breaker is the belt-and-suspenders detector that proves that
claim for 2-cycles and alarms if a future change reopens the hole (the same
role the guard-posture tripwire plays for config flips). The claim is
deliberately scoped: N≥3 rotations are NOT structurally impossible under
(a)+(c) — they are individually-justified hops — which is exactly why the
frequency detector above exists. The breaker's coverage is the union of the
three detectors (same-session inversion, pair-level inversion, per-session
frequency), not the first alone.

### 3.6 Execution-failure accounting (closes a pre-existing P19 gap)

The monitor's current behavior when the executed swap call THROWS is a silent
retry next tick — no record, no backoff, no escalation. The draft's decision
enum reproduced that hole; it is now closed:

- A swap execution that fails writes a `decision: 'failed'` ledger row
  (reason `swap-exec-failed`). `errorClass` is pinned normatively: the
  error's CONSTRUCTOR NAME or a fixed enum mapping ONLY — never `.message`,
  never `.stack`, never a truncated message (those can carry paths/tokens;
  the anti-leak rule must be enforceable in review, not aspirational).
- Each consecutive failure puts the SESSION into execution-failure backoff:
  skip it for `tickMs × 2^n` (n = consecutive failures, capped at `dwellMs`).
  A success resets the counter.
- After **3** consecutive failures on one session: ONE deduped attention item
  (per session per episode) — "proactive swap for session X is failing
  repeatedly (reason class)". Counters on the status route (§6.3).
- **Restart-proof like the breaker:** the failure-streak counter, its backoff,
  and its episode dedupe key are re-derived at boot from `failed` rows inside
  the same hydration window (§3.5) — a crash-loop day must not reset the
  backoff each boot and re-alert once per restart, which would break
  one-item-per-streak exactly when it matters.

---

## 4. Piece 2 — In-flight work deferral (the 4.4 core, F3/P1-A6)

### 4.1 The gate

A new small module — `SwapWorkGate` (`src/core/SwapWorkGate.ts`) — answers one
question at every session-killing mutation chokepoint: **does this session have
in-flight work right now?**

**The probe is a NEW tri-state surface (honest accounting — the draft
overclaimed "invents no new detection"):** the underlying SIGNALS exist today
(§2.3), but not in the shape this gate needs. `isSessionActivelyWorking`
swallows its own failures (`catch → false`) — which is the OPPOSITE resolution
I7 requires for proactive callers — and it is built on synchronous
`execFileSync` forks. The gate therefore introduces:

```
checkSessionWorkState(session) → 'working' | 'idle' | 'indeterminate'
```

This is a new PUBLIC async method on `SessionManager` (the owner of the
private primitives it composes — `SwapWorkGate`, a separate module, cannot
reach them otherwise): the coalesced tmux pane capture (`tmuxExecCoalesced`)
for the footer leg, and for the child-process leg a NEW batched path around
the pure `computeHasActiveProcesses(panePid, psOutput)` — deliberately NOT
`hasActiveProcessesAsync`, which both forks its own full `ps -eo` per call and
folds its failure to `true`, the wrong shape twice over. Each leg that cannot
be read reports its OWN `indeterminate` instead of a silent boolean — a
genuinely-unprobeable process tree must surface as `busy-indeterminate` in the
ledger, never masquerade as `busy-turn`. `SubagentTracker.hasActiveSubagents`
(O(1), in-memory, cannot block) supplies the subagent leg. "Non-baseline child
process" means the canonical baseline filter in
`SessionManager.hasActiveProcesses` (the shell/tmux-infrastructure exclusion
list) — defined by reference so the term is not free-floating.

**Event-loop safety (mandatory, not advisory):** the gate NEVER calls the
synchronous probe path. At spec'd frequency (deferred intents re-checked per
tick + per-10 s grace re-checks across a reactive wave), the sync path's 2–4
blocking `execFileSync` forks (including a full `ps -eo` scan) would stall the
server event loop for seconds at exactly the hot moment — the mesh lease tick
(~5 s) and Telegram ingress share that loop. The `ps` snapshot is shared
through a short-TTL (~2 s) cache at the `SessionManager` level — NOT merely
"once per monitor sweep": the sweep AND every concurrently-running reactive
grace loop (K sessions walling near-simultaneously in an all-hot cascade, each
re-checking every 10 s) reuse one process-table read within the TTL. One `ps`
fork per ~2 s host-wide is the ceiling regardless of how many probes run; the
wiring test pins it (§12).

```
busy(session) :=
     turnLeg     = checkSessionWorkState(session)             // 'working'|'idle'|'indeterminate'
  || subagentLeg = session.claudeSessionId != null
        ? subagentTracker.hasActiveSubagents(session.claudeSessionId)
        : 'indeterminate'                                     // leg unavailable, flagged
```

**Uncertainty direction (I7, restated with the reactive-arm fix):**

- **Proactive/optimization callers:** any `indeterminate` on BOTH legs →
  resolve **busy** (fail toward not killing work). If only the subagent leg is
  unavailable (`claudeSessionId` missing), the footer leg still decides; the
  ledger row flags `subagentLeg: 'absent'` so the blind spot is measurable.
  Deferrals caused purely by indeterminacy carry reason `busy-indeterminate` —
  a broken detector is visible in the ledger rather than masquerading as real
  work.
- **Reactive callers:** `indeterminate` resolves **busy-for-grace** — the
  session is treated as busy WITHIN the grace window (worst case: the swap
  waits the full `reactiveGraceMs`, 120 s). It does NOT resolve to not-busy:
  the reactive arm's wait is hard-bounded, so stranding is impossible by
  construction, and resolving indeterminate to not-busy would forfeit the
  grace on flaky tmux exactly under load — when tmux is most likely to be
  flaky. The guarantee is unharmed (the swap always proceeds at deadline);
  only the mid-write protection is preserved.

### 4.2 The chokepoint, caller classes, and what "defer" means per class

**The gate binds the PRIMITIVE, not a caller list (Bounded-Notification-Surface
lesson shape):** `SwapWorkGate` is consulted INSIDE
`SessionRefresh.refreshSession` — the one funnel every session-killing
account/model/refresh mutation already flows through. Callers pass a
`callerClass`; an UNLISTED or absent caller class defaults to
`'interactive-refresh'` (refusal semantics — the safest default: nothing is
killed, the caller is told why). This is how today's unlisted killing callers
(`POST /sessions/restart-all`, manual `POST /subscription-pool/swap`,
credential-repointing respawns, tier-escalation respawns) are bound without
being enumerated — a table of callers can never bind the caller added next
month; the chokepoint with a default class binds everything by construction.

```
type SwapWorkGateCallerClass =
  | 'proactive-swap'       // optimization — defer, ceiling-drop
  | 'reactive-swap'        // continuity guarantee — grace, then proceed + mitigations
  | 'interactive-refresh'  // agent/API/operator refresh — refuse with work summary (DEFAULT)
  | 'recovery'             // sentinel recovery respawn — exempt
```

**Provenance invariant (I11): `callerClass` is set ONLY by server-internal
call sites — never populated from request input.** The class is the sole
authority deciding whether in-flight work is protected (`recovery` exempts the
gate AND skips mitigations), so a wire-derived class would be a gate bypass by
construction. `/sessions/refresh` pins `interactive-refresh` server-side; no
route accepts a `callerClass` field, and the wiring test asserts none ever
does (§12).

**Recovery-class enumeration (the safe default's one blind spot, closed):**
the `interactive-refresh` default is safe for every caller EXCEPT a recovery
respawn — refusing a recovery because a wedged pane still SHOWS "working" is
the deadlock §4.4 forbids. The known recovery call sites are therefore
enumerated and tagged `recovery` at build time: the ContextWedgeSentinel fresh
respawn, the stuck-signature (AUP/context-wall) recovery respawn, and the
SessionWatchdog escalating-kill respawn. The §12 caller audit verifies the
tag on each; any recovery-class caller added later that forgets the tag fails
SAFE into refusal (nothing is killed) and surfaces immediately as a refused
recovery in the reap-log — loud, not silent.

**Gate-before-rate-guard (order is load-bearing):** the busy check runs BEFORE
`refreshSession`'s rate-guard records the attempt. A deferred or refused
attempt consumes ZERO of the 5-per-10-min rate budget — otherwise a busy
session's own deferrals would exhaust the budget and starve the eventual
legitimate swap.

| Caller class | Today | With the gate |
|---|---|---|
| `proactive-swap` | kills unconditionally via refresh | busy → **defer**: keep the intent, retry each tick; the swap runs when the work lands. Bounded by `deferralCeilingMs`. At ceiling: **the wall wins** — the intent is DROPPED (reason `deferral-ceiling-dropped`), the session keeps working, and if the account genuinely walls the reactive path fires with §4.3 mitigations. Rationale: a proactive swap is an optimization; killing six subagents to pre-empt a wall that may never arrive inverts the priority order. Dropping is safe precisely because the reactive floor exists. |
| `reactive-swap` | kills unconditionally | busy → wait at most `reactiveGraceMs` (default **120 s**, re-check cadence 10 s) — and execute the swap at the FIRST not-busy observation, never sitting out the full grace. If NEW work starts inside the grace, it is killed at the deadline WITH mitigations — acceptable and stated: any new turn on a walled account is failing anyway. Never refused: deferring long has no upside; the grace only absorbs a mid-write tool call. |
| `interactive-refresh` (default) | kills unconditionally | busy → structured refusal `session-busy` with the live work summary (turn? N subagents + ages), so the caller decides: wait, or re-issue with `force: true`. A `force` proceeds with §4.3 mitigations. No silent queueing — the caller is interactive and carries its own retry. Route shape: §4.5. |
| `recovery` | kill/respawn | exempt — by definition the session is wedged, its "work" is not progressing; gating recovery on a broken pane's indicators would deadlock recovery. Exemption is explicit in code (the caller class), not an accident of wiring. |

Model-swap (`ModelSwapService`) keeps its own refusal surface (it refuses
non-idle already, retryable — its existing retry surface IS its deferral). The
change: its idle check gains the SUBAGENT leg — a session at an idle prompt
CAN have live background subagents; today's pane-only check would swap under
them (the same footer blind spot F3 hit). Frontloaded decision (Q5, §14): the
subagent leg ships behind its **own micro-flag on the model-swap config block**
— `subagentIdleLeg`, **concrete default `false` (dark) everywhere**, graduating
on its OWN explicit rollout rung (§10 rung 3a) — NOT inside `swapContinuity`
and NOT "following the model-swap feature's stage" (model-swap is already
live, so stage-following would resolve to ON and silently change a live
refusal surface on deploy — the exact outcome this paragraph forbids). The
pieces stay independently shippable; shipping this spec changes a live
model-swap's refusal surface only at the deliberate flag flip, never on
deploy. §0 carries the matching delivery-honesty note.

**Deferral ownership (who holds what state):** `SwapWorkGate` is a STATELESS
predicate — `busy()` and nothing else. `ProactiveSwapMonitor` owns the deferral
map, `deferralAgeMs` accounting, ceiling enforcement, and drop-at-ceiling — it
owns the tick and the intent lifecycle, so the deferral lifecycle lives with
it. The reactive grace loop runs as a bounded ASYNC wait inside the
account-swap branch of `SessionRefresh` (never a blocking wait inside a
scheduler callback). Deferral bookkeeping is in-memory per intent with the
ledger row as the durable trace; a server restart drops pending deferrals
(safe: the intent regenerates on the next monitor tick from live quota state —
deferral state is derived, never authoritative).

**A deferred intent re-runs the FULL brake pipeline at fire time (not just
target revalidation):** each deferral retry tick re-evaluates, in order:
source-pressure ≥ threshold (the wave may have subsided — all 8 observed waves
subsided wall-free; executing a stale intent would be a pointless kill), the
breaker (an episode that opened mid-wait suppresses the pending intent — it is
NOT exempt), dwell, reversal, all-hot, and both target bounds + fresh target
selection. An intent whose session's ACCOUNT changed underneath it (a reactive
swap already moved it) is INVALIDATED (`decision: 'invalidated'`, reason
`intent-stale`) — never executed as a second kill inside the dwell window that
dwell exists to prevent. The intent that finally fires is one that would have
been approved fresh at that moment; deferral never launders a stale decision.

**Defer→drop→regenerate churn brake (keyed on the SESSION — the key is
load-bearing):** after a `deferral-ceiling-dropped`, the SESSION enters
re-intent backoff for `dwellMs` (default) — keyed on `(session)`, NOT on the
(session, target-pair): a pair key is evaded by target rotation (drop on A→B,
next tick selects A→C — not backed off — defer 30 min, drop, rotate back; the
"must not cycle forever" promise dies whenever ≥2 cool targets exist). One
session = one intent episode: the `deferralAgeMs` ceiling clock ALSO carries
across target re-selection within the episode (a best-target change never
resets the 30-min ceiling — the clock measures how long the SESSION's swap
intent has been deferred, not how long the current target has been chosen).
Repeated defer observations within one intent episode are deduped in the
ledger to first + final + `deferCount` (never one row per re-check). The
backoff is best-effort across restarts by DERIVATION, like everything else:
`dropped` rows are in the hydration window (§3.5), so a restart re-primes it —
stated so the restart path is a design property, not luck. Deferred intents do
NOT consume `maxSwapsPerCycle` slots — only executed swaps count against the
per-tick budget (a wave of deferrals must not starve the tick's executable
swaps).

`deferralCeilingMs` default: **1 800 000 (30 min)** — long enough for a real
build/turn to land (p95 turn length on the autonomous runs is minutes, not
hours), short enough that a stuck-forever footer (the 90 min frozen-indicator
family `ActiveWorkSilenceSentinel` watches) cannot starve the swap intent
indefinitely. Starvation is structurally impossible in both directions: the
proactive intent dies at the ceiling (never blocks the wall), and the reactive
path never waits more than `reactiveGraceMs`.

**Why polling, not events (stated constraint):** the pane/process detectors
have no completion event to subscribe to — a 10 s re-check cadence inside a
bounded window is the honest mechanism available. If `SubagentTracker` gains
completion events later, event-driven continuation for the subagent leg is a
named possible refinement (the poll stays for the footer leg regardless).

### 4.3 The F3 mitigations (attached to every forced kill)

When a swap DOES proceed over in-flight work — reactive after grace, or
`force` on an interactive refresh — the respawn carries a mitigation payload.
Both hooks already exist; this wires them:

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
   Frontloaded decision (Q4, §14): v1 reads the in-memory map; across a server
   restart the last unanswered inbound is unknowable and the mitigation
   degrades HONESTLY — the ledger row's `inbound` field is a tri-state:
   `'reinjected'` | `'none'` (map consulted, genuinely no unanswered inbound)
   | `'unknown'` (map unavailable: post-restart, or the exactly-once ingress
   ledger is dark on this install). The durable inbound queue (CMT-1118
   family) is the named future source that upgrades `'unknown'` to a real
   answer; Close the Loop: that upgrade is a tracked follow-up, not a silent
   hope.
3. **Payload hygiene (normative, not advisory):** the mitigation block is a
   QUOTED-DATA envelope, same discipline as replicated-store injections — the
   inbound body is (a) delimiter-neutralized (any occurrence of the envelope's
   own delimiter sequence inside the body is escaped so the quoted region
   cannot be closed early by content), (b) attributed from the stored
   `SenderEnvelope` ("from <sender> at <time>"), never laundered into bare
   instruction position — the respawned session sees "a message from X awaits
   an answer", not an anonymous imperative. **The attribution fields are the
   SAME trust class as the body (this is load-bearing, R2-M1):** the sender
   NAME (`fromUsername`/`fromFirstName`) is fully sender-controlled Telegram
   payload — a hostile display name is an injection vector aimed at the
   FRAMING position, which is MORE privileged than the escaped body it wraps.
   Therefore the attribution fields are delimiter-neutralized AND
   length-clamped (≤ 64 chars, ellipsized) by the same rule as the body, and
   rendered INSIDE the quoted-data region — the only text outside the quoted
   region is the FIXED template ("a message from the quoted sender below
   awaits an answer"), which contains zero sender-derived bytes. A
   spec-compliant build has no unneutralized sender-controlled byte anywhere
   in the prompt. Clamps: mitigation block ≤ 2 000 chars total; quoted inbound
   ≤ 1 000 chars (ellipsized); subagent list ≤ 10 entries then "+N more".
   Subagent `lastMessage` bodies are NOT included (transcript PATHS land in
   the ledger row only, never bodies — §6.1).

Mitigations are additive to the respawn and never gate it — a failure to
enumerate or resolve the inbound logs and proceeds (the kill is already
justified when we reach here; the mitigation must not become a new wedge).

**Respawn-notice hygiene (the mechanism must not become topic spam):** each
account-swap respawn currently posts a per-swap "Session respawned." notice to
the topic — across a reactive cascade that is a notice per hop, the
notification shape this spec's own constitution line forbids. Swap respawns
are therefore posted at most ONCE per session per swap episode (subsequent
hops inside the same episode coalesce into the first notice's thread of
meaning: the mitigation payload already tells the resumed conversation what
happened). A `proceeded`-with-mitigations respawn keeps its one honest notice
— the user should know work was interrupted; they should not be told five
times in ten minutes.

### 4.4 Signal vs. Authority — why this gate may block (argued, not assumed)

The gate holds real blocking authority (it defers/refuses kills) while being a
low-context detector. That is defensible here, and the spec says why instead
of hoping nobody asks: the gate is a DETERMINISTIC structural-state check
(pane footer, child processes, subagent registry — no LLM judgment, no content
interpretation), the same accepted class as `ModelSwapService`'s idle refusal
and the reaper's KEEP-guards. Its authority is bounded on every edge: the
ceiling (a deferral cannot outlive 30 min), the grace (a reactive wait cannot
exceed 120 s), `force` (an interactive caller can always override with the
mitigation toll), the recovery exemption (it can never deadlock recovery), and
I7 (its own uncertainty never strands either direction). A wrong "busy" costs
a delayed optimization; a wrong "idle" costs what today's behavior ALWAYS
costs. No unbounded or unappealable authority exists in the design.

**Supervision tier (P7, declared):** Tier 0 — every decision point in both
pieces is deterministic quota/state math over structural signals; no LLM
policy judgment exists anywhere in the pipeline, so there is nothing for a
Tier 1 supervisor to validate. This is the deterministic-evaluator carve-out,
named rather than assumed.

### 4.5 `/sessions/refresh` refusal shape (interactive callers)

The gate check runs PRE-202 — the route answers the truth synchronously
instead of accepting-then-failing:

- Busy → **HTTP 409** `{code: 'session-busy', turnInFlight: boolean,
  subagents: [{agentType, ageMinutes}]}` (counts and ages only — no titles,
  no transcript paths, no message content on the wire). One spelling
  everywhere: the wire code and the §6.2 ledger reason are BOTH
  `session-busy` (the round-2 `session_busy`/`session-busy` split is
  resolved to the hyphenated form).
- The request body gains optional `force: true` — overrides ONLY the work
  gate, NEVER the rate guard (a forced refresh still consumes rate budget and
  still respects the 5-per-10-min cap; `force` is not a rate bypass).
- **Force provenance (Know Your Principal):** `force` arrives over the Bearer
  token — bearer-level authority, not operator authority. The spec does NOT
  attribute `force` to "the operator"; the ledger row records provenance
  honestly (`force: true`, `callerClass`, `authLevel: 'bearer'`). If a future
  surface wants operator-attributed force, it must arrive via an
  operator-authenticated surface (dashboard PIN) — out of scope here, named so
  it is a decision and not an accident.
- **Why bearer-level force is acceptable (stated, not assumed):** today EVERY
  bearer refresh kills unconditionally — `force` merely restores the status
  quo for a caller that explicitly asks for it, while the gate strictly ADDS
  protection everywhere else; there is no regression surface. A distinct
  force capability/scope (a token that can refresh but not force) is a named
  hardening follow-up (`force-capability-scope`), not v1 — it would be the
  first per-capability split in the Bearer model and deserves its own design.
- Existing internal callers of `/sessions/refresh` and `refreshSession` are
  audited for the new refusal code as part of the build (test plan §12 —
  every caller either handles 409/`session-busy` or passes a deliberate
  caller class).

---

## 5. Invariants

- **I1 (checked = executed):** a proactive swap executes only onto the exact
  target that passed brakes (a)+(c) via filter→score→verify (§3.3);
  execute-time revalidation refuses, never re-selects. The two-threshold seam
  (§2.2) is structurally closed for proactive callers.
- **I2 (all-hot ⇒ zero proactive):** when no eligible target is under the
  target ceiling, zero proactive swaps execute; the ledger carries
  enter/leave/heartbeat rows per candidate (§3.1) sufficient to prove the
  episode externally.
- **I3 (dwell):** a session account-swapped at T is not proactively swapped
  again before T+`dwellMs`, across server restarts (ledger-backed).
- **I4 (no optimization kill of live work):** a proactive swap, model-swap, or
  interactive refresh never kills a session that the gate reports busy — it
  defers or refuses. Only reactive-after-grace and explicit `force` may, and
  then always with the §4.3 mitigation payload attached.
- **I5 (nothing silent):** every refused, deferred, dropped, invalidated,
  failed, suppressed, or proceeded-over-work decision writes one structured
  ledger row with its reason (per the §6.1 schema), and the counters are
  readable on the status route.
- **I6 (the guarantee is untouched):** the reactive swap path never waits more
  than `reactiveGraceMs` (+ one tick of scheduling), ignores dwell, reversal,
  the all-hot brake, and the thrash breaker, and with Piece 1 dry-run + Piece
  2 dark its decision behavior is byte-identical to v1.3.722.
- **I7 (uncertainty direction, per caller class):** detector uncertainty
  resolves BUSY for proactive/optimization callers (protect work) and
  BUSY-FOR-GRACE for reactive callers (protect the mid-write without ever
  stranding — the grace deadline always proceeds); indeterminate-detector
  deferrals are distinguishable in the ledger (`busy-indeterminate`).
- **I8 (breaker is bounded, loud, and restart-proof):** the thrash breaker
  always half-opens after its backoff, opening it raises exactly one deduped
  attention item per `episodeId` (surviving restarts — the hydration window
  covers the FULL backoff and the deadline is carried in the schema, §3.5),
  and no permanent silent suppression state exists.
- **I9 (a deferred intent is never stale at fire time):** every deferral
  retry re-runs the full brake pipeline; an intent invalidated by an
  account-change underneath it never executes (§4.2).
- **I10 (default-slot integrity):** no proactive swap ever changes which
  account the default config slot serves — untagged sessions are outside the
  proactive candidate set by construction (§3, Q3).
- **I11 (callerClass provenance):** `callerClass` is set only by
  server-internal call sites — no route ever populates it from request input
  (§4.2). A wire-derived `recovery` class would bypass the gate and the
  mitigations by construction; the wiring test pins that no route surfaces
  the field.

## 6. Observability

### 6.1 The authoritative ledger-row schema (single source)

`state/swap-ledger.jsonl` — one JSON object per decision. Field × decision-kind
matrix (● = always, ○ = when applicable, — = never):

| field | type | swapped | refused | deferred | dropped | invalidated | failed | proceeded |
|---|---|---|---|---|---|---|---|---|
| `ts` | ISO-8601 | ● | ● | ● | ● | ● | ● | ● |
| `kind` | `'proactive'\|'reactive'` | ● | ● | ● | ● | ● | ● | ● |
| `decision` | enum (row headers) | ● | ● | ● | ● | ● | ● | ● |
| `callerClass` | `SwapWorkGateCallerClass` | ● | ● | ● | ● | ● | ● | ● |
| `session` | string | ● | ● | ● | ● | ● | ● | ● |
| `topicId` | number? | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `machineId` | string | ● | ● | ● | ● | ● | ● | ● |
| `from` | account id | ● | ● | ● | ● | ● | ● | ● |
| `to` | account id | ● | ○ | ○ | ○ | ○ | ○ | ● |
| `fromUtilPct` / `toUtilPct` | number / number? | ● | ○ | ○ | ○ | ○ | ○ | ● |
| `reason` | enum §6.2 | — | ● | ● | ● | ● | ● | ● |
| `dwellRemainingMs` | number | — | ○ (dwell) | — | — | — | — | — |
| `deferralAgeMs` | number | ○ (post-defer) | — | ● | ● | ○ | — | ○ |
| `deferCount` | number | ○ | — | ● (final row) | ● | ○ | — | ○ |
| `inFlight` | `{turn: boolean, subagents: number}` | ○ | ○ | ● | ● | ○ | — | ● |
| `subagentLeg` | `'ok'\|'absent'\|'indeterminate'` | ○ | ○ | ● | ● | ○ | — | ● |
| `killedSubagents` | number | — | — | — | — | — | — | ● |
| `killedSubagentList` | `[{agentType, ageMinutes, transcriptPath?}]` | — | — | — | — | — | — | ● |
| `inbound` | `'reinjected'\|'none'\|'unknown'` | — | — | — | — | — | — | ● |
| `force` / `authLevel` | boolean / `'bearer'` | — | — | — | — | — | — | ○ |
| `defaultAccountChanged` | boolean | ○ (reactive untagged) | — | — | — | — | — | ○ |
| `episodeId` | string | ○ (breaker) | ○ (breaker/all-hot) | ○ | ○ | ○ | ○ (failure streak) | ○ |
| `breakerOpenedAt` / `breakerDeadline` | ISO-8601 / ISO-8601 | ○ (episodeId rows) | ○ (episodeId rows) | ○ | ○ | ○ | ○ | ○ |
| `transition` | `'enter'\|'leave'\|'heartbeat'` | — | ○ (all-hot / thrash-breaker) | — | — | — | — | — |
| `errorClass` | string (constructor-name/enum ONLY — §3.6) | — | — | — | — | — | ● | — |

**Never in a row:** message bodies, subagent `lastMessage` content, raw error
text (`errorClass` is a constructor name or fixed enum member, never
`.message`/`.stack`), tokens, credentialed URLs. Transcript PATHS appear only
in `killedSubagentList` — a LOCAL-ONLY debugging aid, excluded from any
export/feedback bundle that leaves the machine. The status route (§6.3)
serves counters only, and no DEDICATED route serves raw rows; stated
honestly, the generic dashboard file viewer treats `state/swap-ledger.jsonl`
like any other state file (readable by the same Bearer/PIN holder who can
already read every state ledger and the transcripts themselves — no new
privilege is created by this file).

### 6.2 Enums (single-sourced; §3/§4 reference these)

- `decision`: `swapped | refused | deferred | dropped | invalidated | failed |
  proceeded` (`proceeded` = proceeded over busy with mitigations — reactive
  after grace, or force; its `reason` carries the busy-state observed at kill
  time: the `busy-*` member that was live when the grace deadline or force
  fired).
- `reason`: `all-hot | dwell | no-material-target | reversal | thrash-breaker
  | target-revalidation-failed | busy-turn | busy-subagents |
  busy-indeterminate | deferral-ceiling-dropped | intent-stale |
  session-busy | swap-exec-failed` (one spelling — `session-busy` is also the
  §4.5 wire code).
- `breakerState`: `closed | open | half-open`.
- `callerClass`: §4.2 (defined once as the gate's input type; server-internal
  only per I11).
- `authLevel`: `bearer` (the only member in v1 — operator-attributed force is
  the named `force-capability-scope` follow-up, §4.5).

### 6.3 Log lines + status surface

- **Log lines (grep-stable):** `[ProactiveSwap] REFUSED session=… from=…
  reason=<reason> fromUtil=… bestAltUtil=…` · `[SwapWorkGate] DEFERRED
  session=… caller=proactive-swap reason=busy-turn|busy-subagents(N)|
  busy-indeterminate deferralAgeMs=…` · `[SwapWorkGate]
  PROCEEDED-WITH-MITIGATIONS session=… caller=reactive-swap
  killedSubagents=N inbound=reinjected|none|unknown`.
- **Status surface:** `GET /subscription-pool/proactive-swap` (existing route
  for the monitor's `status()`) grows `brakes: {refusals: {byReason},
  thrash: {reversalsDetected, pairLevelDetections, breakerState,
  breakerOpenedAt, episodes: [{episodeId, openedAt, expiresAt}]},
  execFailures: {bySession, streaks}, deferrals: {active, byReason, dropped,
  invalidated, proceededWithMitigations}, hydration:
  'complete'|'under-primed', corruptLinesSkipped}` — the **thrash-detected
  counter** the operator asks for lives here. All fields are LOCAL-SCOPE
  (this machine — §8); the route documents that. **Surface scoping, stated:**
  the counters are API-only in v1 — a dashboard tile rendering them is the
  named follow-up `swap-brakes-dashboard-tile`, so nobody assumes the
  operator's counter surfaces in the UI on day one.

### 6.4 Guard posture + attention hygiene

- Both pieces register in the guard manifest (`src/monitoring/guardManifest.ts`)
  so `GET /guards` grades them (`on-dry-run` during soak, `dark-default` on the
  fleet) and a load-shed disable trips the posture tripwire like every other
  guard. **Manifest note:** the proactive-swap monitor currently sits on the
  manifest's exclusion list; registering the brakes requires RECLASSIFYING
  that existing exclusion entry (a deliberate edit, called out so the
  exclusion-lint doesn't get a silent carve-out).
- `swapContinuity` gates the refresh/model-swap paths INDEPENDENTLY of
  `proactiveSwap` — its posture row exists even where proactive swap is off.
  While its parent lever is off it grades `dark-default` (ships-dark, quiet —
  never a load-bearing gap, because no critical path depends on it until the
  fleet flip).
- Attention items: ONE per thrash episode (deduped on `episodeId`, §3.5); ONE
  per execution-failure streak (§3.6); ONE if the ledger is unwritable
  (observability loss is itself surfaced, not swallowed).

## 7. Config surface (all additive; shipped defaults shown)

```jsonc
{
  "subscriptionPool": {
    "proactiveSwap": {
      // existing: enabled, thresholdPct: 80, watchMarginPct: 15,
      //           maxSwapsPerCycle: 3, tickMs: 180000
      // cooldownMs (10m) is SUBSUMED by antiThrash.dwellMs — kept working
      // for back-compat when antiThrash is dark (§9).
      "antiThrash": {
        "enabled": true,          // sub-feature of an already-opt-in feature; §10 ladder
        "dryRun": true,           // log would-refuse/would-defer, change nothing
        "targetHeadroomPct": 15,  // target ceiling = thresholdPct - this (→ 65)
        "minImprovementPct": 15,  // source - target must be ≥ this (see §3.3 defaults note)
        "dwellMs": 2700000,       // 45 min
        "reversalWindowMs": 1800000,
        "thrashBreakerThreshold": 2,
        "thrashBreakerBackoffMs": 3600000,
        "swapFrequencyThreshold": 3,      // rotation detector: N proactive executions…
        "swapFrequencyWindowMs": 10800000, // …of one session within 3 h feed the counter
        "allHotHeartbeatMs": 1800000,     // all-hot/breaker heartbeat row cadence
        "reactiveHopAlertThreshold": 2    // reactive hops per session per reversalWindowMs → ONE alert
      }
    }
    // Piece 2 (the work gate). The "swapContinuity" KEY IS OMITTED from the
    // shipped config ON PURPOSE — omission is what routes it through the
    // dev-agent gate (live on a development agent, dark on the fleet). An
    // explicit `"enabled": false` would pin it dark EVERYWHERE including dev
    // (the #1001 anti-mechanism). Shown here for documentation only:
    //
    // "swapContinuity": {
    //   "enabled": <omitted — dev-agent gate resolves>,
    //   "dryRun": true,             // log would-defer/would-mitigate, change nothing
    //   "deferralCeilingMs": 1800000, // 30 min
    //   "reactiveGraceMs": 120000,    // 2 min
    //   "recheckMs": 10000            // busy re-check cadence inside a grace window
    // }
  }
}
```

The model-swap subagent leg (Q5) is a micro-flag on the MODEL-SWAP config
block (`subagentIdleLeg`, **concrete default `false`** — never
stage-following), not here — §4.2.

All numeric reads use nullish coalescing (`?? default`, never `||` — zero is a
legal disable for several of these).

### 7.1 Per-key config liveness (the half-enable trap, named per key)

The monitor snapshots knobs into readonly fields at construction today, so
"read live" must be engineered, not asserted (the dynamic-MCP half-enable
precedent). Normative table:

| key | liveness | mechanism |
|---|---|---|
| `antiThrash.enabled` / `dryRun` | live per tick | monitor re-reads via config getter each pass |
| `antiThrash.*` numeric knobs | live per tick | same getter (constructor re-wired from snapshot fields to getter) |
| `swapContinuity.enabled` | **restart-required** | the gate's wiring into `SessionRefresh` is constructor-injected |
| `swapContinuity.dryRun` | live per evaluation | gate reads via getter |
| `swapContinuity.*` numeric knobs | live per evaluation | same getter |
| model-swap `subagentIdleLeg` | live per evaluation | `ModelSwapService` getter |

A key marked restart-required is stated in the CLAUDE.md template blurb (§9)
so "I flipped it and nothing changed" has a documented answer.

## 8. Cross-machine posture (declared, not implied)

Everything this spec introduces is **machine-local BY DESIGN**: the
subscription pool is per-machine seats (a login lives in one machine's config
homes), the sessions being swapped are tmux processes on THIS machine, and the
swap ledger records THIS machine's decisions (`machineId` stamped per row).
Consequences, stated honestly:

- **Dwell does NOT follow a topic across a machine move** (`POST
  /pool/transfer`): the destination machine's ledger has no row for the moved
  session, so its dwell starts cold there. Bounded gap: at most one
  proactive swap sooner than dwell would have allowed, once, after a move —
  and the move itself already respawned the session (the work-gate carries no
  cross-machine memory either, same bound). Ledger-visible on both machines.
- **The breaker is per-machine.** A thrash episode on machine A does not
  suppress proactive swaps on machine B — correct, because B's pool pressure
  is B's own seats; wrong only in the cross-machine contention case below.
- **Status fields are local-scope** (§6.3) — the route says so; no `?scope=pool`
  merge ships in v1.
- **Cross-machine account contention** — two machines each independently
  evacuating onto (or off) the SAME shared account, reproducing §2.2's seam at
  mesh scale — is REAL and OUT OF SCOPE here: it needs pool-scope quota
  placement input (the capacity-heartbeat quota state already replicated for
  session placement), not a bigger ledger. Registered as a named tracked
  follow-up (`cross-machine-swap-contention`) per Close the Loop; until then
  each machine's brakes still bound ITS OWN loop (the 2026-07-02 incident was
  single-machine).

## 9. Migration & back-compat

- **Config:** `migrateConfig()` adds nothing (absence = defaults; both blocks
  are optional; `swapContinuity` MUST stay omitted — §7). No existing key
  changes meaning. `cooldownMs` keeps its exact current semantics whenever
  `antiThrash` is disabled/dry-run; when antiThrash is live, dwell (the
  stricter bound) governs and `cooldownMs` is ignored with one boot-log notice
  — never a startup error.
- **Behavioral back-compat:** antiThrash `dryRun:true` + swapContinuity dark ⇒
  every decision byte-identical to v1.3.722, plus ledger/log rows. The seam
  closure (§3.3) only activates for calls that pass an explicit target — the
  reactive path and any third-party `onQuotaPressure` caller are untouched by
  construction (the §3.3 funnel contract).
- **API:** `cfg.swap`/`onQuotaPressure` gain optional fields only; `status()`
  gains additive fields; the `/subscription-pool/proactive-swap` response stays
  a superset. `/sessions/refresh` gains the 409 refusal + `force` field (§4.5)
  — a new response code on an existing route, flagged in the release notes and
  caller-audited (§12). No route is renamed; nothing 503s that didn't.
- **Ledger:** new file; absence = cold start (dwell begins un-primed — the one
  accepted gap: the first post-upgrade 45 min can proactively swap a session
  that was swapped pre-upgrade. One-time, bounded, logged).
- **Template awareness (Agent Awareness Standard):** the CLAUDE.md template's
  proactive-swap bullet gains the refusal semantics + "why didn't my session
  swap?" → read `GET /subscription-pool/proactive-swap` brakes/deferrals, "why
  did my swap wait?" → the work gate, and the §7.1 restart-required note.
  `PostUpdateMigrator` carries the section per Migration Parity.

## 10. Rollout ladder (graduated, per house convention)

1. **Dark (fleet):** both features ship in code, OFF. `proactiveSwap.enabled`
   is already fleet-dark; `antiThrash` nested under it inherits that darkness.
   `swapContinuity` key omitted → dev-agent gate → dark on fleet. Rung-1
   honesty for fleet opt-ins: an install that ALREADY opted into
   `proactiveSwap.enabled` receives antiThrash dry-run ledger rows immediately
   on update (observability, zero behavior change) — that is stated here
   rather than calling rung 1 fully dark; rung 4 is where their live behavior
   changes. **Mandatory registration:** `swapContinuity` lands in
   `DEV_GATED_FEATURES` with its justification line + the wiring test (the
   dev-gate lint enforces the registration).
2. **Dev-gate, dryRun (echo, immediately on merge):** antiThrash
   `enabled:true, dryRun:true` and swapContinuity live-on-dev `dryRun:true`.
   Soak target: one full all-hot afternoon. Success = the ledger shows
   would-refuse rows covering ≥90% of the swaps that a replay of §1 would have
   executed, and — operationalized — **no would-refuse row within 15 min
   preceding a genuine wall event on the refused session's account** (the
   naive "zero would-refuse against a genuine wall" is vacuously green on a
   wall-free day; this form is falsifiable). (Dark-but-load-bearing note:
   while in dryRun these guards are `loadBearingSoaking` on `/guards`, with
   the bounded soak window — they lapse loud if the flip stalls.)
3. **Live on dev:** flip both `dryRun:false` on echo. Run the §11 live proof.
   **3a. Model-swap subagent leg (its own rung, deliberately separate):** only
   after rung 3 is proven, flip `subagentIdleLeg: true` on the dev agent —
   this is the first moment a live model-swap's refusal surface changes, and
   it changes by explicit flip, never by deploy (§4.2, R2-M4).
4. **Fleet default:** antiThrash defaults `enabled:true, dryRun:false` for any
   install that opts into `proactiveSwap.enabled` (the brake becomes part of
   the feature's definition — a proactive swapper without anti-thrash is the
   bug, not a configuration); swapContinuity graduates to fleet default-on one
   release later (it touches every refresh path, wider blast radius, longer
   soak). **Multi-machine caveat, stated:** on an install where several
   machines share the same accounts, machine-local brakes can still co-select
   the same cool account from stale local views (§8's contention case at
   fleet scale). The brake remains a STRICT improvement over today (which has
   no brakes at all), so rung 4 is not gated on it — but the
   `cross-machine-swap-contention` follow-up is the full fix and is named
   here so the residual is a tracked decision, not a surprise.

Rollback levers at every rung: `antiThrash.dryRun:true` restores v1.3.722
decision behavior without losing observability; removing the dev-agent's
`swapContinuity` enablement un-wires the gate entirely (SessionRefresh reverts
to unconditional kill).

## 11. Live-proof clause (gate for "built", not for this draft)

Run on the dev agent, real pool, real sessions:

1. **All-hot afternoon replay:** with ≥3 accounts measured ≥80% (arrange by
   scheduling normal autonomous work; the state recurs most afternoons), over a
   ≥4 h window: **zero executed proactive swaps; zero ping-pong reversals;**
   ledger shows `all-hot`/`no-material-target` refusals (enter/leave/heartbeat
   rows); `GET /subscription-pool/proactive-swap` counters match the ledger.
2. **Genuine wall still swaps:** drive one account to an actual rate-limit
   escalation (or replay the sentinel event on a tagged test session): the
   reactive swap fires exactly once, within `reactiveGraceMs`+one tick, onto a
   least-bad target per today's semantics, breaker/dwell notwithstanding.
3. **Subagent survival:** in a session with 6 live Agent-tool subagents,
   trigger a proactive swap intent (lower the threshold on a test config):
   the intent defers (`busy-subagents(6)` rows, deduped first/final/count),
   the subagents run to completion untouched, the swap executes after they
   land — after re-passing the full pipeline (I9). **Zero subagent kills
   attributable to proactive swaps in the window** (cross-check
   SubagentTracker stop records vs swap-ledger timestamps).
4. **Forced-kill mitigations:** force a reactive swap over a busy session:
   the respawned session's first prompt contains the enumerated-subagent block
   and the re-injected unanswered inbound (quoted-data envelope, §4.3); the
   topic receives the honest respawn notice; ledger row carries
   `killedSubagents=N, inbound=reinjected`.
5. **Breaker proof:** with brakes (a)/(c) artificially disabled in a test
   config, manufacture one reversal: the breaker opens at the threshold,
   raises ONE attention item, suppresses proactive swaps for the backoff,
   half-opens on schedule — and a mid-backoff server restart boots the breaker
   OPEN with the original deadline and does NOT re-alert (I8).

## 12. Testing Integrity (three tiers — NON-NEGOTIABLE house standard)

- **Unit (`tests/unit/`):** both sides of EVERY brake boundary — all-hot at
  ceiling−1/at-ceiling; dwell at T+dwellMs−1/+1 (including ledger-hydrated
  dwell after a simulated restart); improvement bounds at exactly-15/14.9;
  reversal window edges; same-session refusal vs pair-level detection-only;
  the rotation-frequency detector at threshold−1/at-threshold (an A→B→C→A
  rotation MUST open the breaker; a once-per-wave legitimate swap must NOT);
  breaker open→half-open timing + restart re-derivation (episodeId dedupe,
  deadline carried in-row, restart in the SECOND half of the backoff boots
  OPEN — the R2-M2 regression case pinned; failure-streak backoff also
  re-derived); hydration segment-walk (window spanning active + both rotated
  segments; under-primed flag when retention cannot cover the window; corrupt
  trailing line skipped + counted);
  the full I7 uncertainty×caller matrix (proactive/reactive/recovery ×
  working/idle/indeterminate × subagent-leg present/absent); filter→score→
  verify order (a hot target must be unreachable even when scoring prefers
  it); intra-tick per-target cap; deferral full-pipeline re-run (stale-wave,
  breaker-mid-wait, account-changed→invalidated); defer dedupe
  (first/final/count); ceiling-drop→re-intent backoff; execution-failure
  backoff + streak escalation; ledger hydration including the
  newest-rotated-segment case; schema round-trip for every decision kind;
  mitigation payload clamps + delimiter neutralization.
- **Integration (`tests/integration/`):** `/subscription-pool/proactive-swap`
  additive `brakes`/`deferrals`/`hydration` fields; `/sessions/refresh` 409
  `session-busy` shape + `force:true` semantics (force overrides the gate,
  never the rate guard); ledger single-writer (concurrent decisions produce
  well-formed interleaved rows); per-key config liveness (§7.1 — a live-knob
  change binds next tick; `swapContinuity.enabled` does not); **migration
  default-direction assertion:** an absent `antiThrash` block on a
  `proactiveSwap.enabled:true` install MUST resolve `enabled:true,
  dryRun:true` (a `false`-resolving builder mistake would skip the soak
  fleet-wide).
- **E2E (`tests/e2e/`):** feature-is-alive through the real server init path —
  with the features enabled the status fields and refusal codes are served
  (200, populated), with them dark the posture rows grade `dark-default` and
  no behavior changes; guard-manifest registration present (the exclusion-list
  reclassification lands with it).
- **Wiring-integrity:** the gate's injected deps (sessionManager async probe,
  subagentTracker, config getter, SwapLedger) are non-null, non-no-op, and
  delegate to real implementations; the monitor→scheduler `targetAccountId`
  pass-through is pinned (the funnel contract §3.3); every existing
  `refreshSession` caller either handles the new refusal or declares a caller
  class, and the three enumerated recovery call sites carry the `recovery`
  tag (the §4.2/§4.5 caller audit, as a test); **no route surfaces
  `callerClass` from request input (I11)**; **exactly one `ps` fork per
  snapshot-TTL regardless of concurrent probe count** (the §4.1 shared-cache
  mandate, pinned so a builder composing per-call primitives fails the test).
- **P19 sustained-failure tests:** a permanently-busy session (footer wedged
  30+ min) produces bounded, constant-cost deferral rows (dedup holds) →
  ceiling drop → re-intent backoff — never unbounded rows or a stuck intent; a
  permanently-failing swap execution produces bounded retries with backoff +
  exactly ONE deduped attention item.
- **Burst invariant:** one thrash episode = exactly one attention item,
  regardless of suppressed-intent volume (the notification-flood test shape).

## 13. Failure modes

| Failure | Behavior |
|---|---|
| Pane capture fails / tmux busy (proactive check) | `busy-indeterminate` → defer (I7); persistent indeterminate rows in the ledger are the detector-broken signal |
| Pane capture fails (reactive grace) | busy-for-grace (S2/I7) — worst case the swap waits the full 120 s, then proceeds; never stranded, never mid-write |
| `claudeSessionId` missing on the state record | subagent leg unavailable → footer leg decides; ledger rows flag `subagentLeg:'absent'` so the blind spot is measurable |
| Swap ledger unwritable/corrupt | treated as empty (dwell un-primed, reversal/breaker detection cold), ONE attention item; decisions continue — observability loss never blocks the guarantee |
| Swap execution throws | `failed` row + per-session exponential backoff (cap dwellMs); 3 consecutive → ONE deduped attention item (§3.6) — never a silent every-tick retry |
| Thrash breaker wedges open | impossible by construction (time-based half-open, no external latch); state re-derived identically across restarts; posture visible on `/guards` |
| Deferral records accumulate | per-session keyed map, entries die at execute/drop/ceiling/invalidate; hard cap = live session count; ledger rows deduped first/final/count |
| Defer→drop→regenerate loop | re-intent backoff per SESSION after a ceiling drop (default dwellMs; target rotation cannot evade a session key) — bounded churn, re-derived from `dropped` rows across restarts (§4.2) |
| N≥3 rotation (A→B→C→A) | pair detectors blind by design; the per-session frequency detector feeds the breaker at 3 executions / 3 h (§3.5) |
| Reactive hop-chain in an all-hot pool | never refused (I6); capped by the refresh rate counter; ONE deduped escalation per episode at the hop threshold or on a rate-cap refusal (§3.1) |
| Restart inside the second half of a breaker backoff | hydration window covers the FULL backoff; deadline carried in-row; breaker boots OPEN with the original deadline (§3.5, R2-M2) |
| Ledger segment rotated inside the window | segment-walk reads newest-first across retained segments; if retention cannot cover the window the boot flags `under-primed` — never a silent cold index (§3.5) |
| QuotaPoller stale during grace window | execute-time revalidation (§3.3) uses the freshest snapshot and refuses on ceiling breach — stale data fails toward NOT swapping (proactive) |
| Server restart mid-deferral | pending deferrals dropped; intent regenerates from live quota state next tick (deferral state is derived) |
| Server restart mid-breaker-backoff | breaker re-derives OPEN from the ledger with the original deadline; no re-alert (episodeId dedupe) |
| Both detector legs broken for a genuinely idle session | proactive swaps defer until the 30 min ceiling then drop (with re-intent backoff); cost is a missed optimization, never a stuck session; reactive unaffected (busy-for-grace bounds it at 120 s) |

## 14. Frontloaded Decisions (all round-1 draft open questions, resolved)

1. **Q1 — dwell is a constant 45 min in v1; no adaptive scaling.** The
   structural decision (constant vs poll-interval-derived) is made here:
   constant. Adaptive dwell couples the brake to poller behavior and makes the
   soak unreadable. The NUMBER carries a justified cheap-to-change-after tag:
   it is a config constant behind a dry-run soak (§10 rung 2) whose explicit
   success metric measures this number's effect; changing it later is a config
   default edit with no interface, money, identity, or durable-side-effect
   surface.
2. **Q2 — reactive stays byte-identical (I6).** "Reactive prefers the
   coolest under-ceiling target" is the NAMED follow-up
   `reactive-coolest-target`, not this spec. The all-hot reactive hop-chain is
   accepted explicitly, bounded by the pre-existing 5-per-10-min refresh rate
   counter (§3.1). §3.4's wording is reconciled with the 120 s grace ("within
   `reactiveGraceMs` + one tick", not "immediately").
3. **Q3 — untagged sessions are excluded from the proactive candidate set**
   (§3). A background optimizer must not mutate the default-slot binding
   (`resolveDefaultAccountId`) as a side effect; that lever is `POST
   /credentials/set-default`. Reactive rescue of untagged sessions is
   unchanged and its ledger row carries `defaultAccountChanged: true`.
4. **Q4 — inbound re-injection reads the in-memory map in v1**, and the
   ledger `inbound` field is the honest tri-state
   `'reinjected'|'none'|'unknown'` (`unknown` = post-restart, or the
   exactly-once ingress ledger dark on this install). The durable inbound
   queue (CMT-1118) is the named future source (Close the Loop).
5. **Q5 — the model-swap subagent leg ships behind its own micro-flag on the
   model-swap config** (`subagentIdleLeg`, **concrete default `false`**,
   graduating on its own rung — §10 rung 3a), not inside `swapContinuity`. The
   pieces stay independently shippable; a live feature's refusal surface
   changes only at a deliberate flag flip, never on deploy and never when an
   unrelated flag flips. (Round-2 R2-M4 killed the earlier "follows the
   model-swap rollout stage" wording, which resolved to ON for a live
   feature — self-contradictory with this same rule.)
6. **Q6 — a per-caller deferral-ceiling override for autonomous runs is out
   of scope in v1.** The "swap at the next turn boundary" hook (the boundary
   the pool-transfer consent gate already uses) is the finer instrument, named
   as the follow-up `swap-at-turn-boundary`; cheap-to-change-after is
   justified: purely additive later, and v1 behavior at the ceiling (drop, the
   wall wins) is safe by construction — the accepted cost is a missed
   optimization, never killed work.

## 15. Round-1 findings disposition

Every round-1 finding (report: `docs/specs/reports/
swap-continuity-antithrash-round1-findings.md`, reviewed commit 932b77b9e) and
what this revision did with it. **Adopted = the design changed** (not a
rebuttal appended). Zero findings were rejected; the one genuine tension a
finding created with the operator's four properties (B10 vs property (d)) is
resolved in §0 — the property is scoped precisely (absolute for optimization
callers; the reactive guarantee is the single named, bounded, mitigated
exception) rather than either the finding or the property being discarded.

| finding | disposition | where |
|---|---|---|
| B1 (six open questions) | Adopted — all six resolved into Frontloaded Decisions | §14, §3, §4.2, §4.3 |
| B2 (breaker restart) | Adopted — breaker state derived from ledger at boot; episodeId-deduped alerts | §3.5, I8, §13 |
| B3 (stale deferred intent) | Adopted — full brake pipeline re-runs at every retry; account-change invalidates | §4.2, I9 |
| B4 (sync probe stalls loop) | Adopted — async coalesced probes mandatory; shared ps snapshot per sweep | §4.1 |
| B5 (cross-machine absent) | Adopted — machine-local-by-design declared with reasons + bounded gaps; contention follow-up registered | §8 |
| B6 (no parent-principle) | Adopted — frontmatter parent-principle + exact registry heading "Structure beats Willpower" | frontmatter |
| B7 (gate at chokepoint) | Adopted — gate inside refreshSession, default callerClass 'interactive-refresh'; funnel contract stated | §4.2, §3.3 |
| B8 (config self-contradiction) | Adopted — swapContinuity key OMITTED (shown commented-out); DEV_GATED_FEATURES registration named | §7, §10 |
| B9 (rate-guard ordering) | Adopted — gate check before the rate record; refusals consume zero budget | §4.2 |
| B10 (grace semantics) | Adopted — swap at first not-busy; new-work-at-deadline outcome stated; §3.4 wording fixed. Tension with property (d) resolved in §0 | §4.2, §3.4, §0 |
| B11 (selection order) | Adopted — normative filter→score→verify; hot targets structurally unreachable | §3.3 |
| B12 (deferral ownership) | Adopted — gate stateless; monitor owns deferrals; reactive grace = bounded async in SessionRefresh | §4.2 |
| B13 (ledger schema) | Adopted — single authoritative field×decision matrix | §6.1 |
| B14 (test plan) | Adopted — three tiers + wiring-integrity + P19 sustained-failure + burst invariant | §12 |
| S1 (pair-level reversal) | Adopted — pair-level detection feeds the breaker; refusal stays session-keyed (08:19 wave preserved) | §3.5 |
| S2 (reactive indeterminate) | Adopted — busy-for-grace in the reactive arm; I7 restated | §4.1, I7, §13 |
| S3 (defer churn) | Adopted — re-intent backoff after ceiling drop; defer rows deduped first/final/count | §4.2 |
| S4 (ledger reads) | Adopted — boot hydration bounded to the window incl. newest rotated segment; write-through index | §3.5 |
| S5 (rotation helper) | Adopted — maybeRotateJsonlSegment + cached byte counter, named | §3.5 |
| S6 (intra-tick pile-on) | Adopted — max 1 executed swap per target per tick | §3.3 |
| S7 (force provenance) | Adopted — force is bearer-level, recorded as such; operator attribution requires an operator surface | §4.5 |
| S8 (re-injection envelope) | Adopted — quoted-data envelope normative: delimiter neutralization, SenderEnvelope attribution, concrete clamps | §4.3 |
| S9 (failed kind + P19 gap) | Adopted — 'failed' decision; per-session backoff; streak escalation; failure-mode row | §3.6, §6.2, §13 |
| S10 (signal-vs-authority) | Adopted — the gate's blocking authority argued and bounded explicitly | §4.4 |
| S11 (I7 unimplementable) | Adopted — new tri-state checkSessionWorkState named; "invents no new detection" overclaim dropped | §4.1, §2.3 |
| S12 (config liveness) | Adopted — per-key liveness table; getter re-wiring named; restart-required keys documented | §7.1 |
| S13 (independence/posture) | Adopted — swapContinuity independent of proactiveSwap; dark-default posture stated | §6.4 |
| S14 (single append site) | Adopted — SwapLedger module is the only writer | §3.5 |
| S15 (refresh refusal shape) | Adopted — pre-202 409 shape; force semantics; caller audit as a test | §4.5, §12 |
| S16 (baseline by reference) | Adopted — canonical baseline filter referenced | §4.1 |
| S17 (polling justified) | Adopted — no completion event exists; event-driven named as refinement | §4.2 |
| L1 (inert bound) | Adopted — defaults note: minImprovementPct binds only when headroom is retuned | §3.3 |
| L2 (soak criterion) | Adopted — falsifiable form: no would-refuse within 15 min preceding a wall | §10 |
| L3 (all-hot row volume) | Adopted — enter/leave/heartbeat state-transition rows | §3.1, §6.1 |
| L4 (index eviction) | Adopted — window-bounded prune per tick; pre-existing lastSwapAt leak fixed alongside | §3.2, §2.4 |
| L5 (no bodies in rows) | Adopted — never-in-a-row list; counters-only status; no raw-row route | §6.1 |
| L6 (status enums) | Adopted — breakerState + episodes shape specified | §6.2, §6.3 |
| L7 (callerClass enum) | Adopted — defined once as the gate input type | §4.2 |
| L8 (deferrals vs cycle budget) | Adopted — only executed swaps consume maxSwapsPerCycle | §4.2 |
| L9 (reason enum single source) | Adopted — §6.2 is the source; other sections reference it | §6.2 |
| L10 (line drift) | Adopted — swap wiring corrected to server.ts:16023-16026 | §2.2 |
| L11 (guardManifest exclusion) | Adopted — reclassification of the monitor's exclusion entry called out | §6.4 |
| L12 (rung-1 honesty) | Adopted — fleet opt-ins get dry-run rows at rung 1; stated in the ladder | §10 |
| L13 (merged into B1-Q4) | Adopted via Q4 tri-state | §4.3, §14 |

## 16. Round-2 findings disposition

Every round-2 finding (report: `docs/specs/reports/
swap-continuity-antithrash-round2-findings.md`, reviewed commit a7f6e2cb0) and
what this revision did with it. Zero rejected; three deliberately scoped-down
with the reason stated in-row (Adopted-scoped). No fold weakened any §0
property — every major fix is additive or corrective within the round-2
structure, as predicted in that report.

| finding | disposition | where |
|---|---|---|
| R2-M1 (sender-attribution injection) | Adopted — attribution fields neutralized + clamped (≤64), rendered inside the quoted region; only fixed template text outside | §4.3(3) |
| R2-M2 (breaker restart window arithmetic) | Adopted — hydration window includes the full backoff; newest-first segment walk with honest under-primed flag; breakerOpenedAt/breakerDeadline in-schema; derivation anchored on the most-recent episodeId row of any kind | §3.5, §6.1, I8, §13 |
| R2-M3 (N≥3 rotation blind spot) | Adopted — direction-agnostic per-session frequency detector (3 executions / 3 h) feeds the breaker, detection-only; "structurally impossible" claim scoped to 2-cycles | §3.5, §7, §12 |
| R2-M4 (subagentIdleLeg default contradiction) | Adopted — concrete default false, own rollout rung 3a; §0 carries the delivery-honesty note instead of the overclaim | §4.2, §0, §7, §10, §14-Q5 |
| R2-M5 (re-intent backoff pair-keying) | Adopted — backoff AND ceiling clock keyed on the session; deferral age carries across target re-selection; restart re-derivation from dropped rows | §4.2, §13 |
| R2-M6 (reactive cascade P19 + silent foundation) | Adopted — detection-only escalate-once per episode (hop threshold / rate-cap refusal); Eternal-Sentinel exemption declared; reactive failures write `failed` rows (fixes the silent `void` discard one layer down). I6 intact: nothing new refused | §3.1, §3.4-adjacent, §13 |
| R2-m1 (raw-rows overstatement) | Adopted-scoped — wording corrected to "no dedicated route" + honest file-viewer note; deny-listing `state/` in the file viewer is an install-wide policy change deliberately left out of this spec's scope | §6.1 |
| R2-m2 (breaker-row volume) | Adopted — thrash-breaker suppression gets the same enter/leave/heartbeat treatment, episodeId-keyed | §3.1, §6.1 |
| R2-m3 (probe not deliverable as cited) | Adopted — public `checkSessionWorkState` on SessionManager; batched path around `computeHasActiveProcesses`; per-leg indeterminate; one-ps-per-TTL wiring test | §4.1, §12 |
| R2-m4 (grace-loop ps fan-out) | Adopted — short-TTL shared ps snapshot cache at SessionManager level, covering sweeps AND concurrent grace loops | §4.1 |
| R2-m5 (callerClass provenance) | Adopted — I11 + wiring test; no route surfaces the field | §4.2, I11, §12 |
| R2-m6 (failure streak in-memory) | Adopted — streak/backoff/dedupe re-derived from `failed` rows at boot inside the hydration window | §3.6 |
| R2-m7 (recovery callers unenumerated) | Adopted — three known recovery call sites enumerated + tagged; an untagged future one fails SAFE into refusal, visible in the reap-log | §4.2 |
| R2-m8 (respawn-notice spam) | Adopted — one notice per session per swap episode; proceeded-kill keeps its single honest notice | §4.3 |
| R2-m9 (P20 missing) | Adopted — P20 + the P7 Tier-0 declaration added to lessons-engaged | frontmatter, §4.4 |
| R2-m10 (force breadth) | Adopted — no-regression rationale stated; `force-capability-scope` named as the hardening follow-up | §4.5 |
| R2-m11 (ledger durability rules) | Adopted — atomic single-line appends; corrupt trailing line tolerated + counted | §3.5, §6.3 |
| R2-m12 (projected utilization) | Adopted — headroom-as-burn-proxy stated explicitly; `burn-aware-targeting` named refinement | §3.3 |
| R2-m13 (fleet rollout contention) | Adopted — rung-4 multi-machine caveat stated; strict-improvement argument; follow-up named as the full fix (no rollout gate — a braked installation is never worse than today's unbraked one) | §10 |
| R2-L1 (transcript-path durability) | Adopted — local-only debugging aid, excluded from export/feedback bundles | §6.1 |
| R2-L2 (errorClass undefined) | Adopted — constructor-name/fixed-enum only, never .message/.stack | §3.6, §6.1 |
| R2-L3 (backoff lost on restart) | Adopted — re-derived from `dropped` rows (upgraded from "state best-effort" to derivation, since the hydration window already carries the rows) | §4.2 |
| R2-L4 (heartbeat not a knob) | Adopted — `allHotHeartbeatMs` config knob | §3.1, §7 |
| R2-L5 (enum edges) | Adopted — `authLevel` in §6.2; `proceeded` reason defined (the busy-* state at kill time) | §6.2 |
| R2-L6 (spelling split) | Adopted — `session-busy` everywhere (wire + ledger) | §4.5, §6.2, §12 |
| R2-L7 (dashboard scoping) | Adopted — API-only v1 stated; `swap-brakes-dashboard-tile` named follow-up | §6.3 |
| R2-L8 (migration default direction) | Adopted — §12 integration assertion pins dryRun-true resolution | §12 |
| R2-L9 (P7 tier undeclared) | Adopted — Tier 0 declared with the deterministic-evaluator rationale | §4.4 |
| R2-L10 (glossary/density) | Adopted-scoped — eli16 pointer added at the top of the spec; a full in-spec glossary is deliberately skipped (the eli16 companion IS the plain-language surface; duplicating it inline drifts) | intro |
| R2-L11 (1-line drift) | Adopted — `server.ts:16022-16025` | §2.2 |

## Open questions

*(none — all resolved into §14 Frontloaded Decisions)*

---

*Draft authored 2026-07-02 (Session A, roadmap 4.4 + operator-priority thrash
brake); round-2 revision same day (round-1 findings folded — §15); round-3
revision same day (round-2 findings folded — §16). Evidence:
`logs/server.log` (echo, v1.3.722). Convergence round 3 in flight; nothing
here is approved for build.*
