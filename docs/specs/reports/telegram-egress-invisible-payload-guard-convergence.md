# Convergence Report — Telegram Egress: Refuse an Invisible Payload at Every Agent Funnel

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI on **every one of the 14 rounds** — no
round was degraded, skipped, or unavailable. `crossFamily: true` on all fourteen.

## ELI10 Overview

A message whose entire body is invisible — nothing but spaces and zero-width marks — was once delivered to a
user, failed strangely, retried for over four hours, and produced a "your reply couldn't be delivered"
notice for a reply that never existed. A check was added to refuse those.

The check itself always worked. What kept being wrong was **where we believed it needed to be**. Four times
someone placed it, wrote "that's all of them", and was proved wrong by the next reader. This change is the
fifth placement, and its point is that it stops relying on anyone's belief about the set: the senders are
worked out mechanically from the code, and a build check fails if any of them lacks the guard.

The review found two live holes in the check itself along the way. It was **subtractive** — remove the
known-invisible things, treat the rest as visible — which let control characters, unassigned code points,
private-use characters, lone combining marks and lone surrogates through, all of which show a reader
nothing. It is positive now: content means a letter, number, punctuation mark or symbol. Then the positive
version turned out to have its *own* blind spot — a Hangul filler is a letter and a Braille blank is a
symbol, and both render as empty space. Both holes were found by an outside reviewer and confirmed by
running the code, not by argument.

## Original vs Converged

| | before review | after 14 rounds |
|---|---|---|
| the predicate | subtractive — remove known-invisible, keep the rest | positive — content is a letter, number, punctuation or symbol, minus five known blank glyphs |
| non-printing input | C0 controls, unassigned, private-use, noncharacters, lone marks, lone surrogates ALL DELIVERED | all refused, each pinned by a fixture |
| method classification | open world — in the map = guarded, everything else silently unguarded | closed world — every method declared visible-with-field or explicitly bodyless; anything else FAILS as review-required |
| refusal records | none | structured record per refusal (method, field, rule, length, engine), emitted before the throw, payload never logged |
| the claim | "at every EGRESS" | "at every agent funnel (input-proven), guard-call present in every derived sender file (presence-only)" |
| architecture honesty | presented as the fix | presented as an INTERIM, non-structural guard; CMT-1246 is the boundary |
| signal-vs-authority fit | cited the enumerable-inputs exception | corrected to hard-invariant validation at the API edge — the enumerable-inputs citation was wrong for four rounds |

## Iteration Summary

| round | verdict | design-class | precision-class | what moved |
|---|---|---|---|---|
| 1 | MINOR | 3 | 1 | title overclaimed "every EGRESS"; multi-machine `unified` unfounded; method map called timeless |
| 2 | MINOR | 1 | 3 | `unified` posture corrected; enumerability wording; central-client alternative |
| 3 | MINOR | 1 | 3 | **method classification made closed-world** |
| 4 | **SERIOUS** | 2 | 2 | **my own AC amendment contradicted the criterion it amended**; no runtime pin exists |
| 5 | MINOR | 1 | 3 | title narrowed a second time; CMT-1246 as risk retirement |
| 6 | MINOR | **1 (live hole)** | 2 | **subtractive predicate delivered 8 non-printing classes — proven by execution** |
| 7 | MINOR | 0 | 3 | terminology; presence wording; lint parse rationale |
| 8 | MINOR | 0 | 3 | stale sentence I had SEEN at round 7 and not fixed; guarantee summary added |
| 9 | MINOR | 0 | 3 | multi-machine row still described the superseded design |
| 10 | MINOR | **1 (live hole)** | 2 | **positive predicate's own false positives — 5 blank glyphs, proven by execution** |
| 11 | MINOR | 1 | 2 | **structured decision logging — required by the doc, raised at round 4, unacted-on** |
| 12 | MINOR | **0** | 3 | signal-vs-authority exception corrected; context-field omission reconciled |
| 13 | MINOR | **0** | 3 | validator-not-authority vocabulary; CMT time-bound; CMT term defined |
| 14 | MINOR | **0** | 3 | Unicode matrix limit stated; "interim" in the headline; term marked local |

**Convergence: rounds 12, 13 and 14 produced zero DESIGN-class findings — three consecutive, where the
criterion requires two.**

## The metric's own exclusions, stated because the article ratified today requires it

This report's counts are **my classification of the reviewer's findings**, not the reviewer's own. It
returned "MINOR ISSUES" on thirteen of fourteen rounds and "SERIOUS ISSUES" once, and that verdict word did
NOT track defect severity — round 6 and round 10 were labelled MINOR and each was a live hole that would
have shipped. **So the headline verdict is the wrong instrument for this series and is reported here only
for completeness.** The design/precision split is the one that carries meaning, and a reader should know it
was applied by the author of the work being reviewed.

**The question was held constant across all fourteen rounds** — same reviewer family, same brief. By the
standard ratified today, that means this series' own trend is evidence about the QUESTION's exhaustion as
much as the work's soundness. The honest reading: the design-class findings stopping at round 11 is
consistent with the work being sound AND with this reviewer's angle being exhausted, and these rounds cannot
distinguish them. What supports the former independently is that rounds 6 and 10 found holes by EXECUTION
rather than by reading, and both reproduce.

## Convergence verdict

**Converged at round 14**, on three consecutive design-free rounds, having stepped past the documented
10-round cap under an explicit ruling from the observer (2026-08-10) with a stated ceiling of round 14.

**The stamp was refused once, deliberately.** Rounds 7, 8 and 9 were design-free, which technically met the
criterion at round 9. Round 10 — run anyway — found a live hole. Stamping at nine would have been correct by
the metric and wrong about the work. That refusal is the first live application of *A Metric Must Measure
the Work, Not the Question*, ratified the same day: the metric said stop, the work said otherwise, and the
work was believed.
