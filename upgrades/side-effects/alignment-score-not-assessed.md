# Side-Effects Review — an alignment score that can say "not assessed"

**Version / slug:** `alignment-score-not-assessed`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

`IntentDriftDetector.alignmentScore()` returned `score: 0, grade: 'F'` when the analysis window
contained no decisions. The `summary` field was honest ("No decisions logged — alignment cannot be
assessed") but no consumer read it; `score` and `grade` are what get rendered and compared. So
"nothing to assess" and "assessed, catastrophically bad" were identical on every field in use — on
the instrument whose purpose is honest alignment measurement.

Root cause is vocabulary, the same shape as the channel registry one increment earlier: the grade
union was `'A'|'B'|'C'|'D'|'F'` with no member meaning *no verdict*, so absence had to borrow the
worst real grade.

Adds `'N/A'` to the grade union, adds `assessable: boolean`, and makes `instar intent drift` print
the reason instead of a fabricated grade.

## Refusal evidence (constraint 2)

```
REFUSAL 1 — restore the fabricated 'F' on the unassessable case
  × handles empty journal — not assessable, grade N/A      → expected 'F' to be 'N/A'
  × GET /intent/alignment reports NOT ASSESSED             → expected 'F' to be 'N/A'
  × an empty journal grades 'N/A', never 'F'               → expected 'F' to be 'N/A'
  Tests  3 failed | 25 passed (28)

REFUSAL 2 — always report assessable:true
  × an empty journal is flagged unassessable               → expected true to be false
  × a real assessment is DISTINGUISHABLE from an empty one → expected true not to be true
  × assessable tracks sampleSize exactly                   → expected true to be false
  (+2)                                                     Tests  5 failed

REFUSAL 3 — disable the CLI's honest branch (`if (false && !alignment.assessable)`)
  BEFORE the CLI test existed:  Tests  28 passed (28)   <-- the blindness, again
  AFTER:  × a STALE journal prints "not assessed", never a red F
          Tests  1 failed | 4 passed (5)
```

Restored: **42 passed** across the five affected files, `tsc --noEmit` exit 0.

**REFUSAL 3 is the finding, and it is the THIRD occurrence of this class tonight** (#1658 route
registry, #1659 route validator, now a CLI renderer). Each time the logic was thoroughly guarded and
the wiring to the surface a human or API client actually reads was not. This one is the sharpest:
the module returning `'N/A'` is worth precisely nothing if the renderer ignores it, and 28 green
tests said everything was fine while the renderer was disabled.

## Two of my own claims were falsified during this work

Recorded because the corrections are the useful part, and because an artifact that hides them is the
failure mode this tier exists to remove.

1. **"`instar intent drift` has been showing a red F for the journal's whole life."** FALSE. The
   command returns early with a genuinely helpful message when the window holds no decisions; it
   never reaches the scoring block. The empty case was already handled honestly there.
2. **"Then it is reachable whenever the journal is merely stale."** ALSO FALSE. The early return
   checks `windowDays` (default 14) and `alignmentScore()` is fixed at 30 — and 14 ⊂ 30, so anything
   clearing the early return is inside the alignment window by construction.

**The actual reachable CLI case is narrow:** the operator must widen the window past 30
(`--window 60`), so a 40-day-old decision clears the early return and falls outside the fixed 30-day
alignment window. That is what the regression test constructs. I asserted twice before checking; the
test is what settled it.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `sampleSize === 0` → `grade: 'N/A'`, `assessable: false` | `invariant` | Deterministic count check. No model. |
| `assessable` mirrors `sampleSize > 0` | `invariant` | Asserted by test; the two can never disagree. |
| CLI branches on `assessable` | `invariant` | Renders `summary` instead of a grade. |

No judgment points, no LLM, nothing gated or blocked.

## 1. Over-block

Nothing is blocked — this is a read surface. The available harm is **misinforming a reader**, and
this change strictly reduces it in the direction that mattered (absence no longer reads as failure).

The mirror over-block is real and guarded: a genuinely-assessed period must never report `'N/A'` or
`assessable: false`, or a real alignment problem would be hidden as "no data" — strictly worse than
the original bug. Asserted by two tests (`a genuinely assessed period still reports a real letter
grade`, and the CLI's `a populated journal still prints a real graded score`).

**Caller sweep, run BEFORE writing this section** (the correction from #1659, where I wrote a
confident risk claim from the wrong measurement and CI falsified it): `alignmentScore()` has exactly
two production callers — `routes.ts:24305` (passes through verbatim) and `commands/intent.ts:431`
(now branches). Every `.grade` hit elsewhere in `src/` belongs to `DecisionQualityRecorder`'s
unrelated `right|wrong|unknown` grade, checked rather than assumed. Two tests asserted the old shape;
both updated.

## 2. Under-block

**The mismatched windows are NOT fixed.** The early return uses `windowDays` while `alignmentScore()`
is hardcoded to 30. That divergence is what makes the CLI case reachable at all, and reconciling them
changes what the command reports for every user. Deliberately not folded in. <!-- tracked: CMT-1044 -->

**`score: 0` is retained on the unassessable case.** Changing it to `null` would be a breaking type
change for a field two consumers read; `assessable` is the additive signal instead. A consumer that
reads `.score` and ignores both `assessable` and `sampleSize` still sees a 0 — it can no longer see
an F, which is the part that read as a verdict.

**It does not improve alignment,** and it does not judge whether a cited principle was genuinely
consulted. Same honest limit as the increment before it.

## 3. Level-of-abstraction fit

The honest state lives in the returned value, not in the renderer, so every consumer inherits it —
the route needed no change at all. The renderer's job is narrowed to *presenting* a state it no
longer has to infer. Had I fixed only the CLI, the API consumer (the one that is actually reachable
by default) would still have been lied to.

## 4. Signal vs authority compliance

Pure signal. `docs/signal-vs-authority.md` is satisfied trivially: it produces a read-only score that
gates nothing, blocks nothing, and is consumed by one route and one command.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. Two deterministic branches on a count.

## 5. Interactions

- **`GET /intent/alignment`** — response gains `assessable`; `grade` may now be `'N/A'`. Additive plus
  one widened union member.
- **`IntentDriftDetector.analyze()`** — untouched; drift scoring is a separate path.
- **`tests/unit/IntentDriftDetector.test.ts`** and **`tests/integration/drift-routes.test.ts`** — each
  had a test asserting `grade === 'F'` on the empty case. **Both were encoding the defect**, not
  merely stale. Updated with comments recording that, since a test that locks in a wrong answer is
  the same instrument-honesty class as the defect itself.
- **`CapabilityIndex`** — unchanged; `intent` is already `INTERNAL_PREFIXES`.

## 6. External surfaces

One API response shape change (additive field + widened union), one CLI rendering change. No config
key, no persisted state, no migration, no message to any user.

## 6b. Operator-surface quality

The unassessable CLI output prints the reason (`No decisions logged — alignment cannot be assessed`)
in dim rather than a red grade, so it reads as an absence of data rather than an alarm. The component
breakdown is suppressed in that branch: four zeroed rows invite exactly the misreading being fixed.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The journal is a per-machine JSONL under `stateDir` and the score is
computed from it, so `assessable` answers "on this machine". An agent running on two machines has two
journals and two scores. That predates this change and is unaddressed here. <!-- tracked: CMT-1044 -->

## 8. Rollback cost

Low. One union member, one boolean, one CLI branch, three test updates. No persisted state, no
migration; existing journal rows are read unchanged. Reverting restores the fabricated F.

## Phase 5 — Second-pass review

Not a gate, sentinel, guard or watchdog; holds no block/allow authority; touches no session lifecycle
or trust level. The high-risk trigger list is not engaged. Author lenses, disclosed:

**Adversarial — "how would I make this useless?"** Three ways, all closed and asserted: report `'F'`
again (refusal 1), make `assessable` constant (refusal 2), or let the renderer ignore it entirely
(refusal 3 — the one that was genuinely open until I wrote the CLI test).

**"Would it have caught the incident?"** The incident here is my own: I read `topPrinciples: []` and
`score: 0 (F)` on a journal I already knew was empty, and had to reason my way to "that F is
meaningless" instead of being told. With this, the surface says it.

**"Symptom or cause?"** Cause, for the reporting defect — absence can no longer render as a verdict
because the type now has somewhere honest to put it. Symptom-level for the window mismatch, which is
named and left.

**Weakest point:** the CLI case is genuinely narrow (`--window > 30`), and I over-claimed its reach
twice before testing settled it. The API consumer is the one that matters by default. An artifact
claiming broad user impact here would be overstating it, so this one does not.
