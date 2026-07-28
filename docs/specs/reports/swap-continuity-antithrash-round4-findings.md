# Swap-Continuity Anti-Thrash — Round 4 findings (consolidated)

Round 4 reviewers: 6 internal (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + external passes per available family:
**GPT-tier (RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`; verdict:
SERIOUS-ISSUES, 5 findings)** and **gemini-cli (RAN — gemini-2.5-pro; verdict
line: CONVERGED — internally inconsistent with its own CRITICAL-rated finding;
its 3 findings are calibrated below)**. Door honesty: the `codex` CLI binary
remains NOT installed on this machine (`which codex` empty); the GPT-tier
family was reached through the pi door, same as round 3. Both non-Claude
families completed within the timeout this round.

Spec commit reviewed: e4c5f4a48 (round-4 revision). Reviewable-body hash:
`559e10f9ff…`. Deduped across reviewers; external findings folded with
attribution and calibration; two external findings are REFUTED against real
code and recorded as such (never silently dropped).

Code-grounding re-check (integration lens, this worktree): every §2/§3/§4
primitive cite re-verified against source — `lastSwapAt` map + `cooldownMs ??
600_000` (ProactiveSwapMonitor.ts:127/:137), the precheck
`selectAccount(…, {softThresholdPct: this.thresholdPct})`
(ProactiveSwapMonitor.ts:225-232), the injected `swap` → `onQuotaPressure`
wiring (server.ts:16022-16026), `DEFAULT_SOFT_THRESHOLD = 90` +
`swapSoftThresholdPct` wiring (QuotaAwareScheduler.ts:41,
server.ts:15938), `scoreAccount` use-before-reset shape
(QuotaAwareScheduler.ts:79-89), the 5-per-10-min rate counter + in-flight
guard + unconditional `killSession` (SessionRefresh.ts:204-216/:348), the
`void _quotaAwareScheduler?.onQuotaPressure(...)` reactive-result discard
(server.ts:15972-15980), `isSessionActivelyWorking` catch→false
(SessionManager.ts:3094-3105), `hasActiveProcessesAsync` fold-to-true +
own-ps-fork (SessionManager.ts:2907-2931 — matching §4.1's do-NOT-use
rationale), pure `computeHasActiveProcesses` (SessionManager.ts:2830),
`tmuxExecCoalesced` (SessionManager.ts:623), reaper KEEP-guard re-check
(SessionManager.ts:~1034), `hasActiveSubagents`/`getActiveSubagents`
(SubagentTracker.ts:163/:151), `paneIdleWithEmptyInput` fail-closed
(ModelSwapService.ts:119-137), `paneShowsClaudeWorking` indicators
(claudeActivityIndicators.ts:30-45), `currentInboundByTopic` set/clear
(routes.ts:~17199 / ~11346-11352) + sender fields (routes.ts:~17187-17188),
guardManifest exclusion entry (guardManifest.ts:860), `DEV_GATED_FEATURES`
(devGatedFeatures.ts:45), `maybeRotateJsonlSegment`
(src/utils/jsonl-rotation.ts:128). One cite nit only (the file lives under
`src/utils/`, not `src/core/` — the spec cites it by basename, fine). No
wrong-mechanism claims found.

## Round-3 fold verification (every finding re-checked against the revised body + code)

**12 of 12 round-3 findings verified GENUINELY RESOLVED.**

| finding | verified | notes |
|---|---|---|
| R3-M1 (frequency detector starved by state bounds) | ✅ | ONE formula `retentionBoundMs = max(dwellMs, reversalWindowMs, thrashBreakerBackoffMs, swapFrequencyWindowMs)` now appears identically at ALL FOUR citation sites — §3.2 (spec lines 340-343, the in-memory prune), §3.5 read path (lines 488-490, `hydrationWindowMs = retentionBoundMs`), the §7 config comment (lines 1216-1218, "derived, not a knob"), and the §17 disposition. Arithmetic re-checked: max(45 m, 30 m, 60 m, 180 m) = 180 m = 3 h at shipped defaults ✅. Cost stated (≤4 executed entries/session; boot read still capped by keepSegments=2). §12 pins the formula against BOTH consumers (window−ε counts / older pruned). |
| R3-M2 (single-session rotation can never open the breaker) | ✅ | Two-tier trigger is normative in §3.5: T1 aggregates inversion-class increments within `reversalWindowMs`; a frequency-threshold crossing opens the breaker DIRECTLY (T2 — "the crossing IS the episode trigger"), with the why-T2-cannot-ride-T1 arithmetic stated in-text (one session's increments are ≥dwellMs apart by construction, so two can never land inside 30 m). The rotation scenario is re-derived in-text and the §12 test is re-derived from the corrected arithmetic INCLUDING the T1-starvation regression case ("one frequency crossing with NO other increment within reversalWindowMs still opens"). I8 updated ("OPENABLE by every detector that feeds it"). Scenario re-run below confirms. |
| R3-M3 (ledger loss runs the optimizer with brakes cold) | ✅ | Fail direction DECIDED on the record: UNWRITABLE ⇒ proactive PAUSES (refusal `ledger-lost`, level-triggered resume, honors dryRun); reactive untouched (I6); new invariant I12; I5's single named exception stated; corrupt-but-writable stays bounded cold-start with the unbounded-vs-bounded distinction argued (§3.5, §13 rows split). §6.3 `ledger` block is the in-memory home of the counters; §6.4's attention item names both the loss and the pause. One residual refinement (reactive/proceeded rows during the outage) → R4-m1. |
| R3-m1 (episodeId overload / wrong-kind anchor) | ✅ | `episodeKind` discriminator in §6.1 with the pairing rule (`breakerOpenedAt`/`breakerDeadline` iff `thrash-breaker`); boot derivation scoped to rows CARRYING `breakerDeadline`; §12 anchor test pins that a newer failure-streak/all-hot row can never close a live breaker. |
| R3-m2 (open-marker row kind) | ✅ | §3.5: the open marker IS the increment row that crossed the trigger (the `refused`-reversal row for T1 same-session; the executed `swapped` row for pair-level/T2), stamped with episode fields at append time — no invented kind. |
| R3-m3 (sub-tick source-account race) | ✅ | §3.3: execute-time revalidation covers the SOURCE — current account must equal `intent.from`, else `invalidated`/`intent-stale`; §12 test present. (The remaining sub-tick materiality gap — source pressure/improvement not re-checked — is R4-m4, a distinct, smaller seam.) |
| R3-m4 (`agentType` outside the neutralization rule) | ✅ | §4.3(3): neutralize+clamp extended to EVERY non-fixed field in the payload; `agentType` ≤64; §12 hostile-agentType test. |
| R3-m5 (reactive failures wired to the wrong escalation) | ✅ | §3.1/§3.6: reactive `failed` rows ride the §3.6 streak machinery, `kind: 'reactive'` separated, escalation-only (no backoff — I6 forbids skipping a rescue); trigger (2) stays the rate-cap-refusal path only. |
| R3-L1 (absent vs indeterminate) | ✅ | §4.1 pseudocode fixed to `'absent'`; state-name pin added; §6.1 `subagentLeg` enum matches. |
| R3-L2 (discarded-seam wording) | ✅ | §3.1 now names the rate-limit listener's discarded `onQuotaPressure` RESULT promise — verified verbatim in code (server.ts:15972-15980: `void _quotaAwareScheduler?.onQuotaPressure(...)`). |
| R3-L3 (re-intent backoff phantom knob) | ✅ | §4.2: FIXED to `dwellMs` in v1, stated; `reIntentBackoffMs` named as the purely-additive later knob. |
| R3-L4 (framing priority) | ✅ | §4.3(3) normative framing rule: the quoted inbound is user CONTENT answered as a user message, never operational-instruction priority. |

## The round-2 evasion scenarios, re-run against the round-4 design (the core attack check)

**R2-M3 (A→B→C→A directed rotation), shipped defaults (dwell 45 m, frequency
3-in-3 h, reversal window 30 m):**

- t=0: S executes A→B (passes (a)/(c)). t=45 m: B→C. t=90 m: C→A. Retention =
  `retentionBoundMs` = 3 h (§3.2, all four cite sites agree) → all three
  executions are in the index at t=90 m → per-session count = 3 =
  `swapFrequencyThreshold` → **the crossing opens the breaker DIRECTLY (T2)**
  — no 30-min aggregation to defeat. 4th hop (t=135 m) suppressed
  `thrash-breaker`. Worst case = exactly 3 hops, then loud (ONE episode item).
- Restart between the 2nd and 3rd executions: hydration window =
  `retentionBoundMs` = 3 h ⊇ the frequency window → the count re-primes and
  the 3rd execution still crosses. Restart mid-backoff: derivation anchors on
  the most-recent row carrying `breakerDeadline` (§3.5/R3-m1) → boots OPEN
  with the original deadline, no re-alert (episodeId dedupe). **CAUGHT — both
  round-3 starvation seams (prune bound, hydration bound) and the trigger
  arithmetic seam are closed.**
- Residual, stated honestly: a rotation paced SLOWER than
  `swapFrequencyWindowMs / (swapFrequencyThreshold − 1)` (> ~90 m between
  hops at defaults) never trips T2 — the inherent evasion band of any
  threshold detector → R4-L1 (observation; each such hop must still
  independently pass (a)+(c)+dwell, so it is individually-justified churn at
  ≤⅔ the incident pace, and dwell alone bounds it).

**R2-M5 (target rotation vs re-intent backoff):** drop on A→B at the 30-min
ceiling → the SESSION enters re-intent backoff for `dwellMs` (§4.2, keyed on
`(session)`, fixed to dwellMs per R3-L3) → a next-tick A→C intent is blocked
by the session key; the `deferralAgeMs` ceiling clock carries across target
re-selection within the episode. Restart: re-derived from `dropped` rows in
the 3 h hydration window ⊇ the 45-min backoff. **STILL CLOSED.**

**Multi-session directed 3-cycle probe (fresh variant):** S1: A→B, S2: B→C,
S3: C→A spread across sessions — no session crosses the frequency threshold
and a directed cycle has no inversion edge. Checked against the bounds: each
leg needs its source ≥80 AND its target <65 (bound 1) — but binding-window
utilization does not decay on evacuation (it is quota-window usage, not
session count), so the closing leg's target (the original source, ≥80) cannot
re-enter the cool set until its 5 h window rolls off ≥15+ points — hours, the
legitimate standing-wave pace. The cascading cross-session cycle is blocked by
the (a)+(c) arithmetic itself, not by a detector. **CLEAN** (modulo R4-M1
below — this argument assumes the readings are real).

## The four operator properties, re-verified end-to-end

- **(a) all-hot ⇒ stay put:** §3.1 refusal unless a target measures under the
  §3.3 ceiling; state-transition rows prove episodes (I2); breaker evaluates
  before all-hot in the pipeline. HOLDS on the design — with one measurement
  caveat: an account with an ABSENT/frozen quota reading measures 0 and
  defeats the brake (R4-M1).
- **(b) per-session dwell, restart-safe:** §3.2 45-min dwell, reactive swaps
  start the clock, never block reactive (I6/I3); ledger-hydrated across
  restarts (window 3 h ⊇ dwell); ledger-UNWRITABLE now pauses the optimizer
  entirely (I12), so dwell can no longer go silently cold while proactive
  runs. HOLDS.
- **(c) destination materially better:** §3.3 two bounds + normative
  filter→score→verify + explicit-target pass-through + execute-time
  revalidation (target ceiling + source identity); intra-tick per-target cap.
  HOLDS on real readings — vacuous on absent/frozen readings (R4-M1), and the
  sub-tick execute window re-checks the ceiling but not the improvement delta
  (R4-m4, bounded by one poll interval which §3.3's headroom already budgets).
- **(d) never swap while work is in flight:** §4 gate at the
  `refreshSession` chokepoint, default-refuse for unlisted callers, I11
  provenance, recovery enumerated, ceiling-drop (the wall wins), reactive
  grace bounded at 120 s with F3 mitigations, model-swap subagent leg staged
  dark on its own rung with §0 delivery honesty. HOLDS. The tracker-cold
  attack against the subagent leg was probed and REFUTED in code (see
  external calibration — `loadActiveIndex()` rebuilds active subagents from
  persisted JSONL at boot; the stale-active residual fails toward BUSY, the
  safe direction).

## MUST-FIX (MAJOR — material; requires a spec change before build)

- **R4-M1 (adversarial + fail-direction; independently found by the GPT-tier
  external pass, its #5) — An absent or unboundedly-stale quota reading fails
  toward MORE swapping: properties (a) and (c) are vacuous exactly when the
  measurement layer is blind (§3.1, §3.3, §13).** The spec's filter, ceiling,
  improvement bound, and all-hot brake are all defined on
  `bindingUtilization`, and the real primitive returns **0 when there is no
  reading**: "0 when there is no reading yet (unknown = treated as empty /
  still selectable)" (QuotaAwareScheduler.ts:44-57); enrollment starts
  `lastQuota: null` (SubscriptionPool.ts:323); and a FAILED poll leaves the
  last-good snapshot in place indefinitely with no freshness check anywhere in
  selection (QuotaPoller.ts:398-403 skips the update on failure;
  `AccountQuotaSnapshot.measuredAt` exists — SubscriptionPool.ts:89 — but
  nothing in `selectAccount`/`accountAtPressure` reads it). Consequences, per
  the spec's own normative text: a freshly-enrolled or poll-broken account
  measures 0 → passes bound 1 (0 < 65) and bound 2 (≥15-point "improvement")
  → is the maximally-attractive target for EVERY hot session; the all-hot
  brake sees a "cool" target and stands down; execute-time revalidation
  re-reads the same vacuous 0 and passes; sessions landed there measure 0 so
  they never re-qualify as proactive sources; NO detector fires (each session
  hops once — no inversion, no frequency crossing), and the pile-on is paced
  only by the 1-per-target-per-tick cap (~20 kills/h at the 3-min tick). A
  frozen-stale reading (seat auth broken, parse failure) is the same hole with
  a cool last-good value. §13's row "stale data fails toward NOT swapping" is
  true ONLY for one-poll-interval lag (the case §3.3's 15-point headroom
  budgets) — the spec never decides the absent/unbounded-stale direction,
  which is the R3-M3 decision class recurring one signal to the left. The
  honest-degraded pattern already exists one function away
  (`poolHeadroom`'s `degraded: true` for "no trustworthy live reading",
  QuotaAwareScheduler.ts:127-149) and the spec does not engage it. FIX (one
  normative rule + one §13 row): proactive target eligibility requires a
  quota reading PRESENT and FRESHER than a freshness bound (e.g. 2× the poll
  cadence); an absent/older reading is NOT under the ceiling (so it also
  counts toward all-hot), refused with a structured reason
  (`target-unmeasured`, or folded into `no-material-target` with a flag);
  the SOURCE-pressure predicate requires the same validity (a vacuous 0
  source is simply never a candidate — already the code's behavior, state
  it); REACTIVE selection is deliberately untouched (I6 — fresh-enrollment
  selectability for rescue is the documented reason the primitive treats
  unknown as selectable, and a walled session's rescue onto an unmeasured
  account is still better than death). Correct §13's stale-data row to scope
  its claim to bounded poll-lag.

## SHOULD-FIX (MINOR)

- **R4-m1 (decision-completeness) — I5's "single named exception" is
  inaccurate during an unwritable-ledger episode, and the in-memory index's
  behavior on a FAILED append is unspecified (§3.5, I5, I12).** While the
  ledger is unwritable, proactive intents refuse `ledger-lost` (the named
  exception) — but REACTIVE swaps still execute (I6) and forced interactive
  refreshes still `proceed`, and neither can write its row either: a second,
  unnamed row-loss class. Downstream: dwell's clock-start for a
  reactively-rescued session and the frequency count depend on those rows;
  if the write-through index only updates on SUCCESSFUL append, brake state
  goes cold for exactly the swaps that happen during the outage (bounded —
  proactive is paused — but the post-resume first tick can then prematurely
  re-swap a just-rescued session, the exact dwell case). FIX: two sentences —
  (1) non-refusal decisions during an unwritable episode UPDATE THE IN-MEMORY
  INDEX regardless of append failure (so brakes stay primed until the next
  restart) and are counted in the §6.3 `ledger` block (`rowsLostWhileDown` or
  similar); (2) amend I5's exception wording to cover the outage class
  (refusals are counter-only; executed/proceeded rows during the outage are
  index-primed + counted, durable trace = the episode's attention item).
- **R4-m2 (lessons-aware/P17; from gemini finding 2, calibrated MAJOR→MINOR)
  — Episode CONTINUATION is defined only for the T2/same-session case; a
  sustained T1 (inversion-tier) thrash re-alerts once per backoff cycle —
  the "hourly alert drip" the spec's own P17 line forbids (§3.5).** After the
  breaker half-opens, a persisting inversion pattern re-accumulates 2
  increments within ~2 ticks and re-opens; the continuation rule ("same
  session as the previous FREQUENCY episode's trigger") does not match a T1
  re-open, so a literal builder mints a new `episodeId` → a new attention
  item per hour for one sustained pathology. Half-open semantics are also
  only implicit (nothing distinguishes half-open from closed except
  continuation memory). FIX: generalize continuation — any re-open within a
  continuation window (reuse `swapFrequencyWindowMs`, or the episode's own
  detection window) of the previous episode's close, on the SAME trigger
  signature (same session for T2; same account pair for T1), is a
  continuation: same episodeId, extended deadline, no second item — and one
  sentence pinning half-open = closed-with-continuation-memory. Calibration:
  alert hygiene only; every property holds; errs toward more alerting during
  a state that already warrants attention.
- **R4-m3 (decision-completeness/fail-direction; from gemini finding 3,
  calibrated) — I7's proactive rule "any `indeterminate` on BOTH legs →
  resolve busy" is ambiguous for the mixed case (one leg idle, other leg
  probe-failed), and the `turnLeg || subagentLeg` pseudocode is not defined
  over tri-states (§4.1, I7).** A literal "both-legs" reading resolves
  footer=indeterminate + subagent=confidently-false to NOT busy — killing a
  possibly-mid-turn session exactly when tmux is flaky, inverting I7's own
  stated purpose. The ledger vocabulary (`busy-indeterminate` deferrals)
  implies the safe any-leg reading, but the normative sentence permits the
  unsafe one. FIX: one sentence — for proactive/optimization callers a
  session is idle ONLY when every readable leg affirmatively reports idle;
  `'working'` or `'indeterminate'` on ANY leg resolves busy (`'absent'`
  excluded per the R3-L1 pin: the remaining leg decides); restate I7 to
  match and define the pseudocode's `||` over the tri-state explicitly.
- **R4-m4 (adversarial; from GPT-tier finding 1, calibrated MAJOR→MINOR) —
  execute-time revalidation re-checks the target ceiling and the source
  IDENTITY but not fresh source-pressure or the improvement delta (§3.3).**
  A deferred intent is fully covered (§4.2 re-runs the ENTIRE pipeline at
  every retry tick — source-pressure and both bounds are explicitly listed),
  so the residual is only the sub-tick window between the pipeline pass and
  the execute call, bounded by one poll delta — the magnitude §3.3's
  15-point headroom already budgets, and bound 2 is implied by bound 1 at
  shipped defaults. Still, the fix costs one clause on a snapshot the
  revalidation already holds: re-verify `source ≥ thresholdPct` and
  `source − target ≥ minImprovementPct` fresh, refusing
  `target-revalidation-failed` (or `intent-stale` for the source arm) — then
  property (c) is checked at the actual kill point, not one sub-tick before.

## LOW

- **R4-L1** — Sub-threshold rotation pacing: hops spaced >
  `swapFrequencyWindowMs/(swapFrequencyThreshold−1)` (~90 m at defaults)
  never trip T2 — the inherent evasion band of any threshold detector. Each
  hop still passes (a)+(c)+dwell individually. Name the band in §3.5 (one
  sentence) so a soak reading "green detectors + steady ~90-min churn" is
  interpreted correctly rather than as proof of no rotation.
- **R4-L2** — No cross-knob coherence constraint: an operator raising
  `dwellMs` above `swapFrequencyWindowMs/(swapFrequencyThreshold−1)` (> 90 m
  at defaults) silently disarms T2 (three dwell-paced hops can no longer fit
  the window). Higher dwell also means less churn, so the residual is small —
  but a one-line config-load warning (or deriving the window from dwell) keeps
  a conservative-looking retune from killing a detector.
- **R4-L3** — §7.1 marks `antiThrash.enabled` live-per-tick while §3.5
  hydrates "ONCE at boot": whether hydration runs when antiThrash boots
  DISABLED (and is flipped on mid-run) is unstated. The §9 cold-start
  acceptance bounds the harm; still, one sentence ("the ledger module loads
  and hydrates unconditionally at boot — reactive rows are appended
  regardless, so the index is warm whenever the flag flips on") removes the
  half-enable ambiguity this spec's own §7.1 exists to prevent.
- **R4-L4 (from gemini finding 1, calibrated CRITICAL→LOW)** —
  `target-revalidation-failed` refusals are per-tick rows with no
  state-transition/heartbeat treatment (§3.1 gives that shape only to
  all-hot and thrash-breaker rows). Gemini's "zero-delay retry loop / CPU
  saturation" reading is factually wrong — §3.3 says "retried next tick"
  explicitly, and the next tick's own FILTER re-runs against the fresh
  snapshot (usually resolving to a different target or an all-hot refusal,
  which HAS volume treatment) — but a snapshot flip-flopping around the
  ceiling each poll could still produce one refused row per session per tick
  for a while. Either extend the enter/leave/heartbeat scheme to this reason
  or state the accepted bound (~20 rows/h/session, self-limiting).

## Detector-probe results that came back CLEAN (adversarial)

R2-M3 and R2-M5 re-runs (above — both closed); multi-session directed 3-cycle
(blocked by non-decaying utilization + bounds arithmetic); T1 false-positive
sweep (repeated same-session reversal refusals open the breaker within ~2
ticks — errs toward stay-put, the demanded direction); breaker suppression of
a mid-wait deferred intent (§4.2 explicitly non-exempt); deferral rate-budget
starvation (gate-before-rate-guard holds, §4.2); ledger-lost × dryRun
interplay (consistent — dry-run logs would-refuse only, and dry-run antiThrash
was already decision-inert); heartbeat cadence consistency (§3.1 "default 30
min" = §7 `allHotHeartbeatMs: 1800000`); §6.1 schema × §6.2 enum
cross-check (every reason reachable from exactly the decision kinds that
carry it; `ledger-lost` correctly ledger-absent); retention/hydration formula
consistency at all four cite sites (§3.2/§3.5/§7/§17); episode-continuation
lookback fits inside the hydration window (close + re-cross ≤ 3 h retained);
`followUpPrompt` mitigation-payload hygiene (every non-fixed field
neutralized+clamped per R3-m4; nothing outside the quoted region but fixed
template bytes); I11 callerClass provenance (no route surfaces the field;
§12 pins it); SubagentTracker cold-boot attack on the (d) gate — REFUTED,
see external calibration.

## External pass status (with calibration + refutations)

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary not
  installed; same door as round 3). Verdict: **SERIOUS-ISSUES**, 5 findings,
  calibrated: #5 = **R4-M1** (independent corroboration of the internal
  quota-blindness finding — the round's headline); #1 → **R4-m4**
  (MAJOR→MINOR: the deferred path already re-runs the full pipeline per
  §4.2; the residual is the sub-tick window, bounded by one poll delta);
  #2 (under-primed hydration should pause like ledger-loss) → **not adopted;
  decided-on-the-record**: §3.5/§9/§13 explicitly split bounded-cold
  (continue, self-heals within each window, flagged honestly) from
  unbounded-cold (pause) and argue why — re-litigating a recorded decision
  without new failure math; #3 (SubagentTracker cold after restart defeats
  the (d) gate) → **REFUTED by code**: the tracker persists per-session JSONL
  and `loadActiveIndex()` rebuilds the active index at construction
  (SubagentTracker.ts:63, :262-269), so a restart does not blank the leg;
  the true residual (a subagent that stopped while the server was down stays
  active-forever) resolves BUSY — the SAFE direction (bounded: defer →
  30-min ceiling → drop); #4 (bearer-level `force`) → **not adopted;
  decided-on-the-record** in §4.5 with the no-regression rationale and the
  named `force-capability-scope` follow-up (this is round-2 S7/R2-m10,
  already folded — a repeat, not a new finding).
- **gemini-cli (gemini-2.5-pro): RAN** — verdict line: **CONVERGED**, yet it
  rated its own first finding CRITICAL (internally inconsistent; recorded
  verbatim, calibrated here). 3 findings: #1 (revalidation retry loop) →
  **R4-L4** (CRITICAL→LOW: the "zero-delay/same-tick" retry premise is
  contradicted by §3.3's explicit "retried next tick", and the claimed CPU
  saturation does not follow from one evaluation per 3-min tick; the row-
  volume residual is real and kept); #2 (T1 episode continuation undefined /
  hourly drip) → **R4-m2** (adopted, MAJOR→MINOR); #3 (idle+indeterminate
  ambiguity in I7) → **R4-m3** (adopted).
- Cross-model signal: the round's single MAJOR (quota-signal blindness) was
  found independently by the internal adversarial pass and the GPT-tier
  external — the same double-confirmation shape as round 3's headline. The
  Gemini pass produced two adopted minors but also demonstrated rubric drift
  (a CRITICAL rating on a factually-wrong premise plus a CONVERGED verdict
  line) — its findings are used, its calibration is not.

## Convergence verdict

**NOT CONVERGED.** Round 4 surfaced **1 MAJOR finding** (R4-M1 — the
absent/unboundedly-stale quota reading fails toward more swapping;
independently corroborated by the GPT-tier external), plus **4 MINOR and 4
LOW**. All 12 round-3 findings verified genuinely folded (12/12 — the
retention arithmetic is consistent at every cite site, the two-tier breaker
trigger is satisfiable by the rotation attack it exists to catch, and the
ledger-loss fail direction is decided and invariant-pinned), and both
round-2 evasion scenarios remain closed under re-attack. All four §0
operator properties hold on the design's own terms; R4-M1 is the one seam
where they go vacuous — not because a brake is wrong, but because every
brake trusts a measurement whose absence reads as "cool", and the spec's
§13 stale-data row overclaims the safe direction. The fix is small and
shape-preserving (a validity/freshness gate on the proactive filter + one
§13 correction + the I6 carve-out for reactive), the same bounded-correction
class as round 3's MAJORs. Round 5 required: fold R4-M1 (+ the cheap minors)
into a round-5 revision, then re-run the round — externals mandatory (the
reviewable body will change). The trajectory is converging: 6 MAJORs
(round 2) → 3 (round 3) → 1 (round 4), each round's majors narrowing from
design-shape to arithmetic to measurement-trust.
