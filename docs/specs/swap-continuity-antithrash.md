---
slug: swap-continuity-antithrash
title: Swap Continuity Under Pressure — Anti-Thrash Brakes + In-Flight Work Deferral (Roadmap 4.4, F3/P1-A6)
status: converged (round-6 verdict CONVERGED — 0 CRITICAL / 0 MAJOR; all 8 round-5 findings verified resolved; 3 MINOR + 4 LOW folded in-round; GPT-tier via pi SERIOUS-ISSUES→calibrated-zero-MAJOR + gemini-2.5-pro MINOR-ISSUES, calibrations on the round-6 record)
author: echo
eli16-overview: swap-continuity-antithrash.eli16.md
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
constitution: Bounded Blast Radius (a quota optimization must not silently expand into "all my subagents were killed"); Structure beats Willpower (the anti-thrash rule lives at the swap chokepoint, not in prose); The User Experience Is the Product (F-series umbrella — the safety/continuity mechanism must not BE the disruption)
lessons-engaged: "P19 (three brakes + a bounded, loud breaker on a repeating loop — §3, §3.5; the monitor's pre-existing silent-retry gap is ALSO fixed, §3.6); P17 (ONE deduped attention item per thrash episode / per failure streak / per ledger loss — §3.5, §3.6, §6.4); P18 (every refusal, deferral, drop, and failure is a counter + a ledger row — sole named exception: ledger-lost refusals are counter-only because the writer itself is down, I5/§3.5; dry-run counters soak before authority — §6, §10); P14-family flap accounting (dwell + reversal state persisted, restart-safe — §3.2, §3.5); F3 finding family (killed-subagent enumeration + unanswered-inbound re-injection at the swap chokepoint — §4.3); Bounded-Notification-Surface lesson shape (bind the PRIMITIVE with a default class, never a per-caller table — §4.2); #1001 anti-mechanism (dev-gated key OMITTED from shipped config, never an explicit false — §7, §10); dynamic-MCP half-enable precedent (per-key config-liveness table — §7.1); CMT-1118 durable inbound queue named as the future inbound-mitigation source (§4.3); Signal vs. Authority (the gate's blocking authority argued, bounded, and classed — §4.4); P20 Verify the State, Not Its Symbol (the work gate verifies live pane/process/subagent STATE before any kill and treats an unreadable symbol as indeterminate, never as idle — §4.1, I7); P7 supervision: Tier 0, declared (§4.4 — deterministic quota/state math at every decision point, no LLM policy judgment anywhere in either piece)."
earned-from: 2026-07-02 proactive-swap thrash day (echo dev agent, v1.3.722 — 36 executed proactive swaps / 72 [SessionRefresh] account-swap log lines across 8 waves; repeated kills of six parallel build subagents during the U4 and Session-A autonomous runs); F3 finding family (inbound eaten by respawn) and P1-A6
roadmap: Session A item 4.4 — "Continuity under pressure: proactive/reactive swap + model-swap + refresh defer while a turn or live subagents are in flight, or re-inject the last unanswered inbound + enumerate killed subagents"
review-convergence: "2026-07-03T04:31:03.000Z"
approved: true
approved-basis: "Operator standing preapproval, topic 29836, 2026-07-02 (recorded in the registered Session-A run goal: spec approvals + all in-scope reversible decisions). Approval recorded transparently under that authorization; the converged verdict is round-6 CONVERGED with zero outstanding findings at any severity (0 MUST-FIX, 0 SHOULD-FIX, 0 LOW outstanding — the 3 MINOR + 4 LOW raised in-round were folded as d62c78ff1 with the §20 disposition table)."
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

**"Measures" is load-bearing (R4-M1):** an account with NO quota reading, or a
reading older than the §3.3 freshness bound, does not *measure* anything — it
cannot satisfy this rule, and it counts toward all-hot exactly like a hot
account. Without this pin the brake is defeated by its own measurement layer:
the real primitive returns **0 when there is no reading** ("unknown = treated
as empty / still selectable", `bindingUtilization`,
`src/core/QuotaAwareScheduler.ts:44-57`), so a quota-blind account reads as the
coolest target in the pool and the brake stands down precisely when it knows
least. The validity gate lives in §3.3 (it is part of target eligibility, one
rule for both brakes); when the filtered set is empty, the refusal reason
resolves by ONE rule (R5-L2 — the old "excluded by the validity gate alone"
wording invited a misreading): `all-hot` **iff EVERY alternate carried a
VALID (present + fresh) reading at/above the ceiling**; `target-unmeasured`
the moment ANY alternate lacked a valid reading — regardless of what its
frozen or absent value would have read. A pool of stale-frozen-hot
alternates is a measurement outage wearing hot numbers, never provable
heat — a measurement outage must be distinguishable from genuine heat,
never dressed as it. `target-unmeasured`
refusals get the same enter/leave/heartbeat state-transition treatment as
all-hot rows (a sustained poller outage must not relocate the per-tick write
pattern this scheme exists to prevent).

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
reactive path's failure today is silent — the rate-limit listener discards the
whole `onQuotaPressure` RESULT promise (`void
_quotaAwareScheduler?.onQuotaPressure(...)`, `src/commands/server.ts:
15972-15976`), so `refreshFn`'s `false` return folds into that discarded
result and a respawner throw is an unhandled rejection (R3-L2: the seam is
the discarded result promise, not a `void` on `refreshFn` itself). Reactive
execution failures therefore now write `failed` ledger rows through the §3.5
chokepoint — and their escalation channel is NAMED (R3-m5: they are not
rate-cap refusals, so trigger (2) is not their path): they ride the §3.6
streak machinery — 3 consecutive reactive execution failures on one session
raise ONE deduped attention item, kind-separated (`kind: 'reactive'`) so a
reactive streak never mixes with a proactive one, restart-proof by the same
`failed`-row derivation. Detection-only; I6 intact.

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
- **Index hygiene (R3-M1 — retention must feed the WIDEST detector; term
  added by R5-m2):** the in-memory dwell/reversal/frequency index prunes
  entries older than **`retentionBoundMs = max(dwellMs, reversalWindowMs,
  thrashBreakerBackoffMs, swapFrequencyWindowMs, thrashBreakerBackoffMs +
  max(reversalWindowMs, swapFrequencyWindowMs))`** (= 4 h at shipped
  defaults — the last term dominates) on each tick; the pre-existing
  `lastSwapAt` never-evicted leak is fixed by the same sweep. The round-3
  revision's `max(dwellMs, reversalWindowMs)` bound silently starved the
  §3.5 frequency detector: at dwell pace, entries aged out at 45 min while
  the detector needed 3 h of history, so the per-session count could never
  reach its threshold — the detector existed in text and was dead in
  arithmetic. The R5-m2 term exists for the same one-formula reason: an
  episode's CONTINUATION window runs from its CLOSE (open + backoff) plus
  the trigger's own window, so continuation memory must survive a restart
  for up to `thrashBreakerBackoffMs + max(reversalWindowMs,
  swapFrequencyWindowMs)` after the OPEN row — a builder must never
  hand-tune a second bound; the max() absorbs the new term. One formula,
  defined HERE, consumed by §3.5's hydration as well: retention ⊇ every
  detection window AND every continuation window, structurally — a future
  detector with a wider window must extend this max or it is starved by
  construction (the §12 retention-bound test pins the formula, including
  the continuation term). Cost, stated honestly: dwell paces executions to
  ≤1 per session per 45 min, so 4 h of history is ≤6 executed-swap entries
  per session plus refusal bookkeeping — the widened bound costs bytes, not
  scans. Hard bound: the index never exceeds (live sessions + entries
  younger than `retentionBoundMs`).

### 3.3 Brake (c) — target-materially-better

**Bound 0 — the quota-reading validity gate (R4-M1; evaluated BEFORE both
bounds below):** a proactive target is eligible ONLY when its quota reading is
**present and fresh** — `lastQuota != null` AND `now − measuredAt ≤
quotaFreshnessMs` (default **1 800 000, 30 min** = 2× the quota poller's
default 15-min cadence, `QuotaPoller.ts` `pollIntervalMs ?? 15 * 60_000`). An
absent or stale reading is NOT "under the ceiling"; the account is excluded
from the FILTER set and counts toward all-hot (§3.1). Why this gate must
exist, grounded in the real primitives: `bindingUtilization` returns **0 when
there is no reading** (`src/core/QuotaAwareScheduler.ts:44-57` — deliberate
for reactive selectability, catastrophic as a proactive optimization input);
enrollment starts every account at `lastQuota: null`
(`SubscriptionPool.add()`, `src/core/SubscriptionPool.ts:323`); and a FAILED
poll leaves the
last-good snapshot in place indefinitely (`QuotaPoller.pollAll` skips the
update on a null read — `failed++; continue`), while `measuredAt` exists on
the snapshot (`AccountQuotaSnapshot.measuredAt`) and NOTHING in
`selectAccount`/`accountAtPressure` reads it. Without bound 0, a
freshly-enrolled or poll-broken account measures 0 → passes both bounds by
maximum margin → attracts EVERY hot session, the all-hot brake stands down,
and no detector fires (each session hops once — no inversion edge, no
frequency crossing): unbounded kills paced only by the per-target-per-tick
cap.

**The SOURCE leg carries the same validity requirement:** a source with an
ABSENT reading measures 0 and is never ≥ `thresholdPct` — already the code's
behavior, now stated as normative rather than accidental. A source whose
reading is STALE beyond the freshness bound is NOT acted on proactively even
if the frozen value reads ≥ threshold: a kill must never ride an unverifiable
pressure claim. Proactive optimization therefore requires a fresh reading on
BOTH legs — when the whole measurement layer goes dark (poller broken), the
optimizer effectively pauses, the measurement-layer analog of I12 (invariant
I13: the optimizer never outlives its measurements). The REACTIVE path is
deliberately untouched (I6): the primitive's unknown-is-selectable behavior
exists FOR rescue — a walled session's rescue onto an unmeasured account still
beats death — and reactive selection keeps it byte-for-byte.

**The enrollment-day case (no permanent exile of a healthy new account):** a
freshly-enrolled account is proactive-ineligible only until its FIRST reading
lands. The poller covers every non-disabled claude-code account each
`pollIntervalMs` (15 min default), and the monitor's existing `triggerPoll`
hook (`ProactiveSwapMonitor.ts:191-198` — fires a fresh `pollAll` whenever any
account is in the watch zone, i.e. exactly the moments proactive swap wants
targets) accelerates that to within one tick under pressure. Only an account
whose polls keep FAILING stays unmeasured — the honest state (a seat whose
usage cannot be read is usually a seat whose auth is broken, which could not
serve a landed session either), visible via `target-unmeasured` counters, the
`quotaValidity` status block (§6.3), and the account's own `needs-reauth`
status. **First-reading pile-on, named (R5-L4):** once a new account's first
real reading lands (~0%), it legitimately attracts up to 1 executed swap per
tick until its reading reflects the landed sessions' burn — bounded by the
per-tick `triggerPoll` refresh under pressure, the 15-point headroom budget
(bound 1), and dwell on each moved session; `burn-aware-targeting` (bound 1's
named refinement) is the eventual smoothing. Named so a soak showing a brief
cluster of swaps onto a fresh account is read as the bounded case, not a
regression. **Freshness-boundary flapping, named (R5-L1):** a reading
hovering at the `quotaFreshnessMs` edge (a partially-degraded poller) flips
an account eligible/ineligible per tick, emitting `target-unmeasured`
enter/leave row pairs per flap — bounded (≤2 rows per candidate per tick,
the same accepted volume class as R4-L4; `triggerPoll` under pressure keeps
readings fresh in practice, so the band is transient). Freshness HYSTERESIS
(a re-admit bound slightly tighter than the exclude bound) is a named
purely-additive refinement (`freshness-hysteresis`), not v1.

**Sustained measurement blindness surfaces once, and the trigger is
POOL-LEVEL, not candidacy-dependent (P17/P19; R5-m1):** the
`measurement-blind` condition is evaluated per monitor tick over the POOL
ITSELF — `proactiveSwap` enabled AND the pool holds ≥2 non-disabled accounts
AND zero of them carry a present, fresh reading — NOT over "the alternate
set of some candidate evaluation". (The ≥2 conjunct, R6-L4: a pool of 0–1
accounts has no alternate to swap to, so the optimizer is inherently a no-op
there — "blind" would be a false alarm about a pause that costs nothing.) This distinction is load-bearing: when the poller dies
outright, every SOURCE reading also goes stale within `quotaFreshnessMs`,
stale sources leave candidacy, no candidate evaluation runs, and a
candidacy-scoped trigger would never fire — whole-pool blindness (the
loudest case) would be exactly the silent one. When the pool-level condition
has held continuously for longer than `allHotHeartbeatMs`, ONE deduped
attention item is raised ("proactive optimization is measurement-blind — no
fresh quota readings on any account for 30+ min"), `episodeKind:
'measurement-blind'`, episode-deduped as usual — a paused-by-blindness
optimizer must never be silent about why. **Where the episode's dedupe
state lives, stated honestly (R6-m2):** when candidate evaluations DO run,
`target-unmeasured` rows carry the `episodeId` and anchor the dedupe
durably like every other episode; in the whole-pool case — where zero rows
are written by construction — the episode lives in memory plus the §6.3
status block only, so a RESTART during a sustained blind episode may
re-raise the item once. Accepted at that bound (the R5-m2/R5-m3
calibration class: one extra item, toward alerting, during a state that
genuinely warrants attention); a durable pool-level marker row (the
`outage-summary` shape) is the named purely-additive refinement
(`measurement-blind-marker-row`) if a soak shows restart-flap noise. The
check reads the pool's
snapshots directly and must NOT assume the poller loop is running: today
`quotaPoller.start()` is gated on `subscriptionPool.size() > 0` AT BOOT
(server.ts), so a pool populated after boot has no background poller until
restart — the blind-surfacing must detect "zero fresh readings" from the
snapshots themselves (the §12 build audit carries the wiring note).

**Rule:** the executed target must additionally satisfy BOTH bounds, evaluated
on the same snapshot that the decision logs (§6):

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

1. **FILTER** the alternate set to accounts that pass the validity gate
   (bound 0 — reading present + fresh) AND whose `bindingUtilization` is
   under the absolute ceiling (bound 1). If the filtered set is empty → the
   refusal is `all-hot` iff every alternate carried a VALID reading at/above
   the ceiling, `target-unmeasured` the moment any alternate lacked a valid
   reading — regardless of its frozen value (§3.1, R5-L2). **Scope guard
   (R6-L2):** both clauses CLASSIFY an empty filtered set and nothing else
   — while ANY alternate survives the filter, selection proceeds to
   scoring; a mixed pool holding one valid under-ceiling target alongside
   unmeasured others is never refused by this rule.
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
target instead of re-selecting, after re-validating the WHOLE decision's
materiality against a fresh snapshot at execute time (R4-m4 — the checks are
enumerated; refuse, never re-select, on any failure):

1. **Target validity + ceiling:** the target still passes bound 0 (reading
   present + fresh) and bound 1 (under the ceiling) → else structured refusal
   `target-revalidation-failed`, retried next tick — never a silent fallback
   to the 90-threshold re-selection.
2. **Source identity (R3-m3):** the execute call re-reads the session's
   CURRENT account and requires it to equal `intent.from` — a reactive swap
   that COMPLETED in the sub-tick window between the pipeline pass and the
   execute call (I9's retry-tick invalidation cannot see inside a tick)
   invalidates the intent (`invalidated`, reason `intent-stale`) instead of
   landing a second kill on a just-rescued session.
3. **Source pressure, fresh:** the source still measures ≥ `thresholdPct` (on
   a valid reading) → else `invalidated`/`intent-stale` — a wave that
   subsided inside the sub-tick window must not produce a pointless kill.
4. **Improvement delta, fresh:** `source − target ≥ minImprovementPct` →
   else `target-revalidation-failed`.

Checks 3–4 close the residual sub-tick seam the deferred path never had
(§4.2's retry ticks re-run the whole pipeline; the direct-execute window did
not) — property (c) is verified at the actual kill point, not one sub-tick
before, at the cost of two comparisons on a snapshot the revalidation already
holds. **Row-volume bound for `target-revalidation-failed`, stated (R4-L4 —
accepted rather than heartbeat-schemed):** these are per-tick rows without
the enter/leave/heartbeat treatment; the accepted worst case is a snapshot
flip-flopping around the ceiling each poll, producing at most one refused row
per candidate session per tick (~20 rows/h/session at the 3-min tick) —
self-limiting because the next tick's own FILTER re-runs against the fresh
snapshot and usually resolves to a different target or an all-hot refusal
(which HAS volume treatment). Visible in `refusals.byReason`; if a soak shows
sustained volume, extending the state-transition scheme to this reason is a
purely-additive later change. Reactive callers pass no
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
failed — every reactive swap, AND every interactive work-gate outcome (the
§4.5 `session-busy` refusal and the `force` proceed) is appended to a durable
JSONL ledger: `state/swap-ledger.jsonl`. Recovery-class refreshes write NO
swap-ledger rows (R6-m1, decided): a recovery respawn is gate-exempt by
class (§4.2) — no swap decision exists to record — and its durable record is
the reap-log, where refused and executed recoveries already land. The authoritative row schema is §6.1 (single
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
- **Ledger-loss fail direction (R3-M3 — decided, not implied):** while the
  ledger is UNWRITABLE (an append fails), proactive optimization PAUSES:
  every proactive intent is refused with reason `ledger-lost` until an
  append succeeds again (level-triggered — each tick's decision re-attempts
  its write, so recovery needs no restart; the pause honors `dryRun` like
  every other brake — a dry-run install logs would-refuse counters only).
  §10's own principle decides the direction: "a proactive swapper without
  anti-thrash is the bug, not a configuration" — running the optimizer while
  dwell, reversal, breaker, frequency, and re-intent state all go cold is
  exactly that bug wearing a failure-mode row. The REACTIVE path is
  untouched (I6: the guarantee never depends on the ledger). Honest
  carve-outs, stated: (1) `ledger-lost` refusals cannot write ledger rows —
  the writer is what died — so they are counted in-memory on the status
  route (§6.3 `ledger` block) and covered by the episode's ONE attention
  item (§6.4), the durable trace. (1b — the outage's OTHER row-loss class,
  R4-m1:) while the ledger is unwritable, REACTIVE swaps still execute (I6)
  and forced interactive refreshes still `proceed` — and neither can write
  its row either. These non-refusal decisions **update the in-memory
  write-through index REGARDLESS of append failure** (dwell's clock-start
  for a reactively-rescued session, the frequency count, and reversal state
  stay primed through the outage — otherwise the post-resume first tick
  could prematurely re-swap a just-rescued session, the exact dwell case)
  and are counted in the §6.3 `ledger` block (`rowsLostWhileDown`). The
  I5 exception is therefore an outage CLASS, not a single reason: refusals
  during the outage are counter-only; executed/proceeded decisions are
  index-primed + counted; the durable trace for all of them is the
  episode's one attention item PLUS the post-resume outage-summary row
  (below). Index priming survives only until the next restart (the rows
  that would have re-primed it were never written). **The outage+restart
  conjunction, stated honestly (R5-m3 — externally double-confirmed, both
  externals rated it MAJOR; calibrated MINOR on the record with the
  bounded-cold rationale):** ledger unwritable → reactive swap primes dwell
  in memory only → restart → dwell boots cold for the rescued session → ONE
  premature proactive swap can execute per affected session per conjunction.
  That swap must still pass every OTHER brake (all-hot, bound 0, both §3.3
  bounds, the breaker) AND the §4 work gate — in-flight work still cannot be
  killed — the same magnitude as §9's explicitly-accepted cold-start class.
  What the spec previously claimed here — "the boot flags UNDER-PRIMED as
  usual" — was FALSE: the under-primed flag as defined (read path below)
  detects RETENTION shortfall, not a mid-window row gap, so no detection
  happened. The corrected mechanism: **the level-triggered RESUME's first
  successful append writes ONE `outage-summary` row** (§6.1/§6.2 — carrying
  `rowsLostWhileDown`, the refusal count, and the outage span; it stamps no
  session/account fields and never anchors the breaker derivation), so the
  gap becomes durable, boot-visible, and soak-auditable; a boot hydration
  that finds an `outage-summary` row inside its window flags `hydration:
  'under-primed'` with the gap named — never a silent cold index wearing a
  complete one's face. Optional hardening, named for the builder (not
  mandated): a conservative post-outage boot grace — treat all sessions as
  dwell-covered for one `dwellMs` after an `outage-summary` row younger
  than `dwellMs` — closes even the one-premature-swap residual at the cost
  of one missed optimization window.
  (2) The pause is scoped to UNWRITABLE. A corrupt-but-writable or absent
  ledger hydrates cold/under-primed and KEEPS optimizing — bounded: new rows
  land immediately and every brake re-primes within its own window (§9's
  cold-start acceptance). The unbounded-cold case R3-M3 names is the one
  where no new state can ever accumulate; that is the case that pauses.
- **Read path (never a per-decision scan):** hydrate ONCE at boot — and
  UNCONDITIONALLY (R4-L3): the ledger module loads and hydrates at every
  boot regardless of `antiThrash.enabled`, and reactive rows are appended
  regardless, so the index is warm the moment the flag flips on mid-run
  (§7.1 marks the flag live-per-tick; a flag whose enable had to wait for a
  restart-to-hydrate would be the half-enable trap §7.1 exists to prevent).
  The hydration window is `hydrationWindowMs = retentionBoundMs` (§3.2 — ONE
  formula for both bounds: `max(dwellMs, reversalWindowMs,
  thrashBreakerBackoffMs, swapFrequencyWindowMs, thrashBreakerBackoffMs +
  max(reversalWindowMs, swapFrequencyWindowMs))`, = 4 h at defaults). The
  breaker backoff (60 min) is deliberately inside the bound — a window that
  stopped at dwell (45 min) would silently lose a live breaker episode in
  the second half of its backoff, the exact §2.4 restart class this ledger
  exists to close — and the frequency window (3 h) is inside it too (R3-M1):
  the round-3 revision's `max(dwellMs, reversalWindowMs,
  thrashBreakerBackoffMs)` bound re-blinded the rotation detector on every
  restart, re-arming it near-zero each boot on exactly the restart-heavy
  days the ledger exists for. The read walks retained segments NEWEST-FIRST
  (active file, then rotated segments) until the oldest row read is older
  than the window — bounded by `keepSegments` = 2, so at most active + 2
  segments (~30 MB) at boot, one-time, off the hot path — a ceiling the
  wider window does NOT raise (the segment count, not the window, caps the
  read). If retention cannot cover the window (all retained rows are younger
  than the bound and a segment was evidently lost to rotation), the boot
  flags itself UNDER-PRIMED honestly: one log line + a `hydration:
  'under-primed'` status field — never a silent cold index masquerading as a
  complete one. After boot: an in-memory per-session index, write-through on
  append. No decision ever re-reads the file.
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
  feeds the breaker's FREQUENCY tier: the threshold crossing OPENS the
  breaker directly (T2 below, R3-M2). Detection-only in refusal terms — it
  never refuses the triggering execution (dwell already paces the session);
  what it does is trip the breaker that stops the systemic rotation.
  **The evasion band, named (R4-L1):** hops spaced wider than
  `swapFrequencyWindowMs / (swapFrequencyThreshold − 1)` (~90 min at
  defaults) never trip T2 — the inherent evasion band of any threshold
  detector. Each such hop must still independently pass (a)+(c)+dwell, so
  it is individually-justified churn at ≤⅔ the incident pace, bounded by
  dwell alone. Named so a soak reading "green detectors + steady ~90-min
  churn" is interpreted as the band, not as proof of no rotation.
  **The band has a POOL-AGGREGATE shape too (R6-L1, from GPT-tier —
  calibrated with the rationale recorded):** a COHORT of sessions each
  executing at most `swapFrequencyThreshold − 1` hops (e.g. a two-hop
  A→B→C migration wave, 45 min apart, then stopping) trips T2 on no
  session and inverts no pair — aggregate churn of up to 2 kills per
  session inside one window with every detector green. This is NOT the
  incident pathology wearing a new shape: every hop must independently
  pass bound 0 + (a) + (c) + dwell on FRESH readings (a genuine ≥15-point
  improvement onto a genuinely cool target — the 2026-07-02 jitter hops
  pass none of these), pool-wide execution pace is capped by
  `maxSwapsPerCycle` per tick plus the per-target cap, and the §4 work
  gate protects in-flight work on every kill regardless of detector
  state. The residual is bounded, individually-justified movement whose
  AGGREGATE volume is visible in the ledger's `swapped` rows and the
  §6.3 counters; a pool-level aggregate-churn detector is the named
  purely-additive refinement (`pool-aggregate-churn-detector`) if a soak
  shows cohort waves recurring. (The §3.5 multi-session sentence below is
  scoped to wave ROTATIONS — returning cycles — which this terminating
  migration shape is not.)
- **Thrash episode / breaker (two trigger tiers — the arithmetic is
  load-bearing, R3-M2):** the breaker opens on EITHER trigger:
  - **T1 (inversion tier):** ≥ `thrashBreakerThreshold` (default **2**)
    inversion-class increments — same-session reversal refusals + pair-level
    inversion detections, the "thrash counter" of the two bullets above —
    pool-wide within `reversalWindowMs`. Inversion edges are prompt by
    nature (a 2-cycle's reverse edge lands inside the reversal window by
    definition), so a short aggregation window is the right shape for them.
  - **T2 (frequency tier):** a single per-session frequency-threshold
    crossing (the rotation detector above) opens the breaker DIRECTLY — the
    crossing IS the episode trigger, no second corroborating increment
    required. Why T2 cannot ride T1's arithmetic (the round-3 headline
    finding): one session's frequency increments are ≥ `dwellMs` (45 min)
    apart BY CONSTRUCTION — dwell paces its executions — so two of them can
    never land inside `reversalWindowMs` (30 min); routing the frequency
    signal through T1 makes the rotation detector permanently unable to open
    the breaker it feeds. The frequency detector already aggregates over its
    OWN 3 h window internally; its threshold (3 executions at ~the dwell
    floor) is already the systemic-rotation signature.

  **The rotation scenario, re-derived (proof the attack is now caught):**
  single session S, A→B at t=0, B→C at t=45 m, C→A at t=90 m (the dwell
  floor). With retention ⊇ `swapFrequencyWindowMs` (§3.2, R3-M1) all three
  executions are in the index at t=90 m → count = 3 =
  `swapFrequencyThreshold` → the crossing opens the breaker AT t=90 m (T2).
  The 4th hop (t=135 m) is suppressed (`thrash-breaker`). A restart between
  the 2nd and 3rd executions changes nothing: the hydration window (§ read
  path) covers the full 3 h, so the count re-primes and the 3rd execution
  still crosses. Worst-case harm before the brake: exactly
  `swapFrequencyThreshold` hops — bounded and then loud, never indefinite
  with every detector green. Multi-session wave rotations (the 2026-07-02
  shape) are caught the same way — each rotating session's own crossing
  opens or joins the episode — and usually earlier via T1's pair-level arm.

  **Episode continuation (P17 — a sustained pathology is ONE episode, not an
  hourly alert drip; generalized over BOTH trigger tiers, R4-m2):** a
  re-open within the trigger's own detection window of the previous
  episode's close, on the SAME trigger signature, is a CONTINUATION — same
  `episodeId`, deadline extended (the continuation row stamps the same
  `episodeId` with the NEW `breakerDeadline`, so the boot derivation still
  anchors correctly on the most-recent deadline-carrying row), NO second
  attention item. Trigger signatures and windows, per tier: **T2** — same
  SESSION as the previous frequency episode's trigger, within
  `swapFrequencyWindowMs` of that episode's close; **T1** — same unordered
  ACCOUNT PAIR as the previous inversion episode's open-marker increment
  row, within `reversalWindowMs` of that episode's close. **Lookup rule,
  pinned (R5-L3):** continuation matches against the most recent episode
  WITH THE SAME TRIGGER SIGNATURE — never merely the most recent episode of
  any signature (the wrong reading loses a continuation whenever an
  unrelated episode interleaves: one extra item — toward alerting, never
  toward silence — but a needless drip all the same). **Continuation memory
  is restart-proof by derivation, like everything else (R5-m2):** the
  episode CLOSE row — the suppression `leave` row written when the backoff
  elapses — carries the episode's `triggerSignature` (§6.1: tier + session
  for T2 / tier + unordered pair for T1), and boot hydration re-derives
  continuation memory from the most-recent close row per signature inside
  the hydration window (whose formula's R5-m2 term exists exactly so that
  row is still retained, §3.2). **The close row can be MISSING for a real
  episode (R6-m3 — the down-across-the-deadline case):** the leave row is
  written by a live process at backoff-elapse; a server that is DOWN when
  the deadline passes never writes it. Hydration therefore synthesizes
  the close IN MEMORY from the signature-carrying OPEN-marker row
  whenever that row's `breakerDeadline` elapsed with no matching close
  row inside the window — the deadline IS the close time — writing
  nothing to the ledger (the read path stays read-only). A restart that
  spans the deadline keeps continuation memory instead of minting a
  duplicate item for the same sustained pathology. Without this, a restart inside the
  continuation window forgot the close, and the same session's next
  crossing minted a new `episodeId` + a second item for a sustained
  pathology — the alert-drip class this paragraph exists to forbid, riding
  a reboot. Without the T1
  arm, a sustained inversion-tier thrash re-accumulates 2 increments within
  ~2 ticks of each half-open and re-opens hourly — a literal builder minting
  a new `episodeId` each time produces exactly the alert drip this
  paragraph's own P17 line forbids. A crossing with a DIFFERENT signature
  (another session for T2, another pair for T1) is a genuinely new episode
  (new information, new item). **Half-open, pinned (one sentence):**
  half-open IS closed-with-continuation-memory — no third persisted state
  exists; the only thing distinguishing half-open from closed is that a
  re-open matching the continuation rule joins the previous episode instead
  of minting a new one.

  Opening (either tier) suppresses ALL proactive swaps for
  `thrashBreakerBackoffMs` (default **3 600 000, 1 h**), raises ONE deduped
  attention item ("proactive account-swap is thrashing — suppressed for 1h;
  accounts A/B/C all ≥80%"), and logs every suppressed intent with reason
  `thrash-breaker`. The breaker auto-half-opens after the backoff (P19
  family: a guard's own failure mode must be bounded and loud, never a
  silent permanent off). Reactive swaps ignore the breaker (I6).
- **Breaker state survives restart (this spec must not re-create §2.4):**
  breaker state is DERIVED, not stored as separate authority — and the
  derivation is anchored on the EPISODE, not on the increment rows that
  opened it (which age out of any window while the episode is still live).
  Three episode kinds stamp `episodeId` (thrash-breaker, all-hot,
  failure-streak), discriminated by the `episodeKind` field (§6.1, R3-m1);
  ONLY thrash-breaker rows carry `breakerOpenedAt`/`breakerDeadline`. At
  boot, the hydration (whose window includes the full backoff — see the
  read path above) re-derives from the MOST-RECENT row CARRYING
  `breakerDeadline` (equivalently: the most-recent `episodeKind:
  'thrash-breaker'` row) — NEVER from an all-hot or failure-streak row,
  whose `episodeId` must not anchor the breaker (R3-m1: a literal "most
  recent episodeId row of any kind" reading boots the breaker CLOSED early
  whenever the newest stamped row happens to be a failure-streak `failed`
  row or an all-hot `refused` row — the exact R2-M2 restart window,
  re-opened; the §12 anchor test pins this). If that row's
  `breakerDeadline` has not elapsed, the breaker boots OPEN with the
  ORIGINAL deadline. This works precisely when suppressed rows vastly
  outnumber increment rows (the normal shape of an open episode). **The
  open-marker row is NOT a new decision kind (R3-m2):** it is the increment
  row that crossed the trigger — the `refused` (reason `reversal`) row for
  a T1 same-session-inversion trigger, or the executed `swapped` row whose
  pair-level detection (T1) or frequency crossing (T2) tripped it — stamped
  with the episode fields (`episodeId`, `episodeKind`, `breakerOpenedAt`,
  `breakerDeadline`) at append time. The episode attention item is deduped
  on the ledger-persisted `episodeId`, so a reconstructed episode does NOT
  re-alert — the restart-heavy day that motivated §2.4 gets a breaker that
  holds, silently, exactly as if the process had lived.

With brakes (a)+(c) working, PAIR reversals (2-cycles) should be structurally
impossible — the breaker is the belt-and-suspenders detector that proves that
claim for 2-cycles and alarms if a future change reopens the hole (the same
role the guard-posture tripwire plays for config flips). The claim is
deliberately scoped: N≥3 rotations are NOT structurally impossible under
(a)+(c) — they are individually-justified hops — which is exactly why the
frequency detector above exists. The breaker's coverage is the union of the
three detectors (same-session inversion, pair-level inversion, per-session
frequency), not the first alone — a sentence the trigger arithmetic now
actually supports: the two inversion detectors ride T1, the frequency
detector rides T2 (round 3 proved that under a single-tier trigger this
sentence was an overclaim — the frequency detector could increment forever
without ever opening anything; R3-M2).

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
- **The same machinery serves the reactive fix-alongside (§3.1, R3-m5):**
  reactive execution failures write `failed` rows with `kind: 'reactive'`
  and feed their OWN per-session streak — kind-separated so a reactive
  streak never mixes with a proactive one, and detection-only on the
  reactive side (escalation, never backoff: I6 forbids skipping a reactive
  rescue; the streak only alerts).

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
        : 'absent'                                            // leg STRUCTURALLY unavailable, flagged
```

**State-name pin (R3-L1, direction DECIDED by R5-M1):** `absent` = the leg
is STRUCTURALLY unavailable (no `claudeSessionId` to probe against);
`indeterminate` = a probe was ATTEMPTED and failed. The two resolve
identically for decision purposes — BY DECISION, not by accident: R5-M1
found the round-5 body prescribing OPPOSITE directions for `absent` in two
places (this pin vs the exclusion rule three paragraphs down), and the
exclusion reading killed live subagents on id-less sessions blind — so the
direction is now decided once, here, per I7's own philosophy (a wrong busy
costs a delayed optimization; a wrong idle costs killed work): **an
`'absent'` subagent leg resolves exactly like `'indeterminate'` for every
caller class** — BUSY for optimization callers, busy-for-grace for reactive,
refusal-with-honest-summary for interactive refresh (§4.5). The two states
remain distinct in the ledger (`subagentLeg: 'ok'|'absent'|'indeterminate'`,
§6.1) so a chronic identity gap and a flaky probe are separately
measurable; a chronic-absence signal (the same session logging
`subagentLeg: 'absent'` across many ticks) is the named observability
follow-up `subagent-id-chronic-absence`.

**Uncertainty direction (I7, restated with the reactive-arm fix; the `||`
above is defined over the tri-state, R4-m3):**

- **Proactive/optimization callers:** a session is idle ONLY when **every
  leg affirmatively reports idle**; anything less than an affirmative idle —
  `'working'`, `'indeterminate'`, OR `'absent'` — on ANY leg resolves
  **busy** (fail toward not killing work). The mixed cases are decided
  explicitly: footer `indeterminate` + subagent confidently-false → BUSY — a
  possibly-mid-turn session is not killed just because tmux was flaky while
  the subagent registry was readable (the previous "both legs" wording
  permitted the inverse reading, which inverts I7's purpose exactly when
  tmux is flaky); footer idle + subagent `'absent'` → BUSY (R5-M1) — a
  session whose `claudeSessionId` is missing/stale (spawn-migration,
  transcript-recovery, and state-write-gap windows) can be running
  background subagents behind an idle prompt, which is EXACTLY the F3 blind
  spot this feature was built to protect, and the §4.3 enumeration is blind
  in the same state (it needs the same id) — so the kill would be both
  unprotected AND unenumerated; the footer leg must never decide it alone
  for an optimization. The pseudocode's `||` is therefore: resolve busy iff
  any leg ∈ {`'working'`, `'indeterminate'`, `'absent'`, active-true};
  resolve idle iff every leg ∈ {`'idle'`, active-false}. The cost of the
  decided direction, stated: an id-less session is proactively EXILED
  (defer → ceiling → drop, with re-intent backoff) until its
  `claudeSessionId` is restored — a missed optimization, bounded, and
  visible via the `subagentLeg: 'absent'` counters (the
  `subagent-id-chronic-absence` follow-up watches for the chronic case);
  never a blind kill. Deferrals caused purely by a non-affirmative leg
  carry reason `busy-indeterminate` (the row's `subagentLeg` field
  discriminates a structural gap from a failed probe — no new reason enum
  member) — a broken or unreadable detector is visible in the ledger rather
  than masquerading as real work.
- **Reactive callers:** `indeterminate` — and `'absent'`, per the same
  decided direction — resolves **busy-for-grace**: the session is treated as
  busy WITHIN the grace window (worst case: the swap waits the full
  `reactiveGraceMs`, 120 s). It does NOT resolve to not-busy:
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
re-intent backoff for `dwellMs` — FIXED to `dwellMs` in v1, deliberately not
an independent knob (R3-L3: a "(default)" that names no key implies a knob
that does not exist; if the soak shows dwell is the wrong scale for
re-intent pacing, adding `reIntentBackoffMs` later is purely additive) —
keyed on `(session)`, NOT on the
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
   of discovering half-finished worktrees by surprise. **When the enumeration
   itself is blind, the payload says so (R5-M1 honesty):** enumeration is
   keyed on `claudeSessionId` — when the id is absent at a FORCED kill
   (reactive-after-grace or `force` reaching an id-less session), the
   snapshot cannot run, and the payload states it plainly — *"subagent state
   was unreadable at kill time (no session id); background subagents may
   have been interrupted without enumeration — check for half-finished
   work"* — NEVER an implicit empty list. The ledger row carries
   `subagentLeg: 'absent'` with `killedSubagents`/`killedSubagentList`
   OMITTED (§6.1): "zero subagents" and "unreadable" are different facts and
   the row must never conflate them.
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
   in the prompt. **The neutralize+clamp discipline covers EVERY non-fixed
   field in the mitigation payload (R3-m4)** — including the killed-subagent
   list's `agentType` strings (host-constrained identifiers in practice —
   SubagentTracker records the Agent-tool type — but the rule is structural,
   never trust-by-provenance): any byte that is not part of the fixed
   template is delimiter-neutralized and length-clamped before rendering, so
   the "no unneutralized byte" sentence above holds for the whole payload,
   not just the sender-controlled subset. Clamps: mitigation block ≤ 2 000
   chars total; quoted inbound ≤ 1 000 chars (ellipsized); subagent list
   ≤ 10 entries then "+N more"; `agentType` ≤ 64 chars. Subagent
   `lastMessage` bodies are NOT included (transcript PATHS land in the
   ledger row only, never bodies — §6.1). **Framing rule, normative
   (R3-L4):** the quoted inbound is user CONTENT awaiting a conversational
   answer — the respawned session answers it AS a user message; it never
   gains operational-instruction priority over the session's standing
   instructions, and the fixed template states that framing explicitly
   ("a message from the quoted sender below awaits an answer" — an answer,
   not an order).

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
  resolved to the hyphenated form). When the subagent leg is `'absent'`
  (R5-M1 — the session has no readable `claudeSessionId`), the payload
  carries `subagentLeg: 'absent'` with `subagents` OMITTED — unreadable is
  never rendered as an empty list; the interactive caller sees honestly
  that it would be forcing over an UNKNOWN, and a `force` then pays the
  §4.3 unreadable-at-kill honesty line instead of a fabricated enumeration.
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
  episode externally. Eligibility INCLUDES the §3.3 validity gate (R4-M1):
  an unmeasured or stale-read alternate is not under the ceiling, so a
  quota-blind account can never stand the brake down.
- **I3 (dwell):** a session account-swapped at T is not proactively swapped
  again before T+`dwellMs`, across server restarts (ledger-backed).
- **I4 (no optimization kill of live work):** a proactive swap, model-swap, or
  interactive refresh never kills a session that the gate reports busy — it
  defers or refuses. Only reactive-after-grace and explicit `force` may, and
  then always with the §4.3 mitigation payload attached.
- **I5 (nothing silent):** every refused, deferred, dropped, invalidated,
  failed, suppressed, or proceeded-over-work decision writes one structured
  ledger row with its reason (per the §6.1 schema), and the counters are
  readable on the status route. Single named exception CLASS (R3-M3 as
  amended by R4-m1): decisions taken WHILE the ledger is unwritable cannot
  write rows — the writer is what died. Within the outage class: refusals
  (`ledger-lost`) are status-counted only; executed/proceeded decisions
  (reactive swaps, forced refreshes) additionally UPDATE the in-memory
  index (brakes stay primed) and are counted (`rowsLostWhileDown`); the
  durable trace for the whole class is the episode's one attention item
  PLUS the post-resume `outage-summary` row the first successful append
  writes (§3.5, R5-m3). Every decision outside an unwritable-ledger episode
  writes its row.
- **I6 (the guarantee is untouched):** the reactive swap path never waits more
  than `reactiveGraceMs` (+ one tick of scheduling), ignores dwell, reversal,
  the all-hot brake, and the thrash breaker, and with Piece 1 dry-run + Piece
  2 dark its decision behavior is byte-identical to v1.3.722.
- **I7 (uncertainty direction, per caller class):** for
  proactive/optimization callers a session is idle ONLY when every leg
  affirmatively reports idle — `'working'`, `'indeterminate'`, or
  `'absent'` on ANY leg resolves BUSY (protect work; the `'absent'`
  direction decided by R5-M1 — a structurally-unreadable subagent leg
  behaves like a failed probe, because the F3 blind spot AND the §4.3
  enumeration are blind in exactly that state); reactive callers resolve
  uncertainty (including `'absent'`) BUSY-FOR-GRACE (protect the mid-write
  without ever stranding — the grace deadline always proceeds);
  non-affirmative-leg deferrals are distinguishable in the ledger
  (`busy-indeterminate`, with `subagentLeg` discriminating gap from probe
  failure).
- **I8 (breaker is bounded, loud, and restart-proof):** the thrash breaker
  always half-opens after its backoff, opening it raises exactly one deduped
  attention item per `episodeId` (surviving restarts — the hydration window
  covers every detection window including the full backoff and the full
  frequency window, and the deadline is carried in-schema on thrash-breaker
  rows, §3.5/§3.2), and no permanent silent suppression state exists. The
  breaker is OPENABLE by every detector that feeds it (R3-M2): a
  single-session dwell-paced rotation opens it via T2 at the frequency
  threshold — the trigger arithmetic is satisfiable by the attack each
  detector exists to catch.
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
- **I12 (the optimizer never outlives its brakes):** while the swap ledger
  is unwritable, zero proactive swaps execute — every proactive intent
  refuses `ledger-lost`, resuming level-triggered on the first successful
  append (§3.5, R3-M3); the reactive guarantee is untouched (I6). Proactive
  optimization and its anti-thrash state are one unit: losing the second
  pauses the first, never the reverse.
- **I13 (the optimizer never outlives its measurements):** a proactive swap
  executes only between accounts with PRESENT, FRESH quota readings (§3.3
  bound 0, both legs, re-verified at execute time) — an absent or
  stale-beyond-bound reading can neither nominate a source nor qualify a
  target, and it counts toward all-hot. When the measurement layer is fully
  dark, proactive optimization is effectively paused AND SAYS SO — the
  `measurement-blind` trigger is evaluated per tick over the POOL ITSELF
  (zero fresh readings on any account), never over a candidate evaluation's
  alternate set, so whole-pool blindness fires the item even when stale
  sources mean no candidacy ever runs (R5-m1; `target-unmeasured` state
  rows additionally appear whenever candidates ARE evaluated); the reactive
  guarantee never depends on a reading (I6 — unknown stays selectable for
  rescue, byte-for-byte today's primitive).

## 6. Observability

### 6.1 The authoritative ledger-row schema (single source)

`state/swap-ledger.jsonl` — one JSON object per decision. Field × decision-kind
matrix (● = always, ○ = when applicable, — = never):

| field | type | swapped | refused | deferred | dropped | invalidated | failed | proceeded |
|---|---|---|---|---|---|---|---|---|
| `ts` | ISO-8601 | ● | ● | ● | ● | ● | ● | ● |
| `kind` | `'proactive'\|'reactive'\|'interactive'` | ● | ● | ● | ● | ● | ● | ● |
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
| `unmeasuredAlternates` | number | — | ○ (target-unmeasured) | — | — | — | — | — |
| `deferralAgeMs` | number | ○ (post-defer) | — | ● | ● | ○ | — | ○ |
| `deferCount` | number | ○ | — | ● (final row) | ● | ○ | — | ○ |
| `inFlight` | `{turn: boolean, subagents: number}` | ○ | ○ | ● | ● | ○ | — | ● |
| `subagentLeg` | `'ok'\|'absent'\|'indeterminate'` | ○ | ○ | ● | ● | ○ | — | ● |
| `killedSubagents` | number | — | — | — | — | — | — | ○ (OMITTED when `subagentLeg: 'absent'` — unreadable ≠ zero, R5-M1) |
| `killedSubagentList` | `[{agentType, ageMinutes, transcriptPath?}]` | — | — | — | — | — | — | ○ (same rule) |
| `inbound` | `'reinjected'\|'none'\|'unknown'` | — | — | — | — | — | — | ● |
| `force` / `authLevel` | boolean / `'bearer'` | — | — | — | — | — | — | ○ |
| `defaultAccountChanged` | boolean | ○ (reactive untagged) | — | — | — | — | — | ○ |
| `episodeId` | string | ○ (breaker) | ○ (breaker/all-hot/measurement-blind) | ○ | ○ | ○ | ○ (failure streak) | ○ |
| `episodeKind` | `'thrash-breaker'\|'all-hot'\|'failure-streak'\|'measurement-blind'` | ○ (with episodeId) | ○ (with episodeId) | ○ | ○ | ○ | ○ (failure streak) | ○ |
| `breakerOpenedAt` / `breakerDeadline` | ISO-8601 / ISO-8601 | ○ (thrash-breaker only) | ○ (thrash-breaker only) | ○ (thrash-breaker only) | ○ (thrash-breaker only) | ○ (thrash-breaker only) | — | ○ (thrash-breaker only) |
| `triggerSignature` | `{tier: 'T1'\|'T2', session?, pair?}` | ○ (thrash-breaker open marker) | ○ (thrash-breaker open/close rows) | — | — | — | — | — |
| `transition` | `'enter'\|'leave'\|'heartbeat'` | — | ○ (all-hot / thrash-breaker / target-unmeasured) | — | — | — | — | — |
| `errorClass` | string (constructor-name/enum ONLY — §3.6) | — | — | — | — | — | ● | — |

**`kind` mirrors the caller's lane (R6-m1 — the third member is the §4.5
rows' home):** `proactive` for `proactive-swap` decisions, `reactive` for
`reactive-swap`, `interactive` for the interactive-refresh work-gate rows
(the 409 `session-busy` refusal and the `force`-proceeded row — the rows
whose `force`/`authLevel` fields exist). `recovery`-class refreshes write no
rows at all (§3.5); no fourth member exists. The §3.6 failure-streak
kind-separation continues to read only `proactive`/`reactive` — an
interactive row never joins a streak.

**Episode-field pairing rule (R3-m1):** `episodeId` and `episodeKind` travel
together — every episodeId-stamped row carries the kind, and
`breakerOpenedAt`/`breakerDeadline` appear on a row **iff** `episodeKind:
'thrash-breaker'`. The §3.5 boot derivation anchors ONLY on rows carrying
`breakerDeadline`; an all-hot or failure-streak row can never anchor (or
close) the breaker. `triggerSignature` (R5-m2) rides the thrash-breaker
episode's open-marker and CLOSE (suppression `leave`) rows so continuation
memory re-derives across restarts (§3.5); the signature's `session`/`pair`
members are the same identifiers the rows already carry — no new data class.

**One row kind lives OUTSIDE the decision matrix (R5-m3):** `decision:
'outage-summary'` — written exactly once by the level-triggered resume's
first successful append after an unwritable-ledger episode, carrying `{ts,
machineId, rowsLostWhileDown, ledgerLostRefusals, outageStartTs,
outageEndTs}`. It stamps NO session/account fields, carries no
`breakerDeadline` (it can never anchor or close the breaker), and exists so
a mid-window row gap is durable and boot-visible: hydration finding one
inside its window flags `hydration: 'under-primed'` with the gap named
(§3.5 carve-out 1b).

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
  proceeded | outage-summary` (`proceeded` = proceeded over busy with
  mitigations — reactive after grace, or force; its `reason` carries the
  busy-state observed at kill time: the `busy-*` member that was live when
  the grace deadline or force fired. `outage-summary` = the one
  self-describing post-outage marker row, §6.1 — never a swap decision).
- `reason`: `all-hot | dwell | no-material-target | target-unmeasured |
  reversal | thrash-breaker | target-revalidation-failed | busy-turn |
  busy-subagents | busy-indeterminate | deferral-ceiling-dropped |
  intent-stale | session-busy | swap-exec-failed | ledger-lost` (one
  spelling — `session-busy` is also the §4.5 wire code; `ledger-lost` is the
  one reason that appears ONLY in status counters and log lines, never in a
  ledger row — §3.5/I5).
- `episodeKind`: `thrash-breaker | all-hot | failure-streak |
  measurement-blind` (paired with `episodeId` on every stamped row — §6.1).
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
  thrash: {reversalsDetected, pairLevelDetections, frequencyCrossings,
  breakerState, breakerOpenedAt, episodes: [{episodeId, episodeKind,
  openedAt, expiresAt}]},
  execFailures: {bySession, streaks}, deferrals: {active, byReason, dropped,
  invalidated, proceededWithMitigations}, hydration:
  'complete'|'under-primed', corruptLinesSkipped, ledger: {writable,
  lostSince?, ledgerLostRefusals, rowsLostWhileDown}, quotaValidity:
  {freshnessMs, unmeasuredAccounts, staleAccounts}}` — the **thrash-detected
  counter** the operator asks for lives here, and the `ledger` block is the
  in-memory home of the `ledger-lost` accounting the ledger itself cannot
  hold (§3.5, R3-M3). All fields are LOCAL-SCOPE
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
- Attention items: ONE per thrash episode (deduped on `episodeId`, §3.5,
  episode continuations included across BOTH trigger tiers, R4-m2 — a
  sustained rotation or inversion pathology is one item, not an hourly
  drip); ONE per execution-failure streak (§3.6, kinds separated); ONE per
  measurement-blind episode (§3.3 bound 0 — the POOL-LEVEL zero-fresh-readings
  condition sustained past `allHotHeartbeatMs`, candidacy-independent,
  R5-m1); ONE if the ledger is
  unwritable — and that item now reports
  BOTH the observability loss AND that proactive optimization is paused
  until writes recover (§3.5, R3-M3), because ledger loss is no longer a
  continue-cold condition.

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
        "thrashBreakerThreshold": 2,      // T1: inversion-class increments within reversalWindowMs (§3.5)
        "thrashBreakerBackoffMs": 3600000,
        "swapFrequencyThreshold": 3,      // rotation detector: N proactive executions…
        "swapFrequencyWindowMs": 10800000, // …of one session within 3 h — the crossing OPENS the breaker (T2, §3.5)
        // retention + hydration bound = max(dwellMs, reversalWindowMs,
        // thrashBreakerBackoffMs, swapFrequencyWindowMs,
        // thrashBreakerBackoffMs + max(reversalWindowMs, swapFrequencyWindowMs))
        // — §3.2 (R3-M1; continuation term R5-m2); not a knob: derived, so
        // no window (detection OR continuation) can outrun its own state
        "allHotHeartbeatMs": 1800000,     // all-hot/breaker heartbeat row cadence
        "reactiveHopAlertThreshold": 2,   // reactive hops per session per reversalWindowMs → ONE alert
        "quotaFreshnessMs": 1800000       // §3.3 bound 0: a reading older than this is
                                          // not a measurement (default 2× the poller's
                                          // 15-min cadence); absent/stale ⇒ not a
                                          // proactive source OR target (R4-M1)
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

**Cross-knob coherence warnings (R4-L2 — config-load, warn-only, never a
startup error):** two knob combinations silently defang a detector and get
one boot-log warning each: (1) `dwellMs > swapFrequencyWindowMs /
(swapFrequencyThreshold − 1)` (> 90 min at defaults) disarms T2 — three
dwell-paced hops can no longer fit the frequency window (higher dwell also
means less churn, so the residual is small; the warning keeps a
conservative-looking retune from killing a detector unnoticed); (2)
`quotaFreshnessMs < ` the quota poller's `pollIntervalMs` makes every reading
stale between polls — proactive optimization degrades toward permanent
refusal (the SAFE direction, but almost certainly a misconfiguration worth a
line).

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
   config, manufacture reversal activity to the T1 threshold (2
   inversion-class increments inside `reversalWindowMs`): the breaker opens,
   raises ONE attention item, suppresses proactive swaps for the backoff,
   half-opens on schedule — and a mid-backoff server restart boots the breaker
   OPEN with the original deadline and does NOT re-alert (I8). (The T2 arm —
   a dwell-paced rotation opening the breaker at the frequency crossing — is
   proven at the unit tier, §12; its timeline is 90+ min by construction.)

## 12. Testing Integrity (three tiers — NON-NEGOTIABLE house standard)

- **Unit (`tests/unit/`):** both sides of EVERY brake boundary — all-hot at
  ceiling−1/at-ceiling; dwell at T+dwellMs−1/+1 (including ledger-hydrated
  dwell after a simulated restart); improvement bounds at exactly-15/14.9;
  reversal window edges; same-session refusal vs pair-level detection-only;
  **the rotation-frequency detector, re-derived from the corrected
  arithmetic (R3-M1/R3-M2):** single session, executions A→B / B→C / C→A at
  t=0 / 45 m / 90 m (the dwell floor) — the per-session count reaches 3 at
  t=90 m (retention ⊇ the 3 h window per §3.2) and the crossing opens the
  breaker DIRECTLY via T2, with the 4th hop (t=135 m) suppressed
  `thrash-breaker`; the same rotation with a restart between the 2nd and
  3rd executions still opens (hydrated count re-primes); threshold−1 (two
  executions in the window) must NOT fire; a once-per-wave legitimate
  session (executions ≥2.5 h apart — at most 2 inside any 3 h window) must
  NOT fire; one frequency crossing with NO other increment within
  `reversalWindowMs` still opens (the T1-starvation regression case pinned
  — a builder who routes T2 through T1's 30-min aggregation fails this
  test); a T1 pair (2 inversion-class increments inside 30 m) still opens;
  frequency-episode CONTINUATION (same session re-crosses within the
  window → same episodeId, extended deadline, NO second attention item);
  **retention-bound formula (R3-M1):** an execution `swapFrequencyWindowMs
  − ε` old still counts toward the frequency threshold, one older is
  pruned — pinned against both the in-memory prune and the boot hydration;
  breaker open→half-open timing + restart re-derivation (episodeId dedupe,
  deadline carried in-row, restart in the SECOND half of the backoff boots
  OPEN — the R2-M2 regression case pinned; failure-streak backoff also
  re-derived); **boot-derivation anchoring (R3-m1):** a failure-streak
  `failed` row or all-hot `refused` row NEWER than the open thrash-breaker
  episode's rows must NOT close (or re-anchor) the breaker at boot — the
  derivation reads only rows carrying `breakerDeadline`;
  **execute-time source revalidation (R3-m3):** a reactive swap completing
  between the pipeline pass and the execute call invalidates the intent
  (`intent-stale`) — never a second kill on the just-rescued session;
  **ledger-lost pause (R3-M3):** an append failure ⇒ the next proactive
  intents refuse `ledger-lost` with zero executions while reactive
  proceeds untouched; the first successful append resumes proactive
  (level-triggered, no restart); status `ledger` block reflects
  writable/lostSince/refusal count; corrupt-but-writable boots cold and
  does NOT pause; hydration segment-walk (window spanning active + both
  rotated segments; under-primed flag when retention cannot cover the
  window; corrupt trailing line skipped + counted);
  the full I7 uncertainty×caller matrix (proactive/reactive/recovery ×
  working/idle/indeterminate × subagent-leg present/absent); filter→score→
  verify order (a hot target must be unreachable even when scoring prefers
  it); intra-tick per-target cap; deferral full-pipeline re-run (stale-wave,
  breaker-mid-wait, account-changed→invalidated); defer dedupe
  (first/final/count); ceiling-drop→re-intent backoff; execution-failure
  backoff + streak escalation; ledger hydration including the
  newest-rotated-segment case; schema round-trip for every decision kind
  (episodeKind/breakerDeadline pairing rule included); mitigation payload
  clamps + delimiter neutralization covering EVERY non-fixed field —
  including a hostile `agentType` string (R3-m4);
  **quota-validity gate (R4-M1) — both sides of every boundary:** a target
  with `lastQuota: null` is NOT eligible (excluded from the filter, counts
  toward all-hot) even though `bindingUtilization` returns 0 for it — the
  quota-blind pile-on attack pinned; a reading at `quotaFreshnessMs − ε` is
  eligible, at `+ε` is not; a STALE-hot source (frozen ≥ threshold) is never
  a proactive candidate; the refusal reason resolves `target-unmeasured`
  (with `unmeasuredAlternates ≥ 1`) the moment ANY alternate lacked a valid
  reading — INCLUDING the mixed pool where the others are validly hot AND
  the all-stale-frozen-hot pool (the R5-L2 misreading pinned out) — and
  `all-hot` only when every alternate carried a valid hot reading; the
  R6-L2 scope guard pinned from the other side: a mixed pool holding ONE
  valid under-ceiling target alongside unmeasured alternates is NOT
  refused — it proceeds to scoring and can execute (the empty-filter
  classification never fires while an eligible target survives);
  enrollment-day flip: an account enrolled mid-run is refused as a target
  until its first poll lands, then becomes eligible on the next tick (no
  permanent exile); REACTIVE selection with an unmeasured account stays
  byte-identical (unknown still selectable — I6); sustained
  measurement-blindness raises exactly ONE `measurement-blind` attention
  item (episode-deduped) — **and the trigger is pinned POOL-LEVEL (R5-m1):
  with EVERY reading stale (sources included, so zero candidate
  evaluations run and zero `target-unmeasured` rows are written), the item
  still fires after `allHotHeartbeatMs`; the same condition with the
  background poller loop never started (post-boot-populated pool) also
  fires** — a candidacy-scoped builder fails both; **execute-time full-materiality revalidation
  (R4-m4):** source pressure subsiding in the sub-tick window ⇒
  `intent-stale`, improvement delta collapsing ⇒
  `target-revalidation-failed`, target reading going stale ⇒
  `target-revalidation-failed` — each pinned at the execute call, not the
  pipeline pass; **mixed-leg I7 matrix (R4-m3, direction corrected by
  R5-M1):** footer `indeterminate` + subagent confidently-false resolves
  BUSY for proactive callers (the unsafe both-legs reading pinned out),
  footer idle + subagent `indeterminate` resolves BUSY, footer idle +
  subagent `'absent'` resolves BUSY for proactive callers (the id-less
  kill path pinned CLOSED — a builder resolving it by the footer leg alone
  fails this test), busy-for-grace for reactive, and 409 for
  interactive-refresh with `subagentLeg: 'absent'` + `subagents` omitted
  in the payload; a FORCED kill with the leg absent renders the §4.3
  unreadable-honesty line and omits `killedSubagents` from the row (never
  an implicit empty list); **T1 episode continuation (R4-m2):** a sustained
  inversion thrash re-opening within `reversalWindowMs` of the previous
  episode's close on the SAME account pair joins that episode (same
  episodeId, extended deadline, NO second item — the hourly-drip regression
  pinned); a different pair mints a new episode; the continuation row's new
  `breakerDeadline` anchors the boot derivation; **restart-proof
  continuation memory (R5-m2):** a server restart INSIDE the continuation
  window (episode closed pre-restart, re-cross post-restart, same
  signature) re-derives continuation from the signature-carrying close row
  and JOINS the episode (same episodeId, NO second item — the
  restart×sustained-pathology re-alert pinned out); a close row at
  `retentionBoundMs − ε` is still hydrated (the continuation term of the
  §3.2 formula pinned: a builder shipping the old 4-term max fails this
  test); same-signature lookup pinned (R5-L3: an interleaved
  different-signature episode does not break the match); the
  down-across-the-deadline case pinned (R6-m3: breaker opens, server
  stops BEFORE the backoff elapses, boots after the deadline but inside
  the continuation window — no close row exists; hydration synthesizes
  the close at `breakerDeadline` from the open-marker row and the next
  same-signature crossing JOINS the episode, no second item, nothing
  written at boot); **ledger-outage
  index priming (R4-m1):** a reactive swap executed while the ledger is
  unwritable primes dwell in the in-memory index (the post-resume first
  tick refuses `dwell` for that session) and increments `rowsLostWhileDown`;
  **outage-summary breadcrumb (R5-m3):** the first successful append after
  an unwritable episode writes exactly ONE `outage-summary` row (span +
  counts, no session/account fields); a boot hydrating over that row flags
  `under-primed` with the gap named; the row can never anchor the breaker
  derivation (no `breakerDeadline`);
  **cross-knob warnings (R4-L2):** each of the two §7 combinations logs
  exactly one boot warning; **unconditional hydration (R4-L3):** the ledger
  hydrates with `antiThrash` disabled and the index is warm at a mid-run
  flag flip.
- **Integration (`tests/integration/`):** `/subscription-pool/proactive-swap`
  additive `brakes`/`deferrals`/`hydration`/`ledger` fields; `/sessions/refresh` 409
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
| `claudeSessionId` missing on the state record | subagent leg `'absent'` resolves like a failed probe (R5-M1): optimization callers → BUSY (defer→ceiling→drop — the id-less session is proactively exiled, a bounded missed optimization, never a blind kill); interactive refresh → 409 with an honest `subagentLeg:'absent'` summary (`force` pays the §4.3 unreadable-honesty line); reactive → busy-for-grace then proceeds with the same honesty line (rescue never strands). Ledger rows flag `subagentLeg:'absent'` so a chronic identity gap is measurable (`subagent-id-chronic-absence` follow-up) |
| Swap ledger UNWRITABLE at runtime | proactive optimization PAUSES — every proactive intent refused `ledger-lost` (status-counted; rows unwritable by definition), ONE attention item naming both the loss and the pause; level-triggered resume on the first successful append; reactive untouched (I6) — the optimizer is never live while its brakes are cold (§3.5, I12, R3-M3). Non-refusal decisions during the outage (reactive swaps, forced proceeds) prime the in-memory index despite the failed append and count as `rowsLostWhileDown` (R4-m1) — dwell/frequency stay warm until the next restart. On resume, the first successful append writes ONE `outage-summary` row (R5-m3) so the gap is durable and boot-visible; an outage×restart conjunction still permits one gate-protected premature proactive swap per rescued session — the accepted bounded-cold class, closable via the named optional post-outage boot grace |
| Swap ledger corrupt/absent at boot (writable) | hydrates cold/under-primed (flagged), ONE log flag; optimization continues — new rows land immediately and every brake re-primes within its own window (bounded self-heal, §9) — the pause is scoped to the unbounded-cold UNWRITABLE case only |
| Swap execution throws | `failed` row + per-session exponential backoff (cap dwellMs); 3 consecutive → ONE deduped attention item (§3.6) — never a silent every-tick retry |
| Thrash breaker wedges open | impossible by construction (time-based half-open, no external latch); state re-derived identically across restarts; posture visible on `/guards` |
| Deferral records accumulate | per-session keyed map, entries die at execute/drop/ceiling/invalidate; hard cap = live session count; ledger rows deduped first/final/count |
| Defer→drop→regenerate loop | re-intent backoff per SESSION after a ceiling drop (default dwellMs; target rotation cannot evade a session key) — bounded churn, re-derived from `dropped` rows across restarts (§4.2) |
| N≥3 rotation (A→B→C→A) | pair detectors blind by design; the per-session frequency detector counts 3 executions / 3 h (retention ⊇ the window, §3.2) and its crossing OPENS the breaker directly (T2, §3.5) — worst case exactly `swapFrequencyThreshold` hops before suppression, restart-proof, sustained rotation deduped to ONE episode |
| Reactive hop-chain in an all-hot pool | never refused (I6); capped by the refresh rate counter; ONE deduped escalation per episode at the hop threshold or on a rate-cap refusal (§3.1) |
| Restart inside the second half of a breaker backoff | hydration window covers the FULL backoff; deadline carried in-row; breaker boots OPEN with the original deadline (§3.5, R2-M2) |
| Ledger segment rotated inside the window | segment-walk reads newest-first across retained segments; if retention cannot cover the window the boot flags `under-primed` — never a silent cold index (§3.5) |
| QuotaPoller lag within one poll interval | execute-time revalidation (§3.3) uses the freshest snapshot and refuses on ceiling breach; bound 1's 15-point headroom budgets exactly this lag — **bounded** poll-lag fails toward NOT swapping (proactive). This row's claim is deliberately scoped to bounded lag (R4-M1 corrected the old row, which overclaimed the safe direction for ALL staleness) |
| Quota reading ABSENT (fresh enrollment; never polled) | proactive-ineligible on BOTH legs (§3.3 bound 0): never a source (measures 0 < threshold — code behavior, now normative), never a target (fails the validity gate; counts toward all-hot; refusal `target-unmeasured`). Self-heals within ≤1 poll interval — `pollAll` covers every non-disabled account and the monitor's `triggerPoll` accelerates it under pressure; reactive may still select it (I6, rescue-selectability preserved) |
| Quota reading STALE beyond `quotaFreshnessMs` (poller broken, seat auth dead, parse failure) | excluded from proactive source AND target roles even when the frozen value looks cool/hot; sustained whole-pool blindness = proactive effectively paused + ONE `measurement-blind` attention item raised on the POOL-LEVEL trigger (I13, R5-m1 — it fires even when stale sources mean zero candidate evaluations run and zero `target-unmeasured` rows are written) — never a silent optimizer running on fiction, and never a silently-paused one either; reactive untouched |
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

## 17. Round-3 findings disposition

Every round-3 finding (report: `docs/specs/reports/
swap-continuity-antithrash-round3-findings.md`, reviewed commit 07b46b3f2) and
what this revision did with it. Zero rejected. The three MAJORs are arithmetic
and fail-direction corrections WITHIN the round-3 structure — the detection
design's shape is unchanged, its numbers now connect: retention/hydration ⊇
every detection window (one derived formula, not two hand-maintained maxes),
the breaker trigger is satisfiable by each attack its detectors exist to
catch (two tiers instead of one aggregation window that the dwell floor
mathematically defeats), and the ledger-loss fail direction is decided by the
spec's own §10 principle instead of left as an undecided failure-mode row. No
§0 property was weakened — (b)'s dwell and the reactive guarantee (I6) are
untouched on every changed path.

| finding | disposition | where |
|---|---|---|
| R3-M1 (frequency detector starved by the spec's own state bounds) | Adopted — ONE formula `retentionBoundMs = max(dwellMs, reversalWindowMs, thrashBreakerBackoffMs, swapFrequencyWindowMs)` (3 h at defaults) governs BOTH the in-memory prune and boot hydration; cost stated (≤4 executed-swap entries per session — bytes, not scans; boot read still capped by keepSegments=2, the window does not raise it); under-primed flag covers retention shortfall (folds external #8); §12 retention-bound test pins the formula | §3.2, §3.5, §7, §12 |
| R3-M2 (single-session rotation can never open the breaker; §12 rotation test unimplementable) | Adopted — fix (a) of the report, stated normatively: two trigger tiers — T1 aggregates inversion-class increments within `reversalWindowMs` (prompt by nature); a frequency-threshold crossing opens the breaker DIRECTLY (T2 — the crossing IS the episode trigger; one session's frequency increments are ≥dwellMs apart by construction, so no 30-min aggregation can ever pair them). Rotation scenario re-derived in-text (3 hops at t=0/45/90 m → opens at t=90 m, 4th hop suppressed, restart-proof); sustained rotation deduped via episode continuation (P17); §12 rotation test re-derived from the corrected arithmetic incl. the T1-starvation regression case | §3.5, I8, §12, §13 |
| R3-M3 (ledger loss runs the optimizer with every ledger-derived brake cold) | Adopted — fail direction DECIDED per §10's own principle: an UNWRITABLE ledger PAUSES proactive optimization (refusal `ledger-lost`, level-triggered resume on first successful append, honors dryRun); reactive untouched (I6); new invariant I12; I5's single named exception stated (ledger-lost refusals are status-counted — the writer is what died); corrupt-but-writable stays bounded cold-start (the pause is scoped to the unbounded-cold case) | §3.5, I5, I12, §6.2, §6.3, §6.4, §12, §13 |
| R3-m1 (episodeId overloaded across three episode kinds; boot derivation can anchor on the wrong kind) | Adopted — BOTH suggested fixes: `episodeKind` discriminator added to §6.1 with a pairing rule (`breakerOpenedAt`/`breakerDeadline` iff `thrash-breaker`), AND the boot derivation scoped to rows CARRYING `breakerDeadline`; §12 anchor test pins that a newer failure-streak/all-hot row can never close a live breaker | §3.5, §6.1, §6.2, §12 |
| R3-m2 (open-marker row has no decision kind in the enum) | Adopted — the open marker IS the increment row that crossed the trigger (the `refused`-reversal row for T1 same-session; the executed `swapped` row for pair-level/T2), stamped with the episode fields at append time; no new kind invented | §3.5 |
| R3-m3 (sub-tick source-account race: reactive completes between pipeline pass and execute) | Adopted — execute-time revalidation covers the SOURCE: current account must equal `intent.from`, else `invalidated`/`intent-stale` — never a second kill on a just-rescued session; §12 test added | §3.3, §12 |
| R3-m4 (`agentType` outside the §4.3(3) neutralization rule) | Adopted — the neutralize+clamp discipline extended to EVERY non-fixed field in the mitigation payload (subagent list included, `agentType` ≤64); the "no unneutralized byte" sentence now holds payload-wide, not just for the sender-controlled subset | §4.3(3), §12 |
| R3-m5 (reactive execution failures wired to the wrong trigger's escalation) | Adopted — the channel is NAMED: reactive `failed` rows ride the §3.6 streak machinery, kind-separated (`kind: 'reactive'`), escalation-only on the reactive side (no backoff — I6 forbids skipping a rescue); trigger (2) remains the rate-cap-refusal path only | §3.1, §3.6 |
| R3-L1 (busy() pseudocode maps missing claudeSessionId to 'indeterminate') | Adopted — pseudocode fixed to `'absent'`; state-name pin added (absent = structurally unavailable; indeterminate = probe attempted and failed; identical I7 resolution, separately measurable) | §4.1 |
| R3-L2 (§3.1 mechanism wording — the discarded seam) | Adopted — corrected to the rate-limit listener discarding the whole `onQuotaPressure` RESULT promise; `refreshFn`'s false folds into that discard | §3.1 |
| R3-L3 (re-intent backoff "(default)" implies an unnamed knob) | Adopted — FIXED to `dwellMs` in v1, stated; `reIntentBackoffMs` named as the purely-additive later knob if the soak shows dwell is the wrong scale | §4.2 |
| R3-L4 ("answer it first" framing priority) | Adopted — normative framing rule: the quoted inbound is user CONTENT answered as a user message, never operational-instruction priority; the fixed template states it | §4.3(3) |

## 18. Round-4 findings disposition

Every round-4 finding (report: `docs/specs/reports/
swap-continuity-antithrash-round4-findings.md`, reviewed commit e4c5f4a48) and
what this revision did with it. Zero rejected. The single MAJOR is the
measurement-trust correction the round-4 report predicted: every brake was
defined on `bindingUtilization`, whose real primitive treats "no reading" as
0 — the fix (bound 0, a presence+freshness validity gate on the proactive
filter, both legs) is shape-preserving and reactive-untouched (I6), with the
enrollment-day self-heal argued from the poller's real cadence + the
monitor's existing `triggerPoll` hook. No §0 property was weakened; (a) and
(c) now hold on MEASUREMENTS, not on the absence of one.

| finding | disposition | where |
|---|---|---|
| R4-M1 (absent/unboundedly-stale quota reading fails toward MORE swapping — properties (a)/(c) vacuous when the measurement layer is blind; corroborated by the GPT-tier external) | Adopted — bound 0: proactive target eligibility requires a reading PRESENT and fresher than `quotaFreshnessMs` (default 30 min = 2× the poller's 15-min cadence); absent/stale is NOT under the ceiling and counts toward all-hot; refusal `target-unmeasured` (state-transition rows) distinguishes measurement outage from genuine heat; the SOURCE leg carries the same validity (stale-hot never nominates a kill; absent-0 stated as normative); execute-time revalidation re-checks bound 0; REACTIVE deliberately untouched (I6 — unknown-selectable is rescue's feature); enrollment-day self-heal ≤1 poll interval (pollAll covers all accounts; `triggerPoll` accelerates under pressure) — no permanent exile of a healthy new account; sustained whole-pool blindness raises ONE `measurement-blind` item (I13); §13's stale-data row corrected to scope its claim to bounded poll-lag | §3.1, §3.3, I2, I13, §6.1–§6.4, §7, §12, §13 |
| R4-m1 (I5's "single named exception" inaccurate during an unwritable-ledger episode; in-memory index behavior on failed append unspecified) | Adopted — non-refusal decisions during the outage UPDATE the in-memory index regardless of append failure (dwell/frequency/reversal stay primed; the post-resume premature-re-swap case closed) and are counted (`rowsLostWhileDown`, §6.3 ledger block); I5's exception re-worded as the outage CLASS (refusals counter-only; executed/proceeded index-primed + counted; durable trace = the episode's one item) | §3.5, I5, §6.3, §12, §13 |
| R4-m2 (episode continuation defined only for T2/same-session; sustained T1 thrash re-alerts hourly; half-open only implicit) | Adopted — continuation generalized over both tiers by trigger signature (T2: same session within `swapFrequencyWindowMs` of close; T1: same unordered account pair within `reversalWindowMs` of close): same episodeId, extended deadline (the continuation row's new `breakerDeadline` keeps the boot anchor correct), no second item; half-open pinned = closed-with-continuation-memory (no third persisted state) | §3.5, §6.4, §12 |
| R4-m3 (I7 "indeterminate on BOTH legs" ambiguous for the mixed case; `\|\|` undefined over tri-states) | Adopted — normative any-leg rule for proactive callers: idle ONLY when every READABLE leg affirmatively reports idle; `'working'`/`'indeterminate'` on ANY leg ⇒ busy; `'absent'` excluded per the R3-L1 pin (remaining leg decides); the mixed case (footer indeterminate + subagent false ⇒ BUSY) decided in-text; the pseudocode's `\|\|` defined over the tri-state; I7 restated to match. **[Historical record — the `'absent'`-excluded arm of this fold is SUPERSEDED: it contradicted the R3-L1 pin (R5-M1) and was re-decided in round 6 — `absent` now resolves like `indeterminate` for every caller class (§4.1, §19). Do not build from this row.]** | §4.1, I7, §12 |
| R4-m4 (execute-time revalidation re-checks target ceiling + source identity but not fresh source-pressure or the improvement delta) | Adopted — the revalidation checklist is enumerated (target validity+ceiling / source identity / source pressure fresh / improvement delta fresh) with refusal reasons per arm (`target-revalidation-failed` / `intent-stale`); property (c) verified at the actual kill point on the snapshot the revalidation already holds | §3.3, §12 |
| R4-L1 (sub-threshold rotation pacing band unnamed) | Adopted — the ~90-min evasion band named in §3.5 with the soak-interpretation note (each such hop still passes (a)+(c)+dwell individually) | §3.5 |
| R4-L2 (no cross-knob coherence constraint; raising dwellMs can silently disarm T2) | Adopted — two warn-only config-load checks: dwell-vs-frequency-window disarms T2; `quotaFreshnessMs` below the poll cadence degrades toward permanent refusal (safe, but flagged) | §7, §12 |
| R4-L3 (hydration behavior when antiThrash boots disabled unstated) | Adopted — the ledger module loads + hydrates unconditionally at boot; reactive rows append regardless; the index is warm at a mid-run flag flip (the §7.1 half-enable trap closed for this key) | §3.5, §12 |
| R4-L4 (`target-revalidation-failed` refusals lack volume treatment) | Adopted (accepted-bound arm of the finding's either/or) — the worst case is stated (~20 rows/h/session, ceiling-flip-flop, self-limiting via the next tick's own filter); extending the state-transition scheme named as the purely-additive later change if a soak shows sustained volume | §3.3 |

## 19. Round-5 findings disposition

Every round-5 finding (report: `docs/specs/reports/
swap-continuity-antithrash-round5-findings.md`, reviewed commit 2bcf4ed09) and
what this revision did with it. Zero rejected. The single MAJOR was a
fold-regression, not a design hole: applying round-4's own prescribed R4-m3
fix made a pre-existing adjacent pin sentence false, leaving the `absent`
subagent-leg direction contradicted in-body — resolved by DECIDING the
direction (absent behaves like a failed probe for every caller class) rather
than picking whichever sentence was written last. No §0 property was
weakened; (d) now holds for id-less sessions too (the last pending arm of the
round-5 report's property table).

| finding | disposition | where |
|---|---|---|
| R5-M1 (`absent` subagent-leg direction contradicted in-body — §4.1 pin vs exclusion rule; the exclusion reading kills live subagents on id-less sessions blind, AND the §4.3 enumeration is blind in the same state, so the kill is unprotected + unenumerated; from GPT-tier #1, re-grounded internally) | Adopted — the direction is DECIDED once, at the pin (per I7's own philosophy): `'absent'` resolves exactly like `'indeterminate'` for every caller class — BUSY for optimization callers (defer→ceiling→drop; the id-less session is proactively exiled — a bounded, counter-visible missed optimization, `subagent-id-chronic-absence` named as the chronic-case follow-up), busy-for-grace for reactive, honest 409 (`subagentLeg:'absent'`, `subagents` omitted) for interactive refresh; the pin sentence rewritten to carry the decision (identical resolution is now normative, not accidental); §4.3 gains the mitigation-blindness honesty line (a forced kill with the id absent says "subagent state unreadable at kill time" and OMITS `killedSubagents` — never an implicit empty list); I7 restated; §12 matrix + §13 row corrected | §4.1, §4.3(1), §4.5, I7, §6.1, §12, §13 |
| R5-m1 (measurement-blind surfacing candidacy-dependent — whole-pool blindness, the loudest case, is silent because stale sources kill candidacy before any evaluation observes the exclusion; poller boot-gating compounds it; internal fail-direction lens + GPT-tier #4) | Adopted — the trigger is POOL-LEVEL, evaluated per monitor tick over the pool itself (zero accounts carry a fresh reading, `proactiveSwap` enabled), independent of candidacy; reads snapshots directly, never assumes the poller loop runs (the boot-gated `start()` wiring note carried into the §12 build audit); episode dedupe kept; I13 + §6.4 + §13 wording corrected | §3.3, I13, §6.4, §12, §13 |
| R5-m2 (episode CONTINUATION memory not restart-proof — the close is outside the old retention/derivation reach, so a restart inside the continuation window re-alerts once for a sustained pathology; from GPT-tier #2, calibrated MAJOR→MINOR: alert hygiene only, every brake property holds) | Adopted — the close (suppression `leave`) row carries the episode's `triggerSignature` (new §6.1 field); the §3.2 one-formula retention/hydration bound gains the continuation term `thrashBreakerBackoffMs + max(reversalWindowMs, swapFrequencyWindowMs)` (= 4 h at defaults; the max() absorbs it — no hand-tuned second bound); boot hydration re-derives continuation memory from the most-recent same-signature close row; §12 tests pin the restart-join, the retention term, and the same-signature lookup | §3.2, §3.5, §6.1, §7, §12 |
| R5-m3 (outage+restart conjunction re-opens a bounded premature-re-swap window, and the "boot flags UNDER-PRIMED as usual" claim was FALSE — a safe-direction overclaim; GPT-tier #3 + gemini #1, both rated MAJOR; calibrated MINOR on the record with the bounded-cold rationale — one gate-protected swap per session per conjunction, §9's accepted class) | Adopted — the false clause is REPLACED by the honest bound (stated in-body with the calibration visible); the level-triggered resume's first successful append writes ONE durable `outage-summary` row (new §6.2 decision member; span + counts, no session/account fields, never anchors the breaker) making the gap boot-visible + soak-auditable (hydration over it flags `under-primed` with the gap named); the optional post-outage boot grace (dwell-covered for one `dwellMs` after a young outage-summary row) is NAMED for the builder, not mandated; I5's durable-trace sentence updated | §3.5(1b), I5, §6.1, §6.2, §12, §13 |
| R5-L1 (freshness-boundary flapping emits `target-unmeasured` enter/leave pairs per tick on a partially-degraded poller) | Adopted (named-bound arm) — the flap is named in §3.3 with its bound (≤2 rows/candidate/tick, the R4-L4 volume class; `triggerPoll` keeps it transient); `freshness-hysteresis` named as the purely-additive refinement | §3.3 |
| R5-L2 ("excluded by the validity gate ALONE" invites reading a stale-frozen-hot pool as `all-hot`) | Adopted — one rule, stated in both sites: `all-hot` iff EVERY alternate carried a VALID reading at/above the ceiling; `target-unmeasured` the moment ANY alternate lacked one, regardless of frozen values | §3.1, §3.3 |
| R5-L3 (T1 continuation lookup ambiguity — "the previous episode's close" could read as most-recent-of-any-signature) | Adopted — lookup pinned: continuation matches the most recent episode WITH THE SAME TRIGGER SIGNATURE; §12 pins the interleaved-episode case | §3.5, §12 |
| R5-L4 (first-reading pile-on onto a fresh account unnamed — a soak could read the bounded case as a regression) | Adopted — named in §3.3 with its three bounds (per-tick `triggerPoll` refresh, the 15-point headroom budget, dwell per moved session) and the `burn-aware-targeting` smoothing pointer | §3.3 |

## 20. Round-6 findings disposition (convergence round — all folded IN-ROUND)

Round 6 verified all 8 round-5 findings genuinely resolved and raised **zero
CRITICAL and zero MAJOR** findings (report: `docs/specs/reports/
swap-continuity-antithrash-round6-findings.md`, reviewed commit c3eba1dde).
The 3 MINOR + 4 LOW items raised were each a bounded textual/schema-completing
touch — none alters any brake bound, caller-class direction, invariant,
default, or §0 property — and all were folded in-round per the disclosed
process (the report carries the honest delta accounting). Calibrations of
external severities are recorded per finding, never silent.

| finding | disposition | where |
|---|---|---|
| R6-m1 (ledger `kind` enum cannot represent the §4.5 interactive work-gate rows; recovery-row question undecided — from GPT-tier #1, calibrated MAJOR→MINOR: pure schema-completeness, no brake or safety property reads the field on these rows; the R3-m1/R3-m2 precedent class) | Folded in-round — `kind` gains the `'interactive'` member (the §4.5 refusal/force rows' home); `kind` mirrors the caller's lane, stated; recovery-class refreshes DECIDED to write no swap-ledger rows (gate-exempt, no decision exists; the reap-log is their record); §3.6 streak note (interactive rows never join a streak) | §3.5, §6.1 |
| R6-m2 (pool-level `measurement-blind` episode has no ledger anchor in the whole-pool case — its dedupe is not restart-proof and the §6.1 stamping implication cannot happen when zero rows are written; from GPT-tier #2, calibrated MAJOR→MINOR: alert-hygiene bound of one extra item per restart×blind-episode, the R5-m2/R5-m3 class; the pause direction stays safe) | Folded in-round — anchoring stated honestly: candidate-row episodes anchor durably via `target-unmeasured` rows; the whole-pool episode lives in memory + the §6.3 status block, restart MAY re-raise once (accepted, toward alerting); `measurement-blind-marker-row` named as the purely-additive durable refinement | §3.3 |
| R6-m3 (episode close row is never written when the server is DOWN as the backoff deadline elapses — hydration then loses continuation memory and re-alerts once; from GPT-tier #4, adopted at its filed MINOR) | Folded in-round — hydration synthesizes the close IN MEMORY at `breakerDeadline` from the signature-carrying open-marker row when the deadline elapsed with no matching close row (read path stays read-only, nothing written at boot); §12 pins the down-across-deadline join | §3.5, §12 |
| R6-L1 (a terminating cohort migration — each session ≤ `swapFrequencyThreshold − 1` hops, no inversion — produces aggregate churn with every detector green; from GPT-tier #3, calibrated MAJOR→LOW with the rationale recorded: every hop must pass bound 0 + (a) + (c) + dwell on fresh readings — individually-justified movement, not the 2026-07-02 jitter pathology, which passes none; pace capped by `maxSwapsPerCycle` + per-target cap + dwell; the §4 work gate protects in-flight work regardless of detector state; the R4-L1/R5-L4 named-bound class. The "contradicts §3.5" arm refuted: the multi-session sentence is scoped to returning ROTATIONS) | Folded in-round — the pool-aggregate band named beside R4-L1's single-session band, with its bounds and ledger visibility; `pool-aggregate-churn-detector` named as the purely-additive refinement | §3.5 |
| R6-L2 (the R5-L2 empty-filter classification could be misread as refusing while a valid target survives; from gemini-2.5-pro #1, calibrated MINOR→LOW: both sites already carry the "filtered set is empty" conditional — the misreading requires lifting the clause out of its stated scope) | Folded in-round — explicit scope guard added at the §3.3 selection order (the clauses classify an EMPTY filtered set and nothing else); §12 pins the mixed-pool-with-one-valid-target proceeds case from the other side | §3.3, §12 |
| R6-L3 (internal — §18's R4-m3 disposition row still records the superseded "absent excluded / remaining leg decides" arm with no supersession marker; a §18-skimming builder could resurrect the exact contradiction R5-M1 killed) | Folded in-round — supersession marker added to the row ("do not build from this row"; §4.1/§19 carry the decided direction) | §18 |
| R6-L4 (internal — the pool-level measurement-blind trigger as written fires vacuously on a 0–1-account pool, where proactive optimization is inherently a no-op: a false alarm about a pause that costs nothing) | Folded in-round — ≥2 non-disabled accounts conjunct added to the trigger condition | §3.3 |

## Open questions

*(none — all resolved into §14 Frontloaded Decisions)*

---

*Draft authored 2026-07-02 (Session A, roadmap 4.4 + operator-priority thrash
brake); round-2 revision same day (round-1 findings folded — §15); round-3
revision same day (round-2 findings folded — §16); round-4 revision same day
(round-3 findings folded — §17: the detection arithmetic re-derived —
retention/hydration ⊇ every detection window via one `retentionBoundMs`
formula, and the breaker gains a frequency tier whose threshold crossing
opens it directly, so the dwell-paced A→B→C→A rotation is provably caught —
and the ledger-loss fail direction decided: unwritable ⇒ proactive pauses,
I12). Round-5 revision same day (round-4 findings folded — §18: the
measurement-trust hole closed — bound 0 requires a present, fresh quota
reading on both legs of every proactive swap, so a quota-blind account can no
longer read as the coolest target in the pool and defeat brakes (a)+(c); plus
the outage row-loss class, tier-general episode continuation, the any-leg I7
rule, and full-materiality execute-time revalidation). Round-6 revision same
day (round-5 findings folded — §19: the `absent` subagent-leg direction
DECIDED — absent behaves like a failed probe for every caller class, so an
id-less session is proactively exiled instead of blindly killed and a forced
kill says honestly when its enumeration was blind; the measurement-blind
trigger made pool-level and candidacy-independent; continuation memory made
restart-proof via the signature-carrying close row + the retention formula's
continuation term; and the outage+restart residual stated honestly with a
durable `outage-summary` breadcrumb replacing the false under-primed claim).
Round-6 convergence review same day: all 8 round-5 findings verified
genuinely resolved, both external families ran (GPT-tier via the pi door +
gemini-2.5-pro), zero CRITICAL/MAJOR; the 3 MINOR + 4 LOW raised were folded
in-round with the delta disclosed (§20) — verdict CONVERGED. Evidence:
`logs/server.log` (echo, v1.3.722).*
