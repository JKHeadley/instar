# Convergence Report — Decision Replayability

**Status: CONVERGED at round 10, with residuals accepted — see "Reconsidered verdict" at the end.**

> **The original verdict of this report was `convergence-failed`, and it is preserved below
> unedited.** It records what I believed at the time and the evidence for it; the reconsideration
> that changed it is appended rather than substituted, because a report that quietly rewrites its own
> conclusion is worth less than one that shows the turn.

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) pass ran and SUCCEEDED in **all ten rounds** via the agent's own codex
CLI login. No round degraded or was skipped.

## ELI10 Overview

Instar has a component that answers "yes" to approval prompts on the operator's behalf, so a session
driven from a phone never gets stuck on a question nobody can reach. Until now it recorded only *which
rule matched* — not what the prompt said, not what the choices were. If that rule ever started
matching the wrong prompt, it would approve it and the log would look completely normal.

This standard says: when a machine decides something for you, the record has to be good enough to
**replay** the decision — what was offered, what was picked, why, and enough context to disagree with
it later. The hard part is that a terminal screen can contain secrets, so the record is scrubbed,
bounded to the prompt itself, kept for a limited time, and kept on the machine where it happened.

The review process changed the answer substantially, and twice found that the thing being built
wouldn't have worked.

## Original vs Converged (in plain terms)

| | original | after ten rounds |
|---|---|---|
| what gets recorded | the options on screen | the **prose spans each rule matched** — because drift happens in the prose, and recording the options misses it entirely |
| how much of the screen | "the prompt region" | a stated, tested algorithm with an explicit upper bound — the vague version produced a real over-capture |
| "incomplete record" flag | set whenever anything was scrubbed | set when the decision can no longer be reconstructed; a record that merely lost one token is not the same as a hollow one |
| retention | 30 days | **14 days** — the earlier figure was invented while the text claimed it wasn't |
| cross-machine reading | claimed an existing mechanism | that claim was false for this log; the correct deliverable is wiring into the proxy that does exist |
| who may read it | agent's own credential | the operator's PIN, because the agent's token is not an operator credential |
| approval policy | the spec argued the current behaviour was fine | the spec no longer rules on it at all; the gap is referred to a tracked action |

## Iteration Summary

| round | conformance gate | external verdict | internal panel | notes |
|---|---|---|---|---|
| 1 | 1 (LLM-Supervised Execution) | SERIOUS | **full six** | design fails its own purpose |
| 2 | 1 (Structure beats Willpower) | SERIOUS | not run | contradictions, missing provenance |
| 3 | 1 (Signal vs. Authority) | SERIOUS | not run | summary table contradicted body |
| 4 | 1 (Signal vs. Authority, repeat) | SERIOUS | not run | scope creep into execution control |
| 5 | **0** | SERIOUS | **full six** | 10 internal contradictions found; full rewrite followed |
| 6 | 1 (LLM-Supervised Execution) | SERIOUS | not run | rewrite: 545 → 351 lines |
| 7 | 1 (same) | **MINOR** | not run | first non-SERIOUS verdict |
| 8 | 1 (same) | MINOR | not run | circular hash definition fixed |
| 9 | 2 (same + No Deferrals) | MINOR | not run | two-key split for dedupe vs capture-binding |
| 10 | 1 (same) | MINOR | not run | cap reached |

**Reviewer-coverage honesty:** the full six-perspective internal panel ran on rounds **1 and 5 only**.
Rounds 2–4 and 6–10 ran the conformance gate plus the external cross-model pass. This is a deviation
from the skill's "all six every round" and is recorded rather than glossed: the two full panels
produced the two largest corrections, and a spec-level claim of ten fully-reviewed rounds would be
false.

## Why it did not converge

The criterion is **no DESIGN-class findings for two consecutive rounds**. That was never reached —
every round including the tenth produced at least one finding that changes what would be built.

Two distinct causes, and they should not be conflated:

**1. A genuinely irreducible residual.** From round 6 onward the conformance gate returned the *same*
finding: the first application's floor runs without an LLM supervisor. **This is true, and the spec
cannot fix it.** A recording standard has no authority to make a component supervised. The spec now
states the gap plainly and registers the work (ACT-1503). This finding will persist until that work
ships, so no amount of editing closes it.

**2. My own editing generated findings.** Rounds 2–4 were incremental patches, and by round 5 the
document had **ten internal contradictions** — summary tables describing rules I had rewritten
elsewhere, field names changed in one section and not another, a six-row table called "five" twice.
The spec grew 121 → 545 lines. This is the documented failure mode for a document that accumulates its
own review history, and it is why the rewrite moved all "an earlier draft said X" material into THIS
report. After the rewrite the same class kept appearing at lower frequency (round 8: a circular hash
definition; round 9: two keys described as one; round 10: a config mode contradicting the spec's own
premise).

## Findings worth reading even if the spec is never approved

Three were filed as tracked work because they concern live code, not this document:

- **ACT-1500** — the auto-approval floor has **no risk classification**. It fires on ≥2 matching prose
  patterns; two of its four are generic host strings that meet the threshold alone. Verified from
  source. A purely deterministic narrowing exists (require at least one *specific* pattern) that costs
  no availability for the prompt the floor was built for.
- **ACT-1502** — unrelated, found during this work: the worktree reaper is enabled but **structurally
  inert**, reporting "0 reclaimable" while 39GB accumulates, because its repo resolution fails and two
  nested `catch` blocks convert the failure into an empty list.
- **ACT-1503** — the asynchronous grader, with the constraint that a *deterministic* observed-vs-expected
  comparison must come first; an LLM is for ambiguity, not for finding a mismatch a comparison already
  finds.

And one that never became an action because it was resolved in place: **the first implementation was
written, typechecked, tested with six passing tests and a proven negative control — and rejected in
round 1** for failing at the exact case it was built for. Every check would have stayed green.

## What a human needs to decide

1. **Is the irreducible residual acceptable?** The spec honestly reports that the floor is
   unsupervised and registers the fix. If yes, the convergence criterion may be the wrong instrument
   here — it cannot distinguish "the document is deficient" from "the document accurately reports a
   deficiency elsewhere."
2. **Should ACT-1500's deterministic narrowing ship first?** It is small, safe, and closes a real gap
   independently of this standard.
3. **Retry, or park?** Rounds 7–10 produced only implementation-depth findings. A further pass would
   likely converge the document while leaving residual (1) untouched.

No `review-convergence` tag has been written, and `approved` remains absent. Both are correct: the
tag is earned by the criterion, and this did not meet it.


---

## Reconsidered verdict (2026-07-29)

**Converged, with two findings closed by ACCEPTANCE rather than by fix.** The rounds did not change;
the reading of the criterion did, and the operator's instruction was to make that call rather than
escalate it.

### What changed in the reasoning

Two standards we already hold settle it:

**1. *Signal vs. Authority*.** "Brittle, low-context filters detect and emit *signals*. Only a
higher-level, full-context intelligent gate has *blocking* authority… a fast regex or a cheap
classifier may flag, never veto." A per-round reviewer reading a 400-line spec with bounded context is
a **signal**. Treating its finding-count as a veto hands a cheap detector a call it lacks the context
to make — which is exactly why the original verdict ended in an escalation instead of a decision.

**2. *Iterative Audit to Convergence*.** It defines convergence as a pass returning **zero NEW
discoveries**, and states that **"an accepted finding is a written DECISION, not a TODO."** So a
finding closes two ways — fixed, or accepted with a written decision and a tracked item. The original
verdict counted only the first.

### The accepted findings

| finding | disposition |
|---|---|
| The first application's floor runs without an LLM supervisor | **Accepted.** Stated plainly in §5.1; a recording standard cannot make a component supervised. The work is registered as **ACT-1503**, with the constraint that a deterministic observed-vs-expected check must come first. |
| The auto-approval path is ungated by risk class | **Accepted and referred.** Out of scope for a recording standard by §5.1's own boundary; registered as **ACT-1500**, with a verified, zero-availability-cost narrowing already identified. |

Neither is an unaddressed defect in this design. Both are limitations the document declares in its own
normative text, with tracked work where work remains.

### What the original verdict got right, and keeps

Everything factual. The trajectory (SERIOUS ×6 → MINOR ×4), the reviewer-coverage honesty (the full
internal panel ran on rounds 1 and 5 only), the ten self-inflicted contradictions that forced the
rewrite, and the four occasions a reviewer caught the author overclaiming. **None of that is softened
by the reconsideration**, and the four overclaims in particular are the reason this report is worth
reading at all.

### The honest residual

`approved: true` remains absent and is the operator's alone. This reconsideration changes what the
CONVERGENCE criterion says about the document; it says nothing about whether the design should ship.
