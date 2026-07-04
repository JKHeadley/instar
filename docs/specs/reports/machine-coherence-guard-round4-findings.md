# Round 4 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (round-4 revision, commit
4cd0faa07, worktree branch `echo/machine-coherence-guard` at v1.3.728).
Round-4 charter: RE-EXECUTE the round-3 walks against the round-4 text (the
round-3 lesson: textual folds can carry their own seams — only walk
re-execution counts), then fresh-eyes over the round-4 material.

Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware — each grounded against real source) +
2 external cross-model passes (`gpt-5.5` via the `pi` CLI's openai-codex
provider — codex CLI not installed, noted honestly, same as rounds 1–3;
`gemini-2.5-pro` via the gemini CLI — clean single-shot) + the
Standards-Conformance Gate.

Standards-Conformance Gate: **ran (0 flags)** — 51 standards, zero findings;
fit verdict: **fit**.

External verdicts: pi/gpt-5.5 **CONVERGED (0/0/0/0)** — all 23 round-3 folds
verified FOLD-OK, including R3-M1, the fold it had failed in both prior
rounds; gemini-2.5-pro **CONVERGED (0/0/0/0)** — all 23 folds OK. Recorded
honestly (the round-3 pattern repeats): both externals pass while internal
walk re-execution finds material seams — the walks are the authority; the
externals confirm the PROSE resolves what was asked, the walks decide whether
the MECHANISMS survive execution.

**VERDICT: NOT CONVERGED — 0 CRITICAL, 2 MAJOR, 7 MINOR, 8 LOW.**
(Trajectory: 3C+12M → 0C+3M → 0C+6M → 0C+2M. ALL 23 round-3 findings held
as FOLD-OK under walk re-execution by every reviewer assigned to them —
including all three of round 3's failed-walk folds (R3-M2 raise-silent
subtraction, R3-M3 blind-side suspension, R3-M4 truncation direction) and
the twice-failed fix-flow fold (R3-M1), now verified end-to-end buildable by
the decision-completeness lens itself. Both round-4 MAJORs are NEW findings
against round-4 material, both on interaction seams of the folds, both
one-to-three-sentence pinnable with panel-agreed fix directions.)

## Fold verification (all 23 re-executed walks)

| Round-3 finding | Verdict | Verified by |
|---|---|---|
| R3-M1 (fix flow: both cases + body match + acceptance honesty) | FOLD-OK | decision-completeness (build-it-now, both cases, "no stop-and-ask on the core flow"), security, lessons (S>W: the HOLD is structure — durable pendingFix + bounded window + loud failure), integration (implementable with only what exists), pi, gemini |
| R3-M2 (raise-silent definition) | FOLD-OK | adversarial (3-machine walk: only the elected raiser is subtractable — empty-set and dual-raise readings both dead; cascade + clock-skew + recovery converge), pi, gemini |
| R3-M3 (blind-side suspension) | FOLD-OK | adversarial (blind side suspends quiet, reconciles on heal; bidirectional → two quiet items, converge), pi, gemini |
| R3-M4 (truncation fails toward raising) | FOLD-OK | adversarial + security (zero-knowledge forged suppression DEAD; 67 < 72 clamp bound verified; loud cannot-verify), scalability (arithmetic: one-row-per-(dimension,key) identity defeats the pairwise-split concern), pi, gemini |
| R3-M5 (per-episode append budget) | FOLD-OK | adversarial (worst combined flap ≈ 6+1 appends), lessons (overnight M5 walk: ~7 appends then flat), pi, gemini |
| R3-M6 (pendingFix lifecycle) | FOLD-OK | decision-completeness, adversarial (with the two residuals below), pi, gemini |
| R3-N1..N12, R3-L1..L5 | FOLD-OK (17/17) | assigned lenses + both externals; grounding: every new round-4 citation verified true in source (writeConfigAtomic real + verbatim-accurate; PATCH /config genuinely non-atomic; GUARD-POSTURE-ENDPOINT-SPEC §2.5 documents exactly the cited 2026-06-11 incident; the 4-of-7 registry-bound field claim exact) |

## CRITICAL

*(none)*

## MAJOR

**R4-M1 — Dead-adapter phantom marker: the alarm marker keys on episode-OPEN,
not on item-RAISED, so a live-evaluator/dead-adapter raiser advertises
coverage for an item that never reached the operator — defeating the exact
fault the fallback claims to close.** (adversarial R4-1) §3.2/§3.4. §3.4
names "attention/Telegram adapter is dead" as a fault the fallback closes —
but the marker is emitted iff the machine "holds an OPEN local item …
recomputed from local episode state / reads the retained episode file", and
the episode opens on skew CONFIRMATION (§4.1), BEFORE `createAttentionItem`;
the advert ships over the mesh, not Telegram. A machine with a live evaluator
and a dead adapter confirms → opens the episode → advertises a covering
marker → standbys treat the rows as covered and stand down → the operator
gets nothing. The wedged-EVALUATOR fault is closed (no confirm → no marker);
the dead-ADAPTER fault is not — a §0(a) silence through an unpinned
marker-vs-item coupling. Fix direction: the marker keys on
`createAttentionItem` SUCCESS — the episode file records an explicit
item-raised flag (distinct from episode-open) and marker emission reads THAT;
a machine whose raise failed advertises no covering marker, so the fallback
fires and a standby raises through its own live adapter. (The §4.6
dark-guard case still advertises: its item WAS raised before the disable —
the flag is set; R3-N3 is preserved.)

**R4-M2 — Mid-verify suspension is an unpinned collision between two folded
rules on the sole actuation path.** (decision-completeness R4-1 MAJOR;
adversarial R4-3 MINOR is the surfacing half of the same rule) §4.2.1/§4.3.
A divergent==raiser fix EXECUTES (write + restart done — a durable
side-effect); the verify window counts `fixVerifyTicks` from the first
post-restart beat; then the canonical common case fires — a skew participant
sleeps or degrades — and §4.3 suspension triggers. R3-M6 says "suspension
invalidates pendingFix"; §4.3's paused-clock list (resolve-ticks, escalation)
omits the fixVerify clock; (v)'s failure append is wall-clock-shaped. Three
divergent builder readings: silent invalidation (operator never hears about a
write+restart they approved), a FALSE "the fix didn't take" timeout (the
write took; the peer merely left), or pause-and-resume. Fix direction (both
lenses agree): suspension PAUSES the fixVerify clock exactly as it pauses
resolve-ticks/escalation — an executed fix's verify RESUMES on the
participant's return, and suspension NEVER fires the (v) failure append;
R3-M6's "suspension invalidates pendingFix" is SCOPED to the
not-yet-executed states (proposed / approved-holding), and when it
invalidates a HOLDING approved fix the suspension note NAMES it ("the fix
you approved is paused — <nickname> is unverifiable; I'll re-propose when it
returns"), never a silent lapse.

## MINOR

**R4-N1 — Re-proposal cadence after a failed/held fix and for the next
multi-row proposal is unpinned.** (decision-completeness R4-2) §4.2.1. Pin:
re-proposals render IN-PLACE in the item body (not new appends) and are
gated on the operator's next explicit approval — never an autonomous retry
stream.

**R4-N2 — The "leave it" operator-ack state has no stated durability or
reopen-clearing.** (decision-completeness R4-3) §4.2/§4.4/§4.5. A restart
between "leave it" and the 24 h mark would fire the escalation the operator
suppressed. Pin: the ack flag lives in the durable episode state
(transition-written), survives restart and suspend/resume, and is CLEARED on
a genuine recurrence re-open (one fresh nag is honest).

**R4-N3 — The burst-invariant test verifies each flap class in isolation,
not the SHARED budget.** (decision-completeness R4-4 + adversarial R4-5 —
same finding) §4.5/§9. A per-class-budget implementation passes the stated
test while violating "share one rolling budget". Pin: add a combined-burst
assertion — all transition classes flapping concurrently in ONE episode
produce ≤ `episodeAppendBudget` + 1 appends TOTAL.

**R4-N4 — The blind-side held-path single-flight is an overclaim.**
(adversarial R4-2) §4.2.1(i). "Never two writes + two restarts" is enforced
mechanically only for the mechanized and post-reconciliation cases; two
blind-side holders approved in one window for a THIRD divergent machine
degrade to idempotency (config-safe, but a redundant restart is possible).
Fix: name the divergent machine's local atomic funnel as the held-path
single-flight point and gate its restart on ACTUAL config change (no diff →
no restart); soften the absolute prose to "never two conflicting writes; a
redundant restart in the interleaved pre-reconciliation held window is
bounded by idempotency + skew-set invalidation".

**R4-N5 — Durable-write bounding under latched flapping is asserted but not
mechanized.** (scalability R4-1) §4.1/§4.5. §4.1's transition list makes
suspend/resume/row-join unconditional durable-write triggers; a flap storm
rewrites the episode file per flap even while latched. Pin: entering
latched-flapping drops the flap transition classes to jsonl-only INCLUDING
the durable state-file write — only latch-enter/latch-exit write durably
(the durable `suspended` field is intentionally stale-until-latch-exit;
safe, since tick counters are in-memory + warm-up-absorbed).

**R4-N6 — The mechanized case's self-restart primitive is real but uncited,
and the naive call is self-defeating.** (integration R4-1) §4.2.1(iv).
`restartServer` (server.ts:21630) on the launchd path boots out the calling
process before bootstrap runs. Pin: cite the concrete primitive — write-ahead
+ exit under the launchd/systemd keepalive supervisor (or the existing
lifeline restart-signal pattern, version-skew.ts:82) — and name the
supervisor dependency: a non-supervised `instar server` cannot self-restart
and degrades to the held/manual path.

**R4-N7 — The episodeId-clamp marker-drop is "counted" but tied to no named
status-route counter.** (security R4-2) §3.2/§6. Pin: the drop increments
`clampRejections` (or a named `markerDropped` counter) so a forged-episodeId
campaign is visible on the status route.

## LOW

**R4-L1 — Machine nicknames are peer-influenced free text rendered verbatim
on the HIGH operator surface; the L2 invariant doesn't name them.**
(security R4-1; pre-existing and mesh-wide) Escape/clamp at the operator
boundary, or add one L2 sentence stating nicknames inherit the registry's
identity-field trust (display-only).

**R4-L2 — The §4.2 approve-line renders `<flag>` ambiguously (dotted key vs
plain-language name), in mild tension with point 3.** (lessons R4-1) Pin:
the approve-line names the feature in plain words; the dotted key stays in
the secondary block.

**R4-L3 — The held-fix prose slightly implies reliable self-execution.**
(lessons R4-2; optional) One notch plainer about the fail-loud-then-defer
operator experience.

**R4-L4 — The three byte budgets sum exactly (2 KB + 1.5 KB = 3.5 KB) with
zero bytes for the JSON structural join.** (scalability R4-2) The N5 ratchet
measures the real combined serialization so overflow is build-time-caught;
optionally state the sub-budgets are measured on the combined serialization.

**R4-L5 — §11 cites the raw PATCH /config handler at :21322; the
`router.patch` line is :21323.** (integration R4-2) One-line drift
regression from round 3.

**R4-L6 — Within the shared append budget, cosmetic row-join churn can crowd
out a semantically-important suspend note.** (adversarial R4-4) Reserve or
prioritize a suspend/resume slot within the budget.

**R4-L7 — The append-budget latch EXIT criterion is stated only as "until a
stable window passes".** (decision-completeness R4-5) Pin: the latch
releases when the rolling append count within `episodeAppendWindowMs` falls
back below `episodeAppendBudget`.

**R4-L8 — The ratifier→execution bridge is pinned by analogy; the
restart-trigger half has no direct precedent.** (decision-completeness R4-6)
Name the invocation surface and state self-restart reuses the existing
config-change restart path, guarded by the write-ahead outcome.

## Panel notes (recorded honestly)

- adversarial R4-3 (suspension invalidating a holding approved fix isn't
  proactively surfaced) is deduped INTO R4-M2's fix — it is the surfacing
  half of the same pendingFix×suspension state rule.
- Both externals returned fully-clean CONVERGED verdicts for the second
  (gemini) and first (pi) consecutive round while internal walk re-execution
  found the two MAJORs — reconfirming the round-3 note: external prose-level
  review verifies fold INTENT; only walk re-execution verifies mechanism.
  Round 5's externals must re-run against the round-5 text as usual.
- The decision-completeness lens itself — the round-3 CRITICAL grader —
  verified R3-M1 FOLD-OK end-to-end ("no stop-and-ask on the core flow"),
  and the adversarial lens verified all three of its round-3 FOLD-FAILs
  closed. The two new MAJORs are interaction seams (marker×raise-success,
  suspension×fixVerify), not regressions of anything previously folded.

## What held (credit where due)

The raise-silent subtraction walk (3-machine + cascade + clock-skew +
mid-fallback recovery) converges in every ordering; the blind-side dual-open
degrades to suspended-quiet and reconciles on heal; the zero-knowledge
truncation suppression is dead; the combined flap worst case is ~7 appends
then flat; the pendingFix lifecycle survived the dueling-items walk (with
the R4-N4 softening); every round-4 citation grounds true (writeConfigAtomic
verbatim-accurate; the PATCH /config non-atomicity confirmed in source; the
clobber-hazard citation now points at the real 2026-06-11 incident); the L2
exposure invariant is fully restored (every peer-episodeId rendering site
keys off the format-clamped marker); and the detection architecture,
manifest/advert design, §5b, close-reason taxonomy, and election core have
now drawn zero objections for four consecutive rounds.

## Verdict

**NOT CONVERGED.** Round 4 closes with 0 CRITICAL, 2 MAJOR, 7 MINOR, 8 LOW
across 6 internal lenses + 2 externals (both fully clean — overridden by the
walks) + the conformance gate (0 flags). All 23 round-3 findings verified
genuinely folded under walk re-execution — the ceremony's first round with a
100% fold-hold rate — and the finding surface has narrowed to two
interaction seams of the round-4 machinery itself: the marker must key on
raise-SUCCESS rather than episode-open (R4-M1), and the pendingFix×suspension
state rule needs its three-sentence pin (R4-M2). Both have panel-agreed fix
directions recorded in-line. Round 5 folds R4-M1/M2 + the seven MINORs and
re-executes the walks; per the ceremony charter this round STOPS here and
reports.
