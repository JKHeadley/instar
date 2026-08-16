# Convergence Report — Tone-Gate Contestation Evidence

## Status: ⚠ CONVERGENCE NOT REACHED — and the design is now SUPERSEDED IN DIRECTION

**Read this first (2026-07-23, after the report below was written).** The operator
reframed the problem, and the reframing is better than what was reviewed here.

This report ends by asking the operator to choose (a), (b) or (c) for how a
sender-disagreement should be *stored as a grade*. **All three options are moot.**
The operator's model is: don't grade in real time at all. Record the input, the
prompt and the decision; record whether the agent agreed or disagreed and, when it
disagreed, WHY with full context; then judge **later, in bulk, with a very
intelligent model**, unhurried.

That dissolves the recurring blocker instead of managing it — an override is a
disagreement, not a verdict, so nothing needs storing as `wrong`. It also revives
the `right` rule withdrawn in round 7 as unsound: authorship never needed to be
*proven*, because the recorded context goes to a judge.

The honest cost: ten review rounds hardened a design aimed at a goal I had inferred
rather than confirmed. The reviews themselves were not wasted — they killed a
fabrication-prone rule, a privacy overclaim, and an over-complicated join, all of
which would have been wrong under any model. But the central question this report
escalates was the wrong question.

Tracked as **ACT-942**. The remainder is retained unedited as the record of what
was built, reviewed, and learned.

---

## Original status: ⚠ CONVERGENCE NOT REACHED (10-iteration cap hit)

**This spec did NOT converge.** It ran the full 10 rounds and the final round still
produced findings. Per `/spec-converge`, a shrinking finding count is not
convergence — convergence is *zero material findings in a new round*, and round 10
was not zero.

No `review-convergence` tag has been written. `/instar-dev` therefore remains
blocked on this spec, which is the correct outcome and not a technicality to route
around.

**What is nonetheless true:** the code is built, tested (three tiers, 181 green
across the affected suites), and is materially better than what round 1 reviewed —
one whole subsystem was deleted as a direct result of review. The blocker is a
single recurring design disagreement that needs an operator decision, described
below.

## Cross-model review: codex-cli:gpt-5.5 (RAN — all 10 rounds)

Real external review ran every round through the agent's own codex CLI
(`gpt-5.5`) and, in 8 of 10 rounds, gemini CLI (`gemini-3.1-pro-preview`); gemini
degraded on rounds 3 and 7 (timeout). The Standards-Conformance Gate ran every
round against all 51 constitutional standards.

**⚠ Honest deviation — the six internal reviewers did NOT run as independent
subagents.** The skill specifies six parallel Claude subagents (security,
scalability, adversarial, integration, decision-completeness, lessons-aware). A
standing instruction in this session prohibits spawning subagents unless the
operator asked for it, and routing around that because a process document said
otherwise would have been the wrong call. Those perspectives were applied by the
authoring session instead — which is **weaker**, because it is the author reviewing
their own work, exactly the circularity the internal-reviewer panel exists to
prevent. The two cross-family external reviewers were genuinely independent and did
the heavy lifting; the record should show the internal half was not.

## ELI10 Overview

The agent checks every message before sending it to you. A separate system records
those checks so we can ask whether the checker is any good. Over a week it recorded
1,087 decisions and scored exactly none of them — the scoring half was never built.

This spec builds the smallest honest piece of it. When the checker stops a message
and the agent overrides and sends anyway, that disagreement now gets recorded
against the specific decision it disputes. That is the one outcome we can capture
cleanly today.

Two things it deliberately cannot do, both discovered in review. It cannot say the
checker was *right* — that would require knowing the agent accepted an objection and
rewrote, and nothing proves the replacement came from the same session. And an
override is not proof the checker was *wrong* — it proves the sender chose to
override, which might be urgency or impatience. So the record says "contested," at
the weakest evidence grade, and everything else stays "unknown."

## Original vs Converged

**The single biggest change: an entire subsystem was deleted.**

The original design matched a stopped message to its override by *fingerprinting the
message text* and looking it up later. That dragged in a secret key plus its whole
lifecycle (storage, permissions, corruption, rotation), a durable store with a
retention policy, a scope tuple, and a heuristic for guessing which decision an
override meant when the same text had been stopped twice. It also could not work
across machines.

Rounds 5–7 kept pointing at a simpler approach: hand the sender a signed ticket with
the stop, take it back with the override. For two rounds the response was to write
better justifications for keeping the complicated version. Round 7 named that
directly — *"the spec knowingly ships the worse join"* — and the fingerprint
subsystem was deleted and replaced. The result is roughly half the code, stateless,
exact instead of heuristic, and it crosses machine boundaries.

**Three honesty corrections, each caught by the external reviewer:**

1. **An override was called "deterministic proof" that the gate was wrong.** It is
   not. It proves the sender bypassed the hold. Downgraded to the weakest evidence
   rung — the same manufacturing the spec refused on the silence side, arriving
   through the other door.
2. **A `right` rule was going to ship that could fabricate grades.** It matched a
   "rewrite" by channel, topic and message kind — none of which establish the same
   *author*. A second session serving the same conversation would have scored the
   gate right for nothing. The rule was withdrawn; the feature ships without any
   ability to say "right".
3. **A raw hash was described as "zero exposure."** Agent replies come from a small
   guessable set, so an unsalted digest permits dictionary confirmation. (Moot now —
   the fingerprint is gone entirely.)

**Also corrected:** the title. It originally promised "real right/wrong"; what it
produces is a record of *contested* decisions, and it now says so.

## Iteration Summary

| Round | External verdict (codex / gemini) | Conformance gate | Material findings | Spec/code changes |
|---|---|---|---|---|
| 1 | SERIOUS / MINOR | ran, 2 flags | 8 | Named parent standard; deferral given a tracked owner; goal contradiction fixed; override downgraded to self-report; `right` rule withdrawn; census fix unbundled |
| 2 | SERIOUS / MINOR | ran, 3 flags | 5 | Raw hash → keyed HMAC; cross-machine bias measured; verification traffic segregated; testing/rollout sections rewritten to the real boundary |
| 3 | MINOR / degraded (timeout) | ran, 0 flags | 5 | Data flow spelled out; §6.1 contradiction fixed; key lifecycle made observable; cross-machine miss counter added |
| 4 | MINOR / — | ran, 0 flags | 5 | Singular match predicate (a repeated message no longer over-counts); key-corruption signal split out |
| 5 | MINOR / MINOR | ran, 0 flags | 5 | "Ground truth" framing dropped; model comparison declared BLOCKED not underpowered; enum mapping locked as a decision with a named residual |
| 6 | MINOR / MINOR | ran, 0 flags | 4 | Conceded the deferral justification was wrong; wave 1 reclassified as temporary instrumentation with deletion criteria |
| 7 | **SERIOUS** / degraded | ran, 0 flags | 4 | **Fingerprint subsystem deleted; rebuilt on the signed token; spec renamed** |
| 8 | MINOR / MINOR | ran, 0 flags | 4 | Token format pinned normatively; counter predicates defined exactly; coverage made a first-class denominator |
| 9 | SERIOUS / MINOR | ran, 0 flags | 4 | Full MAC (no truncation); key-id added so cross-machine ≠ forgery in the counters |
| 10 | MINOR / MINOR | ran, 0 flags | 3 | Pool aggregation explicitly prohibited; compound display label mandated |

Rounds 1–2 produced 13 material findings; rounds 8–10 produced 11. The count
plateaued rather than reaching zero — which is why this is not a convergence.

## The blocker — an operator decision is required

Every round from 3 to 10 raised the **same** objection, escalating twice to
SERIOUS:

> The meter's grade enum is closed (`right | wrong | unknown`). A sender contesting
> a hold gets stored as `wrong`. Any consumer that reads the bare total without
> segmenting by rule or evidence-strength will report "the model was wrong" when the
> data means "the sender disagreed."

**What has been done about it:** the rule sits at the lowest evidence rung; the read
surface's default aggregate segments by strength; the rule id is persisted *and*
served, giving a machine-readable discriminator with no schema change; new surfaces
are now required to render a compound label and never bare `wrong`; pool aggregation
is prohibited; and the clean fix is registered as ACT-934.

**Why it did not resolve:** the reviewer's position is that mitigation-by-convention
is weaker than fixing the data model, and it wants the parent meter's schema widened
(a `gradeInterpretation` field) as a *blocking prerequisite*. That schema belongs to
`llm-decision-quality-meter` and every consumer that reads it. Widening another
spec's schema from a dependent spec is the exact scope creep round 1 rejected for the
census fix — so I did not do it unilaterally.

**The decision that is yours:**

- **(a) Widen the parent schema first.** Add `gradeInterpretation` to
  `llm-decision-quality-meter` §5.4, then land this. Cleanest; costs another
  spec-and-review cycle on a shared surface before any of this ships.
- **(b) Ship as-is on the dev agent only.** The residual is confined to a consumer
  that ignores both served discriminators — a reviewable defect in that consumer.
  ACT-934 carries the clean fix. Fastest path to real data.
- **(c) Don't emit a grade at all.** Record contestation purely as telemetry and
  leave the meter honestly empty. The reviewer offered this as its alternative.
  Loses the grade, keeps the information.

My recommendation is **(b)**, on the grounds that the feature is dev-gated, produces
tiny absolute counts, and now carries three independent mitigations — but this is
precisely the kind of call the approval gate exists for, and the reviewer's dissent
is recorded here rather than smoothed over.

## Full Findings Catalog

Raw per-round reviewer output is retained at
`/private/tmp/.../scratchpad/r{1..10}-{codex,gemini}.json` for this session. Every
material finding and its resolution is recorded inline in the spec itself, tagged
with the round and reviewer that raised it (e.g. *round-7, codex gpt-5.5 f3*), so
the audit trail lives with the design rather than only in this report.

## Verdict

**Convergence failed at the 10-iteration cap.** Human input required before retry —
specifically, the (a)/(b)/(c) decision above. The implementation is complete and
green; it is not committed, because the commit gate correctly requires a converged
and approved spec and this spec has neither tag.
