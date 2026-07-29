# Councilor track-record inventory

**Measured 2026-07-28 on the live echo agent. Read the verdict before the table.**

## Verdict: the track record does not exist yet

The standing goal was to inventory every councilor holding a hard block **with its actual track
record** — "fire rate and correctness where measurable — `/metrics/features` and `/decision-quality`
carry real numbers" — and convert the unjustified hard blocks to advisory.

**Both numbers are unavailable for almost every councilor, and the surfaces do not say so.**

| what the goal asked for | what is actually there |
|---|---|
| fire rate | instrumented on **3 of 19** features with ≥10 calls. The other 16 report `fired: 0`, which is indistinguishable from "never fires" and is **false for at least one proven case**. |
| correctness | **0 of 5,293 decisions** over 7 days carry a `right` or `wrong` grade. Every one is `unknown` or `expired`. |

**An inventory built from these surfaces would conclude that almost every councilor never fires and
none is ever wrong.** Both conclusions would be artifacts of missing instrumentation, and both would
argue for converting hard blocks to advisory — a decision-grade error made on measurements that were
never taken. **That is why this document reports the gap instead of the table.**

## The proof that `fired: 0` is false, not merely unproven

`MessagingToneGate` reports **532 calls, fired: 0** over 48h.

During the session that produced this document it **blocked two of the author's own outbound
messages** — once for a leaked API endpoint, once on a grounding verdict — each with a specific
semantic refusal that had to be worked around before the message could send. A gate observed refusing
twice reads on its own metrics as never having fired.

So `fireRate: 0.000` on this surface means **"not instrumented"**. Tracked as ACT-1450.

## Fire-rate instrumentation, 48h, features with ≥10 calls

| records fires | count | examples |
|---|---|---|
| **yes** | 3 | `rope-health` 97/5816 · `MessageSentinel` 18/44 · `CommitmentSentinel` 4/29 |
| **no (`fired: 0`)** | 16 | `MessagingToneGate` 532 · `UnjustifiedStopGate` 426 · `completion-claim-verify` 4071 · `PromptGate` 99 · `SessionWatchdog` 70 · `StandardsConformanceReviewer` 39 · `PresenceProxy` 34 · … |

**Call-weighted: 27.4%** of LLM calls run on a feature that records fires at all.

## Correctness grades, 7 days — the decisive number

| decision point | decisions | outcomes "known" | right | wrong | unknown | expired |
|---|---|---|---|---|---|---|
| `messaging-tone-gate` | 2073 | 2001 | **0** | **0** | 2001 | 0 |
| `completion-claim-verify` | 1914 | 1720 | **0** | **0** | 1720 | 9 |
| `topic-intent-extract` | 660 | 0 | **0** | **0** | 0 | 589 |
| `unjustified-stop-gate` | 640 | 0 | **0** | **0** | 0 | 568 |
| `goal-priority-extract` | 4 | 0 | 0 | 0 | 0 | 2 |
| `alignment-review` | 2 | 0 | 0 | 0 | 0 | 2 |
| 5 others | 0 | 0 | — | — | — | — |
| **total** | **5293** | **3721** | **0** | **0** | **3721** | **1170** |

**Not one graded decision in seven days.**

Note also that `outcomesKnown` counts rows whose grade is literally `unknown`. A reader taking
"2001 outcomes known" at face value would believe the tone gate's record is well-characterised; it is
entirely uncharacterised. That is the same claim-versus-measurement gap in the metric's own naming.

## What this means for the conversion decision

**No hard block should be converted to advisory on the strength of these numbers**, because the
numbers do not exist. A conversion argued from `fireRate: 0.000` would be arguing from an
uninstrumented counter.

The one conversion with a genuine basis is the **tone-gate advisory migration**, already done —
and its basis was a *reasoned* carve-out (which rules constrain the agent versus which protect the
user), not a measured fire rate. **That is the pattern to copy: argue the class of decision, not the
counter.**

## What has to be true before this inventory can be completed

1. `fired` instrumented on the councilors that hold blocking authority — or the field removed, so a
   zero cannot be misread as evidence.
2. The grading pass producing actual `right`/`wrong` verdicts. It currently produces `unknown` at a
   100% rate, which makes the whole quality meter unable to answer the question it exists for.
3. `outcomesKnown` renamed or redefined so it cannot count `unknown` as known.

Until then, "which councilors deserve to keep blocking authority?" is **not an empirically answerable
question on this system**, and any answer presented as measured would be fabricated.

## Scope

Honest bounds: measured on ONE agent over 48h (fire rates) and 7 days (grades). Features with <10
calls are excluded as too sparse to characterise. This inventory covers councilors visible on
`/metrics/features` and `/decision-quality`; a councilor instrumented on neither would not appear
here at all — which is itself an unmeasured gap, not an empty one.
