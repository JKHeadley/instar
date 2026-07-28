# Swap-Continuity Anti-Thrash — Round 5 findings (consolidated)

Round 5 reviewers: internal (security, adversarial, integration,
decision-completeness, fail-direction, lessons-aware lenses) + external passes
per available family: **GPT-tier (RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`;
verdict: SERIOUS-ISSUES, 4 findings)** and **gemini-cli (RAN —
gemini-2.5-pro; verdict: SERIOUS-ISSUES, 2 findings)**. Door honesty: the
`codex` CLI binary remains NOT installed on this machine (`which codex`
empty); the GPT-tier family was reached through the pi door, same as rounds
3–4. Both non-Claude families completed within the timeout.

Spec commit reviewed: 2bcf4ed09 (round-5 revision). Reviewable-body hash:
`2e170e604e0c…`. Deduped across reviewers; external findings folded with
attribution and calibration (two external MAJORs calibrated down with the
rationale recorded — never silently; one external MAJOR adopted and
RE-grounded on a contradiction the external did not name).

Code-grounding re-check (integration lens, this worktree): the round-5
revision's NEW code claims were verified against source before this review —
`bindingUtilization` returns 0 on no reading with the "unknown = treated as
empty / still selectable" comment (QuotaAwareScheduler.ts:44-57), enrollment
`lastQuota: null` (SubscriptionPool.add(), SubscriptionPool.ts:323), the
failed-poll freeze (`if (!snap) { failed++; continue; }` —
QuotaPoller.pollAll, no update on failure), `measuredAt` on the snapshot
(SubscriptionPool.ts:89) with no selection-side reader, the poller default
cadence (`pollIntervalMs ?? 15 * 60_000`, QuotaPoller.ts:236), and the
monitor's existing `triggerPoll` hook firing `pollAll` when any account is in
the watch zone (ProactiveSwapMonitor.ts:191-198, wired at server.ts
`triggerPoll: () => quotaPoller.pollAll()`). All cites in the new §3.3
bound-0 text are accurate. One wiring note recorded for the §12 build audit:
`quotaPoller.start()` is gated on `subscriptionPool.size() > 0` AT BOOT
(server.ts) — a pool populated after boot has no background poller until
restart; bound 0 makes this SAFE (everything unmeasured ⇒ proactive refuses)
where the pre-round-5 design made it blind, but the measurement-blind
surfacing must not assume the poller loop is running (folded into R5-m1).

## Round-4 fold verification (every finding re-checked against the revised body + code)

**9 of 9 round-4 findings verified GENUINELY RESOLVED** — with one fold
(R4-m3) introducing a NEW seam that is this round's MAJOR (see R5-M1; the
finding's prescribed fix was applied faithfully, and the application made a
pre-existing adjacent sentence false).

| finding | verified | notes |
|---|---|---|
| R4-M1 (absent/stale quota reading fails toward MORE swapping) | ✅ | Bound 0 is normative in §3.3 (reading PRESENT and ≤ `quotaFreshnessMs`, default 30 min = 2× the real 15-min poll cadence — verified against QuotaPoller.ts:236), on BOTH legs (target eligibility AND source candidacy; the stale-hot source exclusion stated). Unmeasured/stale counts toward all-hot (§3.1 "measures is load-bearing" pin; I2 amended). Refusal `target-unmeasured` split from `all-hot` with state-transition row treatment (§3.1, §6.1 transition cell, §6.2 enum). Execute-time revalidation re-checks bound 0 (§3.3 check 1). Reactive untouched — verified the primitive keeps unknown-selectable byte-for-byte (I6, I13). §13's stale-data row corrected to bounded poll-lag + two new failure-mode rows (ABSENT, STALE). `quotaFreshnessMs` in §7 with the liveness table covering it; §12 tests pin both sides of every boundary incl. the enrollment-day flip and the reactive no-change. Attack re-run below confirms the pile-on is closed. |
| R4-m1 (I5 exception inaccurate during outage; index-on-failed-append unspecified) | ✅ | §3.5 carve-out (1b): non-refusal decisions during an unwritable episode UPDATE the in-memory index regardless of append failure and are counted (`rowsLostWhileDown`, §6.3 ledger block); I5 re-worded as the outage CLASS (refusals counter-only; executed/proceeded index-primed + counted; durable trace = the episode's one item); §12 test pins the post-resume dwell refusal; §13 UNWRITABLE row updated. Residual across a RESTART is real and stated in-body — but one clause of the statement is false (R5-m3). |
| R4-m2 (T1 continuation undefined — hourly drip; half-open implicit) | ✅ | Continuation generalized over both tiers by trigger signature (§3.5): T2 same-session within `swapFrequencyWindowMs` of close; T1 same unordered account pair within `reversalWindowMs` of close; same `episodeId`, extended deadline via the continuation row's new `breakerDeadline` (boot anchor stays consistent); half-open pinned = closed-with-continuation-memory, no third persisted state. §6.4 + §12 updated. The T1 drip scenario re-run: sustained inversion re-opens ~6 min after each half-open, same pair, well inside 30 min ⇒ continuation, one item. Residuals: restart-proofness of the continuation memory itself (R5-m2) and a lookup-ambiguity nit (R5-L3). |
| R4-m3 (I7 both-legs ambiguity; `\|\|` undefined over tri-states) | ✅* | The any-leg rule is normative in §4.1 (idle ONLY when every READABLE leg affirmatively reports idle; the mixed case decided in-text: footer indeterminate + subagent false ⇒ BUSY), the `\|\|` is defined over the tri-state, I7 restated, §12 matrix rows added. The finding AS FILED is resolved. *However the fold introduced R5-M1: the round-4 report's own prescribed fix ("'absent' excluded per the R3-L1 pin") contradicts the R3-L1 pin sentence it cites — see below. |
| R4-m4 (execute-time revalidation misses fresh source-pressure/improvement) | ✅ | §3.3's revalidation is an enumerated 4-check list (target validity+ceiling / source identity / source pressure fresh / improvement delta fresh) with per-arm refusal reasons; §12 pins each at the execute call. The sub-tick seam is closed. |
| R4-L1 (evasion band unnamed) | ✅ | Named in §3.5 with the formula, the ~90-min figure, and the soak-interpretation sentence. |
| R4-L2 (cross-knob coherence) | ✅ | Two warn-only config-load checks in §7 (dwell-disarms-T2; freshness-below-poll-cadence), each with the fail-direction stated; §12 pins one warning each. |
| R4-L3 (hydration × disabled-at-boot unstated) | ✅ | §3.5 read path: loads + hydrates unconditionally; reactive rows append regardless; warm at a mid-run flip; §12 test. |
| R4-L4 (revalidation-refusal row volume) | ✅ | Accepted-bound arm taken: worst case stated (~20 rows/h/session, self-limiting via the next tick's own filter), extension named as purely-additive later. |

## The standing attack scenarios, re-run against the round-5 design

**R2-M3 (A→B→C→A directed rotation), shipped defaults, both breaker tiers:**
unchanged arithmetic, still caught — retention/hydration ⊇ the 3 h frequency
window (§3.2's one formula, all four cite sites still agree); hop 3 at t=90 m
crosses `swapFrequencyThreshold` and opens the breaker DIRECTLY (T2); hop 4
suppressed. Bound 0 only ADDS a requirement to each hop (fresh readings on
both legs), so the attack has strictly fewer executions available. Restart
between hops 2 and 3 still re-primes (3 h hydration ⊇ the window). T1 arm:
2 inversion-class increments inside 30 min still opens. **CAUGHT — both
tiers.**

**R2-M5 (target rotation vs re-intent backoff):** session-keyed backoff +
episode-carried ceiling clock unchanged by this round. **STILL CLOSED.**

**Multi-session directed 3-cycle:** previously CLEAN "modulo R4-M1 — this
argument assumes the readings are real." Bound 0 makes the assumption a
requirement: every leg now needs a present, fresh reading, so the
non-decaying-utilization arithmetic that blocks the closing leg runs on real
data. **CLEAN, caveat discharged.**

**The quota-blind-account attack (R4-M1's scenario) vs the round-5 fix:**

- *Fresh enrollment (`lastQuota: null`):* fails bound 0 → excluded from the
  FILTER → cannot be a target; counts toward all-hot (no brake stand-down);
  never a source (measures 0). Execute-time check 1 re-verifies. A deferred
  intent's retry re-runs the full pipeline (§4.2). **CLOSED at every layer.**
- *Poll-broken frozen account (stale snapshot):* reading present but
  `measuredAt` beyond the bound → same exclusion, both legs — a frozen-cool
  value can no longer attract sessions, a frozen-hot value can no longer
  nominate kills. **CLOSED.**
- *Enrollment-day (the mandated probe — a HEALTHY new account with no
  reading yet):* the design says what happens: proactive-ineligible until the
  first reading lands; `pollAll` covers every non-disabled claude-code
  account each 15-min interval, and the monitor's `triggerPoll` fires a fresh
  poll each tick whenever any account is near the watch zone — i.e. exactly
  when a hot pool wants targets — so a healthy new account is measured
  within ≤1 poll interval, typically within one 3-min tick under pressure.
  **No permanent exile**: only an account whose polls KEEP FAILING stays
  unmeasured, which is the honest state (broken seat auth), visible via
  `target-unmeasured` counters + `needs-reauth` + the `quotaValidity` status
  block. Once measured (a real ~0% reading), the account becomes eligible
  LEGITIMATELY — the residual first-reading pile-on is bounded by the
  1-per-target-per-tick cap plus the per-tick `triggerPoll` refresh under
  pressure and the 15-point headroom budget (R5-L4 names it so a soak reads
  it correctly). **The design answers the enrollment-day case; the answer is
  bounded.**

**The four operator properties:**

- **(a) all-hot ⇒ stay put:** HOLDS — and now holds on MEASUREMENTS: an
  unmeasured/stale alternate counts hot instead of reading as the coolest
  account in the pool (the round-4 vacuity is closed; I2 amended).
- **(b) per-session dwell, restart-safe:** HOLDS; outage index-priming
  (R4-m1 fold) strengthens the live-outage case. One bounded residual across
  outage+restart remains and is stated in-body (R5-m3 — the statement needs
  one correction).
- **(c) destination materially better:** HOLDS, and is now verified at the
  actual kill point (4-check execute-time revalidation) on valid, fresh
  readings only.
- **(d) never swap while work is in flight:** HOLDS on every path with a
  readable subagent leg — but the round-5 body carries a normative
  CONTRADICTION about the structurally-unreadable leg, and one of the two
  readings violates (d) unmitigated (R5-M1). Until that is decided, (d) is
  not fully proven for id-less sessions.

## MUST-FIX (MAJOR — material; requires a spec change before build)

- **R5-M1 (from GPT-tier #1, adopted and re-grounded; the contradiction arm
  is new-in-round-5) — The `absent` subagent-leg direction is normatively
  CONTRADICTED in-body, and the §4.1 reading kills live subagents blind and
  unmitigated (§4.1 line ~857 vs ~873, I7, §4.3).** The R4-m3 fold changed
  proactive-caller resolution to any-leg-busy but kept `'absent'` excluded
  ("the remaining readable leg decides alone"), exactly as the round-4
  report prescribed — while the pre-existing R3-L1 state-name pin three
  paragraphs earlier still says "`absent` … and `indeterminate` … resolve
  identically for decision purposes (I7)". In round 4 both sentences were
  consistent (under the old both-legs rule, one non-working leg never made
  busy, so absent and indeterminate did resolve identically); after the
  round-5 change they prescribe OPPOSITE decisions for the same input: pin
  reading → absent behaves like indeterminate → any-leg rule → BUSY;
  §4.1/I7 reading → footer decides alone. A coin-flip builder. And the
  §4.1/I7 reading is materially unsafe for exactly the class this feature
  was built to protect (GPT-tier's scenario): a session whose
  `stateSession.claudeSessionId` is missing/stale (spawn-migration,
  transcript-recovery, state-write-gap windows) while background subagents
  run behind an idle prompt — the F3 blind spot — is declared idle by the
  footer leg and killed by an optimization; worse, the §4.3 mitigation
  cannot fire either, because enumeration is
  `getActiveSubagents(claudeSessionId)` — **the mitigation is blind exactly
  when the gate is**, so the kill is both unprotected AND unenumerated
  (property (d) and the F3 payload defeated together; the spec's only
  defense today is "the blind spot is measurable"). FIX (small, must be
  decided-not-implied): (1) resolve the contradiction by DECIDING the
  direction — recommended per I7's own philosophy ("a wrong busy costs a
  delayed optimization"): for OPTIMIZATION-CLASS callers an `'absent'`
  subagent leg resolves BUSY (defer → ceiling → drop; cost is proactive
  exile of id-less sessions, a missed optimization, bounded and visible via
  the `subagentLeg: 'absent'` counters — a chronic-absence signal is the
  named observability follow-up); interactive-refresh keeps refusal +
  `force` (human in the loop), reactive keeps grace-then-proceed (bounded,
  the rescue must not strand); (2) rewrite the R3-L1 pin sentence to match
  the decided rule (the identical-resolution claim is now false by
  construction); (3) state the mitigation-blindness honestly in §4.3 (when
  `claudeSessionId` is absent at a forced kill, the payload says so —
  "subagent state unreadable at kill time" — never an implicit empty list).

## SHOULD-FIX (MINOR)

- **R5-m1 (internal fail-direction lens; independently found by GPT-tier #4)
  — The `measurement-blind` surfacing is candidacy-dependent, so WHOLE-POOL
  blindness — the loudest case — is silent (§3.3, I13).** The trigger is
  defined on "the ENTIRE alternate set … validity-excluded", which is only
  OBSERVED inside a candidate evaluation; but when the poller dies, every
  SOURCE reading also goes stale within `quotaFreshnessMs`, stale sources
  are excluded from candidacy, no evaluation runs, no `target-unmeasured`
  rows are written, and the measurement-blind item never fires. The pause
  direction is SAFE (zero proactive swaps — strictly better than the
  pre-round-5 blind optimizer), but I13's "effectively paused **and says
  so**" overclaims. Also folds the wiring note above: `quotaPoller.start()`
  is boot-gated on a non-empty pool, so a pool populated post-boot has no
  background poll loop — the surfacing must detect "zero fresh readings"
  without assuming the poller runs. FIX (two sentences): evaluate the
  measurement-blind condition per monitor tick over the POOL ITSELF (zero
  accounts carry a fresh reading, `proactiveSwap` enabled) — independent of
  candidacy; keep the one-item episode dedupe.
- **R5-m2 (from GPT-tier #2, calibrated MAJOR→MINOR) — episode CONTINUATION
  memory is not restart-proof; a restart inside the continuation window
  re-alerts once for a sustained pathology (§3.5, §3.2).** T2's continuation
  window extends to close + `swapFrequencyWindowMs` = up to 4 h after the
  open row at shipped defaults, but `retentionBoundMs` = 3 h and the §3.5
  boot derivation re-derives only the OPEN/closed breaker state (rows
  carrying `breakerDeadline` whose deadline has not elapsed) — never the
  closed-with-continuation-memory state. Restart at t=3.5 h after an
  episode that closed at t=1 h: the open row is out of the hydration
  window, continuation memory is gone, and the same session's re-cross at
  t=3.9 h mints a new `episodeId` + a second attention item. Calibration
  (same class as R4-m2, which was MINOR): alert hygiene only — one extra
  item per restart×sustained-pathology conjunction, erring toward MORE
  alerting during a state that warrants attention; every brake property
  holds. FIX: give the episode CLOSE row (the suppression `leave` row) the
  trigger SIGNATURE, extend the retention formula's max() with
  `thrashBreakerBackoffMs + max(reversalWindowMs, swapFrequencyWindowMs)`
  (the ONE-formula discipline §3.2 already demands absorbs the new term —
  a builder must not hand-tune two bounds), and have hydration re-derive
  continuation memory from the most-recent close row inside the window.
- **R5-m3 (from GPT-tier #3 AND gemini #1 — externally double-confirmed,
  both rated MAJOR; calibrated MINOR with the rationale recorded) — the
  outage+restart conjunction re-opens a bounded premature-re-swap window,
  and the round-5 body's claim that "the boot flags UNDER-PRIMED as usual"
  is FALSE (§3.5 carve-out 1b).** Scenario (both externals): ledger
  unwritable → reactive swap primes dwell in memory only → server restarts
  → ledger writable at boot → proactive resumes with dwell cold for the
  outage-rescued session → one premature proactive swap can execute.
  Calibration to MINOR, argued: the harm is bounded to ONE premature swap
  per affected session per outage×restart conjunction; that swap must
  still pass every other brake (all-hot, bound 0, both §3.3 bounds,
  breaker) AND the §4 work gate (in-flight work still cannot be killed);
  it is the same magnitude as §9's explicitly-accepted cold-start class —
  this is the recorded bounded-cold vs unbounded-cold split (round 4
  declined the same escalation for under-primed hydration, and no new
  failure math widens the bound here). What is NOT acceptable is the false
  sentence: the under-primed flag as defined (§3.5 read path — retention
  cannot cover the window) does NOT detect a mid-window row gap, so the
  spec currently claims a detection that cannot happen — the exact
  safe-direction-overclaim class R4-M1's §13 correction just removed. FIX:
  (1) delete/correct the "flags UNDER-PRIMED as usual" clause — state the
  honest bound instead; (2) cheap durable breadcrumb: the level-triggered
  RESUME's first successful append writes an outage-summary row
  (`rowsLostWhileDown`, span) — the gap becomes boot-visible and
  soak-auditable; (3) optional hardening, builder's choice: a conservative
  post-outage boot grace (treat sessions as dwell-covered for one dwellMs
  after an outage-summary row younger than dwellMs) — named, not mandated.

## LOW

- **R5-L1 (internal)** — Freshness-boundary flapping: a reading hovering at
  the `quotaFreshnessMs` edge (partially-degraded poller) flips an account
  eligible/ineligible per tick, emitting `target-unmeasured` enter/leave row
  pairs per flap. Bounded (2 rows/candidate/tick worst case, the R4-L4
  volume class; `triggerPoll` under pressure keeps readings fresh in
  practice). Name it, or add freshness hysteresis as a purely-additive
  refinement.
- **R5-L2 (internal)** — §3.1/§3.3's "excluded by the validity gate ALONE"
  wording: the paired all-hot definition ("every alternate carried a valid
  reading at/above the ceiling") disambiguates, but "alone" invites a
  misreading in which a pool of stale-frozen-hot alternates classifies as
  `all-hot` from invalid data. One clause: `all-hot` iff every alternate has
  a VALID reading at/above the ceiling; otherwise `target-unmeasured`
  (regardless of frozen values).
- **R5-L3 (from gemini #2, calibrated MINOR→LOW)** — T1 continuation lookup
  ambiguity: "within `reversalWindowMs` of the PREVIOUS episode's close"
  could be read as most-recent-episode-of-ANY-signature rather than
  most-recent WITH THE SAME signature; the wrong reading loses a
  continuation (one extra item — errs toward alerting, never toward silence
  or kills). One clause: continuation matches against the most recent
  episode WITH THE SAME TRIGGER SIGNATURE.
- **R5-L4 (internal, observation)** — First-reading pile-on: once a new
  account's first real reading lands (~0%), it legitimately attracts up to
  1 executed swap per tick until its reading reflects the landed burn —
  bounded by the per-tick `triggerPoll` refresh under pressure, the
  15-point headroom budget, and dwell on each moved session; the
  `burn-aware-targeting` named refinement is the eventual smoothing. Named
  so a soak showing a brief cluster of swaps onto a fresh account is read
  as the bounded case, not a regression.

## Detector-probe results that came back CLEAN (adversarial)

Quota-blind pile-on (all three variants above — closed at filter,
all-hot accounting, and execute-time); enrollment-day exile probe (no
permanent exile; poll-cadence + triggerPoll self-heal verified in code);
"fresh-but-frozen" forgery probe (a successful poll always writes a real
snapshot with a new `measuredAt`; a parse failure is a failed poll → stale →
excluded — no path keeps a frozen value fresh); R2-M3 both tiers + restart;
R2-M5; multi-session 3-cycle (caveat discharged); T1 sustained-thrash drip
(continuation catches it — modulo the R5-m2 restart conjunction); breaker
re-open-while-open impossibility (suppression prevents executions, so no
frequency crossing can occur mid-open; T1 increments during open cannot
re-open an open breaker); all-legs-`absent` vacuous-idle probe (impossible
by construction — the footer probe always returns
working/idle/indeterminate, never absent); §6.1 schema × §6.2 enum
cross-check including the new `target-unmeasured` reason and
`measurement-blind` episodeKind (pairing rule intact: breakerOpenedAt/
breakerDeadline iff thrash-breaker); §7.1 liveness coverage of
`quotaFreshnessMs` (inside `antiThrash.*` — live per tick); the R4-L2
warnings' fail directions (both warn-only, both fail safe); dry-run ×
bound-0 interplay (would-refuse counters only, consistent with every other
brake).

## External pass status (with calibration + refutations)

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary not
  installed; same door as rounds 3–4). Verdict: **SERIOUS-ISSUES**, 4
  findings, calibrated: #1 → **R5-M1** (adopted MAJOR; re-grounded on the
  in-body contradiction the external did not name — the pin sentence at
  §4.1:857 vs the exclusion rule at :873 — plus its own
  mitigation-also-blind observation, which is what elevates the id-less
  kill from "measurable blind spot" to "unmitigated (d) violation");
  #2 → **R5-m2** (MAJOR→MINOR: alert-hygiene-only, the R4-m2 class; every
  brake property holds; fix is a retention-term + close-row signature);
  #3 → **R5-m3** (MAJOR→MINOR, rationale recorded in the finding — bounded
  to one gate-protected swap per conjunction, the recorded bounded-cold
  class; the false under-primed clause is the part that must change);
  #4 → **R5-m1** (independent corroboration of the internal
  measurement-blind-is-candidacy-dependent finding).
- **gemini-cli (gemini-2.5-pro): RAN** — verdict: **SERIOUS-ISSUES**, 2
  findings: #1 → **R5-m3** (same scenario as GPT-tier #3, independently —
  the round's one externally double-confirmed finding; calibrated together);
  #2 → **R5-L3** (MINOR→LOW: the wrong reading errs toward one extra alert,
  never toward suppression; one-clause fix). No internally-inconsistent
  verdict line this round.
- Cross-model signal: the outage+restart residual (R5-m3) is the round's
  double-confirmed finding — both externals rated it MAJOR; the calibration
  to MINOR is recorded with its bounded-cold rationale rather than adopted
  silently, and the false-sentence correction it demands is mandatory
  regardless of severity label. The GPT-tier pass again produced the
  round's headline (as in rounds 3–4).

## Convergence verdict

**NOT CONVERGED.** Round 5 surfaced **1 MAJOR finding** (R5-M1 — the
`absent` subagent-leg direction is normatively contradicted in-body, and one
reading is an unmitigated property-(d) violation for id-less sessions; the
contradiction was INTRODUCED by the round-5 application of round-4's own
prescribed R4-m3 fix — a regression-of-the-fix, not a surviving round-4
seam), plus **3 MINOR and 4 LOW**. All 9 round-4 findings verified genuinely
folded — including the round-4 headline: the quota-blind-account attack is
closed at every layer under re-attack, the enrollment-day case is answered
and bounded, and no permanent exile of a healthy account exists. Both
round-2 evasion scenarios and the multi-session 3-cycle remain closed (the
3-cycle's readings-are-real caveat is discharged by bound 0). Properties
(a)/(b)/(c) hold outright; (d) holds on every readable-leg path and is
pending the R5-M1 decision for the structurally-unreadable leg. The fix is
one decided sentence + one corrected sentence + one honesty line in §4.3 —
the smallest MAJOR of the ceremony so far, and the trajectory's shape is
intact: 6 MAJORs (round 2) → 3 (round 3) → 1 (round 4) → 1 (round 5, a
fold-regression rather than a design hole). Round 6 required: fold R5-M1
(+ the three minors and the two mandatory wording corrections in R5-m3/L2)
into a round-6 revision, then re-run — externals mandatory (the reviewable
body will change).
