# Swap-Continuity Anti-Thrash — Round 6 findings (convergence verification)

Round 6 reviewers: internal (security, adversarial, integration,
decision-completeness, fail-direction, lessons-aware lenses) + external
passes per available family: **GPT-tier (RAN — `pi` 0.78.1 →
`openai-codex/gpt-5.5`; verdict: SERIOUS-ISSUES, 4 findings — all four
calibrated below, none surviving as MAJOR)** and **gemini-cli 0.25.2 (RAN —
gemini-2.5-pro; verdict: MINOR-ISSUES, 1 finding)**. Door honesty: the
`codex` CLI binary remains NOT installed on this machine (`which codex`
empty); the GPT-tier family was reached through the pi door, same as rounds
3–5. Both non-Claude families completed within the timeout, single bounded
pass each.

Spec commit reviewed: c3eba1dde (round-6 revision). Reviewable-body hash
(sha256): `5e8457113ff5…`. Deduped across reviewers; external findings
folded with attribution and calibration — three external MAJORs calibrated
down with the rationale recorded per finding (never silently), one external
MINOR adopted as filed.

**Process disclosure (in-round folds, honestly accounted — the
standby-write-reconciliation round-3 precedent):** both externals reviewed
the c3eba1dde body. This round raised zero CRITICAL/MAJOR; the 3 MINOR + 4
LOW it did raise are each a bounded textual/schema-completing touch, and all
seven were folded in-round as commit d62c78ff1 BEFORE this report, with a
§20 disposition table added to the spec. The delta between what the
externals reviewed and the tagged body is exactly that commit — five of the
seven touches directly implement the externals' own findings — and none
alters any brake bound, caller-class direction, invariant, config default,
or §0 property. Every row of the verification table below was re-verified
against the folded text.

Code-grounding re-check (integration lens, this worktree, v1.3.722 tree):
the round-6 revision introduced no new code cites; the standing cites were
re-verified against source this round rather than trusted from round 5 —
`bindingUtilization` returns 0 on no reading with the unknown-selectable
comment (QuotaAwareScheduler.ts:50-57), `accountAtPressure`
(:159-166), `DEFAULT_SOFT_THRESHOLD = 90` (:40), `onQuotaPressure`
re-selection (:224-228), `scoreAccount` headroom×urgency (:79-89);
enrollment `lastQuota: null` (SubscriptionPool.add(), SubscriptionPool.ts:323)
and `measuredAt` on the snapshot (:89); the failed-poll freeze
(`if (!snap) { failed++; continue; }`, QuotaPoller.pollAll ~:398-401) and the
15-min default cadence (`pollIntervalMs ?? 15 * 60_000`, QuotaPoller.ts:236);
monitor `cooldownMs ?? 600_000` (:137), in-memory `lastSwapAt` (:127),
`triggerPoll` under watch-zone pressure (ProactiveSwapMonitor.ts:190-200),
the below-threshold precheck (:226-231), execution via `cfg.swap`
(:248-256 — including the pre-existing silent `catch { continue }` §3.6
names), `mapCandidates`→`accountAtPressure` (:277-301); SessionRefresh
rate counter 5-per-10-min (:204-205), `inFlight` guard (:216), unconditional
`killSession` (:348), `claudeSessionId` read (:396), `followUpPrompt` →
respawner (:428); SubagentTracker `getActiveSubagents` (:151-153) and O(1)
`hasActiveSubagents` (:163-165); `isSessionActivelyWorking` with its
catch→false (SessionManager.ts:3094-3103); `paneShowsClaudeWorking` /
CLAUDE_WORKING_INDICATORS (claudeActivityIndicators.ts:30-44);
`paneIdleWithEmptyInput` fail-closed (ModelSwapService.ts:119-136); the
reaper's active-subagent KEEP-guard family (SessionManager.ts:~1034);
server.ts — `softThresholdPct` wiring (:15938), the rate-limit listener
discarding the whole `onQuotaPressure` result promise (`void …`,
:15966-15980), the swap wiring (:16023-16027 incl. `triggerPoll: () =>
quotaPoller.pollAll()`), the respawner/followUpPrompt flow (:15905-15920),
and `quotaPoller.start()` gated on `subscriptionPool.size() > 0` at boot
(:12016-12017 — the R5-m1 wiring note re-confirmed); routes.ts
`currentInboundByTopic` set-on-inbound (:17199) and cleared-on-reply
(:11346-11352). No false code claims found; line drift ≤2 lines on two
cites (within the ceremony's tolerance, not re-filed).

## Round-5 fold verification (every finding re-checked against the revised body + code)

**8 of 8 round-5 findings verified GENUINELY RESOLVED.** The R5-M1
fold-regression class was hunted specifically: a full-body sweep of every
`absent` occurrence (37 sites) found the decided direction consistent at
every normative site — the round-5 contradiction pattern did not recur.
(One ARCHIVAL echo survived in §18's historical disposition row; filed as
R6-L3 and folded.)

| finding | verified | notes |
|---|---|---|
| R5-M1 (absent subagent-leg direction contradicted in-body; §4.1 reading killed live subagents on id-less sessions blind + unenumerated) | ✅ | The direction is DECIDED at the §4.1 pin: `'absent'` resolves exactly like `'indeterminate'` for every caller class — BUSY for optimization callers (defer→ceiling→drop; id-less sessions proactively exiled, counter-visible, `subagent-id-chronic-absence` follow-up named), busy-for-grace for reactive, honest 409 for interactive (`subagentLeg:'absent'`, `subagents` OMITTED). The old "remaining readable leg decides" arm is GONE from every normative site (grep-verified). §4.3(1) carries the mitigation-blindness honesty line (forced kill with id absent says "subagent state unreadable at kill time"; `killedSubagents`/`killedSubagentList` OMITTED — unreadable ≠ zero, §6.1 rule stated in-matrix). I7 restated with the decided direction + its rationale. §12 pins the full mixed-leg matrix including footer-idle + absent ⇒ BUSY (builder resolving by footer alone fails), the 409 payload shape, and the forced-kill honesty line. §13 row rewritten per caller class. Property (d) now holds for id-less sessions — the last pending arm of the round-5 property table closes. |
| R5-m1 (measurement-blind surfacing candidacy-dependent; whole-pool blindness silent; poller boot-gating compounds) | ✅ | §3.3: the trigger is POOL-LEVEL, per monitor tick, over the pool itself — explicitly NOT over a candidate evaluation's alternate set, with the load-bearing distinction argued in-text (stale sources kill candidacy, so a candidacy-scoped trigger can never see whole-pool blindness). Reads snapshots directly; explicitly must not assume the poller loop runs (boot-gate re-verified in code at server.ts:12016-12017, carried into the §12 build audit). I13 restated pool-level; §6.4 and the §13 stale-reading row updated. §12 pins BOTH the all-stale-zero-candidacy case AND the never-started-poller case (a candidacy-scoped builder fails both). Residuals found this round: the whole-pool episode's dedupe anchor (R6-m2) and a 0–1-account vacuous fire (R6-L4) — both folded. |
| R5-m2 (episode continuation memory not restart-proof) | ✅ | §6.1: `triggerSignature` field rides the thrash-breaker open-marker AND close (suppression `leave`) rows, pairing note updated. §3.2: the retention/hydration formula gains the continuation term `thrashBreakerBackoffMs + max(reversalWindowMs, swapFrequencyWindowMs)` (dominates at 4 h; arithmetic verified: 60 m + 180 m = 240 m; the "≤6 executed-swap entries per session" cost restated for 4 h — 240/45 = 5.3 ✓); one formula still governs both bounds, §3.5's read path and §7's comment carry the identical 5-term max (cross-site consistency verified). §3.5: hydration re-derives continuation from the most-recent SAME-SIGNATURE close row. §12 pins the restart-join, the `retentionBoundMs − ε` close-row retention (old 4-term max fails), and the same-signature lookup. Residual found this round: the close row is never written when the server is down across the deadline (R6-m3, from GPT-tier — folded: in-memory synthesis at `breakerDeadline` from the open-marker row). |
| R5-m3 (outage+restart premature-re-swap window; false "flags UNDER-PRIMED as usual" claim) | ✅ | §3.5(1b): the false clause is REPLACED — the honest bound stated in-body with the MINOR calibration visible ("ONE premature proactive swap per affected session per conjunction; must still pass every other brake AND the §4 work gate; §9's accepted cold-start class"). The corrected mechanism: the level-triggered resume's first successful append writes ONE `outage-summary` row (span + counts, no session/account fields, never anchors the breaker — §6.1 out-of-matrix definition + §6.2 enum member); hydration over it flags `under-primed` with the gap named. The optional post-outage boot grace is NAMED, not mandated. I5's durable-trace sentence updated to include the row. §12 pins exactly-one-row, the under-primed flag, and the can-never-anchor rule. §13 UNWRITABLE row updated. |
| R5-L1 (freshness-boundary flapping) | ✅ | §3.3: named with its bound (≤2 rows/candidate/tick, R4-L4 volume class, transient under `triggerPoll`); `freshness-hysteresis` named as the purely-additive refinement. |
| R5-L2 ("validity gate ALONE" misreading) | ✅ | One rule stated at BOTH sites (§3.1 + §3.3 step 1): `all-hot` iff every alternate carried a VALID reading at/above the ceiling; `target-unmeasured` the moment any lacked one, regardless of frozen values; the stale-frozen-hot pool argued as a measurement outage wearing hot numbers. §12 pins the mixed and all-stale-frozen pools. Residual found this round by gemini: the clause could still be lifted out of its empty-filter scope (R6-L2 — folded: explicit scope guard + the proceeds-case §12 pin). |
| R5-L3 (T1 continuation lookup ambiguity) | ✅ | §3.5: lookup pinned to the most recent episode WITH THE SAME TRIGGER SIGNATURE; §12 pins the interleaved different-signature case. |
| R5-L4 (first-reading pile-on unnamed) | ✅ | §3.3: named with its three bounds (per-tick `triggerPoll` refresh, 15-point headroom budget, dwell per moved session) + the `burn-aware-targeting` smoothing pointer, framed for soak interpretation. |

## The standing attack scenarios, re-run against the round-6 design

**R2-M3 (A→B→C→A directed rotation), shipped defaults, both breaker tiers:**
arithmetic unchanged by round 6 — retention/hydration now 4 h ⊇ the 3 h
frequency window (the widened bound only ADDS margin); hop 3 at t=90 m
crosses `swapFrequencyThreshold` and opens the breaker DIRECTLY (T2); hop 4
suppressed. Restart between hops 2 and 3 still re-primes. T1 arm: 2
inversion-class increments inside 30 min still opens. **CAUGHT — both
tiers.**

**R2-M5 (target rotation vs re-intent backoff):** session-keyed backoff +
episode-carried ceiling clock untouched. **STILL CLOSED.**

**Multi-session directed 3-cycle:** still CLEAN on real-readings arithmetic
— bound 0 unchanged this round; the closing leg still cannot pass materiality
on fresh data inside a wave (utilization does not decay by evacuating
sessions; only a genuine window reset cools an account, and a post-reset
account is a legitimately fresh target). **CLEAN.**

**The quota-blind-account attack (all three round-5 variants):** bound 0,
the all-hot accounting, and execute-time check 1 are untouched by round 6 —
re-walked, all three variants still **CLOSED at every layer**; the
enrollment-day answer and its bounds unchanged.

**Fresh round-6 evasion probe — the terminating cohort migration (GPT-tier
#3):** a cohort each executing `swapFrequencyThreshold − 1` hops
(A→B at t=0, B→C at t=45 m, stop) trips no detector — genuinely green —
but every hop must independently pass bound 0 + (a) + (c) + dwell on FRESH
readings, pool pace is capped (`maxSwapsPerCycle` + per-target cap), and
the §4 work gate holds regardless of detector state. This is the R4-L1
band's pool-aggregate shape: individually-justified movement, not the
jitter pathology (which passes none of those bounds). Named in §3.5 with
its bounds + the `pool-aggregate-churn-detector` refinement (R6-L1,
folded). The cohort variant that CLOSES the cycle (any session or pair
returning) is caught by T2/T1 as above; the directed cross-cohort 3-cycle
reduces to the multi-session 3-cycle already closed on real-readings
arithmetic.

**Fresh round-6 abuse probes on the new machinery:** a forged/replayed
`outage-summary` row cannot anchor or close the breaker (no
`breakerDeadline` by schema) and ages out of the hydration window — its
only power is an honest `under-primed` flag; the R6-m3 close-synthesis is
derivation-only (writes nothing at boot — the read path stays read-only)
and can only ever JOIN an episode (suppresses a duplicate item), never
suppress a genuinely new-signature alert; stripping `claudeSessionId` from
state records (malice or bug) EXILES sessions from proactive optimization —
the fail direction is stay-put, never a blind kill, and the chronic case is
counter-visible.

**The four operator properties:**

- **(a) all-hot ⇒ stay put:** HOLDS on measurements (unchanged this round).
- **(b) per-session dwell, restart-safe:** HOLDS; the outage+restart
  residual is bounded, stated in-body, and now durable-breadcrumbed
  (`outage-summary`).
- **(c) destination materially better:** HOLDS, verified at the kill point
  on valid fresh readings.
- **(d) never swap while work is in flight:** HOLDS — now including the
  structurally-unreadable subagent leg (R5-M1 decided: absent ⇒ BUSY for
  every optimization caller; forced kills say honestly when enumeration was
  blind). The round-5 report's one pending arm is closed. All four
  properties hold outright.

## MUST-FIX (MAJOR)

*None.* Zero CRITICAL, zero MAJOR findings this round.

## SHOULD-FIX (MINOR) — all FOLDED in-round (commit d62c78ff1; §20)

- **R6-m1 (from GPT-tier #1, calibrated MAJOR→MINOR — the R3-m1/R3-m2
  schema-completeness precedent class; no brake or safety property reads
  the field on the affected rows) — the ledger `kind` enum
  (`'proactive'|'reactive'`) cannot represent the §4.5 interactive
  work-gate rows (§6.1 vs §4.2/§4.5/I5), and whether recovery-class
  refreshes write rows was undecided.** A builder writing the 409-refusal
  or force-proceeded row had to guess the field. FOLDED: `kind` gains
  `'interactive'` (mirrors the caller's lane, stated under the matrix);
  recovery-class refreshes DECIDED to write no swap-ledger rows (gate-exempt
  by class, no swap decision exists; the reap-log is their durable record —
  §3.5 scope sentence updated); the §3.6 streak machinery explicitly reads
  only proactive/reactive.
- **R6-m2 (from GPT-tier #2, calibrated MAJOR→MINOR — alert-hygiene bound
  of one extra item per restart×blind-episode, the R5-m2/R5-m3 calibration
  class; the pause direction stays safe and the item still fires while the
  process lives) — the whole-pool `measurement-blind` episode has no ledger
  anchor: zero rows are written by construction in exactly the loudest
  case, so §6.1's stamping implication cannot happen there and the episode
  dedupe is not restart-proof.** FOLDED: anchoring stated honestly in §3.3
  (candidate-row episodes anchor durably via `target-unmeasured` rows; the
  whole-pool episode lives in memory + the §6.3 status block; a restart may
  re-raise once — accepted, toward alerting); `measurement-blind-marker-row`
  named as the purely-additive durable refinement.
- **R6-m3 (from GPT-tier #4, adopted at its filed MINOR) — the episode
  close row is never written when the server is DOWN as the backoff
  deadline elapses, so hydration inside the continuation window lost
  continuation memory and re-alerted once (§3.5, §6.1) — the narrow
  residual of the R5-m2 fix.** FOLDED: hydration synthesizes the close IN
  MEMORY at `breakerDeadline` from the signature-carrying open-marker row
  when the deadline elapsed with no matching close row (nothing written at
  boot; the deadline IS the close time); §12 pins the down-across-deadline
  join.

## LOW — all FOLDED in-round (commit d62c78ff1; §20)

- **R6-L1 (from GPT-tier #3, calibrated MAJOR→LOW with the rationale
  recorded)** — the terminating cohort migration band (above). The
  external's "contradicts §3.5" arm is REFUTED: the multi-session sentence
  is scoped to returning ROTATIONS, which a 2-hop terminating migration is
  not; the churn is individually-justified on fresh real measurements (the
  2026-07-02 jitter hops pass none of the bounds), pace-capped, and
  work-gate-protected. What was genuinely missing is the NAMING (the
  R4-L1/R5-L4 named-bound class — both LOW precedents). FOLDED: the
  pool-aggregate band named in §3.5 with its bounds, ledger visibility, and
  the `pool-aggregate-churn-detector` refinement.
- **R6-L2 (from gemini-2.5-pro #1, calibrated MINOR→LOW)** — the R5-L2
  empty-filter classification could be misread as refusing while a valid
  target survives; both sites already carry the "filtered set is empty"
  conditional, so the misreading requires lifting the clause out of scope —
  but the text invited the lift. FOLDED: explicit scope guard at the §3.3
  selection order + the §12 proceeds-case pin (one valid target among
  unmeasured alternates executes; the classification never fires).
- **R6-L3 (internal, adversarial consistency sweep)** — §18's R4-m3
  disposition row still recorded the superseded "absent excluded /
  remaining leg decides" arm with no supersession marker: a §18-skimming
  builder could resurrect the exact contradiction R5-M1 killed. FOLDED:
  supersession marker on the row ("do not build from this row").
- **R6-L4 (internal, fail-direction lens)** — the pool-level
  measurement-blind trigger fired vacuously on a 0–1-account pool (no
  alternate exists, the optimizer is inherently a no-op — a false alarm
  about a pause that costs nothing). FOLDED: ≥2-non-disabled-accounts
  conjunct on the trigger.

## Detector-probe results that came back CLEAN (adversarial)

R2-M3 both tiers + restart; R2-M5; multi-session directed 3-cycle;
quota-blind pile-on (all three variants); enrollment-day exile probe;
fresh-but-frozen forgery probe; all-legs-`absent` vacuous-idle probe (the
footer probe still never returns absent — only the subagent leg can);
breaker re-open-while-open impossibility; forged `outage-summary`
anchor/close probe (schema forbids — no `breakerDeadline`); R6-m3
close-synthesis abuse probe (derivation-only, join-only, boot writes
nothing); `claudeSessionId`-stripping probe (fail direction = exile, never
a blind kill); §6.1 schema × §6.2 enum cross-check including the new
`'interactive'` kind member, the `outage-summary` decision member, and the
`triggerSignature` open/close placement (pairing rule intact); §3.2/§3.5/§7
retention-formula cross-site identity (all three sites carry the same
5-term max, 4 h at defaults); §7.1 liveness table coverage; the R4-L2
warnings' fail directions; dry-run × bound-0 × ledger-lost interplay
(would-refuse counters only, consistent across brakes).

## External pass status (with calibration + refutations)

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary
  not installed; same door as rounds 3–5). Verdict: **SERIOUS-ISSUES**, 4
  findings, calibrated: #1 → **R6-m1** (MAJOR→MINOR: schema-completeness
  only, the R3-m1/R3-m2 precedent class — no brake, property, or safety
  behavior reads `kind` on the affected rows; fix is one enum member + one
  decided sentence); #2 → **R6-m2** (MAJOR→MINOR: alert-hygiene bound of
  one duplicate item per restart×blind-episode, the R5-m2/R5-m3 calibration
  class; the pause direction is safe and the in-process item still fires);
  #3 → **R6-L1** (MAJOR→LOW: the "contradicts §3.5" arm refuted — rotation
  ≠ terminating migration; the residual is the already-established
  individually-justified sub-threshold band, R4-L1's pool-aggregate shape;
  naming fix, the R4-L1/R5-L4 LOW precedent); #4 → **R6-m3** (adopted at
  its filed MINOR — the genuine narrow residual of R5-m2's own fix). The
  GPT-tier pass again produced the round's most substantive items (as in
  rounds 3–5), and its #4 is the round's best catch.
- **gemini-cli (gemini-2.5-pro, CLI 0.25.2): RAN** — verdict:
  **MINOR-ISSUES**, 1 finding: #1 → **R6-L2** (MINOR→LOW: both sites
  already carry the empty-filter conditional; one-clause scope guard).
- Cross-model signal: no finding was externally double-confirmed this
  round (each external found a disjoint set), no external finding named a
  property violation, and every calibration is recorded with its precedent
  class. The externals' verdict LINES (SERIOUS-ISSUES / MINOR-ISSUES) are
  driven by their own severity labels; under the ceremony's calibration
  discipline — severity measured against whether a §0 property, invariant,
  or guarantee breaks, with same-class precedents controlling — zero
  findings survive at MAJOR. The calibrations are the load-bearing claim
  of this verdict and are stated per-finding above for audit.

## Convergence verdict

**CONVERGED.** Round 6 raised **zero CRITICAL and zero MAJOR** findings.
All 8 round-5 findings verified genuinely resolved — including R5-M1, the
round-5 MAJOR, whose decided direction now holds consistently at every
normative site (the fold-regression class was specifically hunted and did
not recur; one archival echo in §18 was marked superseded). All four §0
operator properties hold outright — (d) now including the
structurally-unreadable subagent leg. Both round-2 evasion scenarios, the
multi-session 3-cycle, and the quota-blind attack remain closed under
re-attack; the one genuinely new adversarial shape found this round (the
terminating cohort migration) is individually-justified, multi-brake-bounded
movement and is now a named band. The 3 MINOR + 4 LOW raised this round
were all folded in-round (commit d62c78ff1, disclosed above, §20
disposition in-spec) — **0 MUST-FIX, 0 SHOULD-FIX, 0 LOW outstanding**.
Ceremony trajectory: 6 MAJORs (round 2) → 3 (round 3) → 1 (round 4) → 1
(round 5) → 0 (round 6). The spec is ready for the convergence tag +
approval step (flipping `review-convergence` from `null` is the approval
ceremony's move, recorded in the tag commit, not this report).
