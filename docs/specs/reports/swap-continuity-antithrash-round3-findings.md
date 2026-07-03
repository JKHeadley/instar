# Swap-Continuity Anti-Thrash — Round 3 findings (consolidated)

Round 3 reviewers: 6 internal (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + external passes per available family:
**GPT-tier (RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`; verdict:
SERIOUS-ISSUES, 9 findings)** and **gemini-cli (RAN — gemini-2.5-pro; verdict:
SERIOUS-ISSUES, 2 findings)**. Door honesty: the `codex` CLI binary is NOT
installed on this machine this round (all `detectFrameworkBinary('codex')`
candidate locations empty; only stale `~/.codex` state remains) — the GPT-tier
family was reached through the pi door instead, per the agent's own
component-framework config (`pi-cli: openai-codex/gpt-5.5`). Recorded so the
activation history stays truthful: same model family as round 2's codex pass,
different harness. Round-level cross-model flag: clean — BOTH non-Claude
families succeeded this round (round 2's gemini timeout did not recur).

Standards-Conformance Gate: not re-run as a live-server pass this round; the
round-2 gate's single flag (No Unbounded Loops vs the reactive cascade) was
verified RESOLVED in-text (R2-M6 fold, §3.1 escalate-once + declared
Eternal-Sentinel exemption), and the lessons-aware lens re-checked the
engaged-lessons list (P17/P18/P19/P20/P14/P7/#1001/Bounded-Notification-Surface)
against the revised body.

Spec commit reviewed: 07b46b3f2 (round-3 revision). Reviewable-body hash:
`9692cd1e…`. Deduped across reviewers; external findings folded with
attribution.

Code-grounding re-check (integration lens, this worktree): every newly-cited
primitive is real — `computeHasActiveProcesses(panePid, psOutput)`
(SessionManager.ts:2830, pure), `hasActiveProcessesAsync` forks its own `ps`
and folds indeterminate→true (:2907/:2919/:2924 — matching §4.1's do-NOT-use
rationale), `tmuxExecCoalesced` :623, `isSessionActivelyWorking` :3094
(catch→false, matching §4.1's honesty note), the `void
_quotaAwareScheduler?.onQuotaPressure(...)` reactive-result discard in the
rate-limit listener (server.ts ~15972-15976), the per-swap "Session
respawned." notice with its `options?.silent` gate (server.ts ~1292-1296),
`currentInboundByTopic` set/clear sites (routes.ts ~17199 / ~11346-11352),
sender fields fromUsername/fromFirstName (routes.ts ~17187-17188), the
guardManifest exclusion entry for ProactiveSwapMonitor (guardManifest.ts:860),
`DEV_GATED_FEATURES` (src/core/devGatedFeatures.ts:45),
`maybeRotateJsonlSegment` (jsonl-rotation.ts:128), monitor/scheduler/refresh
line cites all within ±2 lines. No wrong-file/wrong-mechanism claims (one
wording nit → R3-L2).

## Round-2 fold verification (every finding re-checked against the revised body)

**29 of 30 round-2 findings verified GENUINELY RESOLVED in the revised text.**

| finding | verified | notes |
|---|---|---|
| R2-M1 (attribution injection) | ✅ | §4.3(3): attribution fields delimiter-neutralized + clamped ≤64, rendered INSIDE the quoted region; only fixed template text outside; "no unneutralized sender-controlled byte" is normative |
| R2-M2 (breaker restart window) | ✅ | hydration = max(dwell, reversal, breakerBackoff); newest-first segment walk bounded by keepSegments=2; under-primed flag; breakerOpenedAt/breakerDeadline in §6.1; derivation episode-anchored. One residual derivation ambiguity → R3-m1 |
| R2-M3 (N≥3 rotation blind spot) | ❌ **mechanically folded, functionally DEAD** | the frequency detector exists in text but is starved by the spec's own state bounds and cannot open the breaker for a single session — carried forward as **R3-M1 + R3-M2** (the round-2 evasion scenario re-run explicitly below) |
| R2-M4 (subagentIdleLeg default) | ✅ | concrete `false` everywhere (§4.2/§7/§14-Q5), own rung 3a, §0 delivery-honesty note |
| R2-M5 (re-intent backoff pair-keying) | ✅ | backoff + ceiling clock keyed on (session); age carries across target re-selection; re-derived from `dropped` rows. Evasion re-run: drop on A→B, next tick A→C → SESSION is in backoff, no new intent; target rotation cannot evade a session key; a mid-backoff reactive move invalidates via I9 and dwell then covers 45 min. **Genuinely closed.** |
| R2-M6 (cascade P19 + silent foundation) | ✅ | two detection-only episode-deduped triggers (§3.1), Eternal-Sentinel exemption declared, reactive failures write `failed` rows; I6 intact. One wiring-wording nit → R3-m5 |
| R2-m1 | ✅ | "no DEDICATED route" + honest file-viewer note (§6.1) |
| R2-m2 | ✅ | breaker suppression rows get enter/leave/heartbeat keyed on episodeId (§3.1) |
| R2-m3 | ✅ | public tri-state `checkSessionWorkState`; batched path around the real `computeHasActiveProcesses`; per-leg indeterminate; one-ps wiring test (§4.1/§12) |
| R2-m4 | ✅ | ~2 s shared ps snapshot cache at SessionManager level, covering sweeps AND concurrent grace loops (§4.1) |
| R2-m5 | ✅ | I11 + §12 no-route-surfaces-callerClass test |
| R2-m6 | ✅ | streak/backoff/dedupe re-derived from `failed` rows at boot (§3.6) |
| R2-m7 | ✅ | three recovery call sites enumerated + tagged; untagged future caller fails SAFE into refusal (§4.2) |
| R2-m8 | ✅ | respawn notice once per session per swap episode (§4.3) |
| R2-m9 | ✅ | P20 + P7 Tier-0 in lessons-engaged + §4.4 |
| R2-m10 | ✅ | no-regression rationale + `force-capability-scope` follow-up (§4.5) |
| R2-m11 | ✅ | atomic single-line appends; corrupt trailing line tolerated + counted (§3.5) |
| R2-m12 | ✅ | headroom-as-burn-proxy explicit; `burn-aware-targeting` named (§3.3) |
| R2-m13 | ✅ | rung-4 multi-machine caveat + strict-improvement argument (§10) |
| R2-L1..L11 | ✅ all | L1 §6.1 export exclusion · L2 errorClass pinned · L3 dropped-row derivation · L4 `allHotHeartbeatMs` knob · L5 authLevel + proceeded reason · L6 `session-busy` both surfaces · L7 API-only + tile follow-up · L8 §12 migration assertion · L9 Tier 0 declared · L10 eli16 pointer in intro · L11 §2.2 line fixed |

## The R2-M3 evasion scenario, re-run against the revised detectors (the round-3 core check)

Single session S, directed rotation A→B→C→A at the dwell floor, shipped
defaults (`dwellMs` 45 m, `reversalWindowMs` 30 m, `swapFrequencyThreshold` 3,
`swapFrequencyWindowMs` 3 h, `thrashBreakerThreshold` 2):

- t=0: A→B executes (A ≥80, B <65 — passes (a)/(c)). No inversion edge.
- t=45 m: B→C executes. **§3.2 prunes the in-memory index at
  max(dwellMs, reversalWindowMs) = 45 m** — the t=0 entry is aged out at this
  tick. Per-session execution history never holds more than ~2 entries at the
  dwell cadence.
- t=90 m: C→A executes. Executions visible in the index: at most {t45, t90} →
  count 2 < 3. **The frequency detector NEVER fires — not even its
  detection-only increment.** (Seam 1: prune bound excludes the 3 h window.)
- Grant a 3 h-capable index arguendo: increments land at t=90, t=135, t=180 —
  each ≥45 m apart because dwell paces the session's executions. **The breaker
  needs ≥2 increments pool-wide within 30 m; one rotating session can NEVER
  supply them.** (Seam 3: trigger-aggregation arithmetic.) §12's unit test "an
  A→B→C→A rotation MUST open the breaker" cannot pass as specified.
- Any server restart (the sleep/wake crash-loop family the ledger exists for)
  re-derives from a 60 m hydration window (max includes breakerBackoff but NOT
  swapFrequencyWindowMs) → the detector re-arms near-zero every boot. (Seam 2.)

Multi-session wave rotations — the 2026-07-02 incident shape — DO open the
breaker once seams 1–2 are fixed (several sessions crossing the frequency
threshold inside one wave = several increments within minutes). The residual
open hole is exactly the round-2 scenario: one session (dumb luck or an
adversary) rotating across ≥3 accounts, indefinitely, with every detector
green. Harm stays bounded (dwell paces to ~1 kill/45 m; each hop must pass
materially-better; the work gate protects busy sessions) — the same
bounded-harm profile round 2 classed MAJOR.

## MUST-FIX (MAJOR — material; each requires a spec change before build)

- **R3-M1 (adversarial + scalability; confirmed independently by BOTH external
  passes) — The rotation-frequency detector is starved by the spec's own state
  bounds; the R2-M3 fix is inert as specified (§3.2, §3.5, §7).** The §3.2
  in-memory prune bound `max(dwellMs, reversalWindowMs)` = 45 min and the §3.5
  hydration window `max(dwellMs, reversalWindowMs, thrashBreakerBackoffMs)` =
  60 min BOTH exclude `swapFrequencyWindowMs` (3 h) — §3.2 was written in
  round 2 and not updated when §3.5 gained a 3 h-window consumer in round 3.
  At the dwell-paced cadence the detector's per-session history is pruned
  before the third execution ever lands, so the count can never reach the
  threshold; a restart blinds it further. FIX: both bounds become
  `max(dwellMs, reversalWindowMs, thrashBreakerBackoffMs,
  swapFrequencyWindowMs)`; state the (small) index/hydration cost — the
  segment-count bound (keepSegments=2) already caps the boot read, and the
  §3.5 under-primed flag already covers retention shortfall honestly.
- **R3-M2 (adversarial; the TOP finding of both external passes, rated
  CRITICAL under their uncalibrated rubric) — Even when fed, a single-session
  rotation can never OPEN the breaker; §12's rotation test is unimplementable
  from the specified arithmetic (§3.5, §12, §13).** One session's frequency
  increments are ≥`dwellMs` (45 min) apart by construction (dwell paces its
  executions), but the breaker trigger requires ≥2 thrash-counter increments
  pool-wide within `reversalWindowMs` (30 min). §12's "an A→B→C→A rotation
  MUST open the breaker", §13's rotation row ("feeds the breaker at 3
  executions / 3 h"), and §3.5's "the breaker's coverage is the union of the
  three detectors" all overclaim — a faithful builder ships the hole while the
  doc says it is closed, and the §12 test either fails or gets fudged ad hoc.
  FIX (any one, stated normatively): (a) a frequency-threshold crossing OPENS
  the breaker directly (the crossing IS the episode trigger — simplest and
  matches the detector's rationale that 3-in-3h is already the rotation
  signature); (b) frequency-class increments aggregate over their OWN window
  (`swapFrequencyWindowMs`, not `reversalWindowMs`); or (c) a frequency
  increment counts as `thrashBreakerThreshold` votes. Severity calibration:
  classed MAJOR per ceremony precedent (identical bounded-harm profile to
  R2-M3, which was MAJOR; the fix is corrective within the existing structure
  and weakens no §0 property) — the external CRITICAL ratings are recorded
  verbatim in the external-pass section.
- **R3-M3 (decision-completeness + lessons-aware; from GPT-tier external
  finding 5) — Ledger loss silently drops operator property (b) while the
  optimizer keeps running (§13 vs §10).** The §13 failure row for
  "ledger unwritable/corrupt" continues proactive decisions with EVERY
  ledger-derived brake cold: dwell (§0 property (b), one of the four
  non-negotiables), reversal, breaker, frequency, and the re-intent backoff —
  while §10 rung 4 itself declares "a proactive swapper without anti-thrash is
  the bug, not a configuration." The fail direction on state-source loss is an
  undecided decision wearing a failure-mode row. FIX: while the ledger is
  unwritable, PAUSE proactive optimization (refusal reason `ledger-lost`,
  ledger-independent brakes notwithstanding; reactive untouched per I6 — the
  guarantee never depends on the ledger), OR keep continue-cold and argue it
  explicitly against §10's own principle ((a)+(c) remain live since they
  derive from quota snapshots, so 2-cycles stay structurally blocked; what is
  actually lost is dwell + rotation coverage). Either is acceptable; the spec
  must pick one on the record.

## SHOULD-FIX (MINOR)

- **R3-m1 (adversarial; from GPT-tier external finding 4) — `episodeId` is
  overloaded across three episode kinds and the breaker boot derivation can
  anchor on the wrong kind (§3.5, §6.1).** All-hot episodes, thrash-breaker
  episodes, and per-session failure-streak episodes all stamp `episodeId`;
  the derivation rule "the most-recent episodeId-stamped row of ANY decision
  kind" does not say what happens when that row carries no
  `breakerOpenedAt`/`breakerDeadline` (a failure-streak `failed` row, an
  all-hot `refused` row). One literal reading boots the breaker CLOSED early —
  re-opening the exact R2-M2 window this revision closed. FIX: scope the
  derivation to rows CARRYING `breakerDeadline`, or add an `episodeKind`
  discriminator to §6.1.
- **R3-m2 (decision-completeness) — the §3.5 "open-marker row written at
  episode open" has no decision kind in the §6.1 enum.** Say which existing
  kind carries the open marker (the increment row that tripped the threshold —
  an executed `swapped` row for pair-level/frequency detection, a `refused`
  row for same-session reversal) or add the kind to the schema; a builder
  currently has to invent one.
- **R3-m3 (adversarial; from GPT-tier external finding 6, downgraded with
  rationale) — sub-tick source-account race between a completed reactive swap
  and an approved proactive execution (§3.3, §4.2).** I9 invalidation runs at
  retry TICKS and §3.3 execute-time revalidation covers only the TARGET; a
  reactive swap that COMPLETES between the pipeline pass and the execute call
  lets a proactive intent land a second kill on a just-rescued session (the
  in-flight refresh guard serializes only CONCURRENT refreshes — round 2's
  clean probe covered that case, not this one). FIX: one sentence — execute
  revalidates `session's current account == intent.from` pre-kill, refusing
  `intent-stale`. Downgrade rationale: sub-tick window, requires
  reactive+proactive coincidence on one session, cost is one bounded extra
  kill, and the work gate still protects busy sessions.
- **R3-m4 (security; raised by BOTH external passes) — the killed-subagent
  list's `agentType` strings enter the followUpPrompt outside the §4.3(3)
  neutralization rule.** In practice `agentType` is a host-constrained
  identifier (SubagentTracker records the Agent-tool type), but the payload
  rule says "no unneutralized sender-controlled byte" while leaving
  subagent-list fields un-covered by the neutralize+clamp discipline. One
  sentence extends the same rule to every non-fixed field in the mitigation
  payload (the ≤10-entry clamp already exists).
- **R3-m5 (lessons-aware) — §3.1's fix-alongside sentence wires reactive
  execution failures to "trigger (2)'s escalation", but trigger (2) is the
  rate-cap refusal.** A respawner throw / `refreshFn` false is not a rate-cap
  refusal; the escalation channel for repeated reactive execution failures is
  unnamed. Either scope the sentence to failures that ARE rate-cap refusals,
  or name the channel (a reactive analog of §3.6's streak escalation, derived
  from `failed` rows — detection-only, I6-safe).

## LOW

- **R3-L1** — §4.1 `busy()` pseudocode maps missing `claudeSessionId` →
  `'indeterminate'` on the subagent leg while I7 and §6.1 call that state
  `'absent'`; pin the mapping (absent = leg structurally unavailable;
  indeterminate = probe attempted and failed).
- **R3-L2** — §3.1 cites "`refreshFn`'s `false` return is discarded (`void`,
  server.ts:15974)"; the actual seam is the rate-limit listener discarding the
  whole `onQuotaPressure` RESULT promise (`void _quotaAwareScheduler?.
  onQuotaPressure(...)`) — `refreshFn`'s false folds into that discarded
  result. Substance correct; fix the mechanism wording.
- **R3-L3** — §4.2's re-intent backoff "for `dwellMs` (default)" implies a
  knob but names none; either name it (`reIntentBackoffMs`) or state it is
  fixed to dwellMs (knob-completeness consistency with R2-L4's fix).
- **R3-L4 (from GPT-tier external finding 9)** — the fixed mitigation
  template's "answer it first" phrasing: add one normative sentence that the
  quoted block is user CONTENT to be answered as user content, never
  operational-instruction priority (the "a message from the quoted sender
  below awaits an answer" framing already implies it; make it explicit).

## Detector-probe results that came back CLEAN (adversarial)

R2-M5 evasion re-run (target rotation vs session-keyed backoff — closed, see
fold table); forced-landing via explicit `targetAccountId` (revalidation
enforces the ceiling; a hostile internal caller can only land on a target the
brakes would pick anyway, and I11 keeps the field off the wire); breaker-DoS
(deliberately opening the breaker only suppresses the OPTIMIZATION — the
failure direction the operator demanded); deferral rate-budget starvation
(gate-before-rate-guard: deferrals consume zero budget); frequency-detector
false-positive sweep (two sessions legitimately crossing 3-in-3h within 30 min
opens the breaker — errs toward stay-put, the demanded direction); all-hot
heartbeat vs breaker-row double-write (pipeline order: breaker evaluates
first; episodes write one row family at a time); §7.1 liveness of the four new
knobs (covered by the existing "antiThrash.* numeric knobs — live per tick"
row).

## External pass status

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (the codex CLI
  binary is not installed on this machine; the pi door reaches the same
  family, per the agent's own component-framework routing). Verdict:
  **SERIOUS-ISSUES**, 9 findings: #1/#2/#3 = R3-M1/R3-M2 (it rated the
  detector arithmetic CRITICAL×2 + MAJOR), #4 → R3-m1, #5 → R3-M3, #6 →
  R3-m3, #7 → R3-m4, #8 folds into R3-M1's retention note, #9 → R3-L4.
- **gemini-cli (gemini-2.5-pro): RAN** — verdict: **SERIOUS-ISSUES**, 2
  findings: #1 = the R3-M2 arithmetic (rated CRITICAL; its derivation matches
  the internal scenario re-run step for step), #2 → R3-m4. Round 2's timeout
  did not recur; the Gemini family has now fully reviewed this lineage.
- Cross-model signal: both non-Claude families independently converged on the
  same top finding (single-session rotation defeats the breaker arithmetic) —
  the strongest external corroboration this ceremony has produced.

## Convergence verdict

**NOT CONVERGED.** Round 3 surfaced **3 MAJOR findings** (R3-M1..M3 — zero
CRITICALs under the ceremony's calibration; both externals rated the headline
arithmetic hole CRITICAL under their own rubric, recorded verbatim above),
plus 5 MINOR and 4 LOW. 29/30 round-2 findings verified genuinely folded — the
single exception is R2-M3, whose fix is present in text but provably inert
under the spec's own numbers: the §3.2 prune bound and §3.5 hydration window
both exclude the new 3 h frequency window (so the detector starves), and the
increment→breaker aggregation arithmetic cannot connect for a single rotating
session (so §12's rotation test is unimplementable). The design's shape
remains intact — all four §0 operator properties held again, no reviewer
proposed weakening any of them, and every MAJOR fix is a bounded correction
within the existing structure (two window-formula edits + one trigger-semantics
choice + one fail-direction decision). Round 4 required: fold R3-M1..M3 (+ the
cheap minors) into a round-4 revision, then re-run the full round — externals
mandatory (the reviewable body will change), and the §12 rotation test must be
re-derived from the corrected arithmetic before it is trusted as the proof
obligation.
