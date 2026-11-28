# Convergence Report — Correction class review writes graded evidence

**Spec:** [docs/specs/correction-class-review-graded-evidence.md](docs/specs/correction-class-review-graded-evidence.md)
**Slug:** `correction-class-review-graded-evidence`
**Converged at:** 2026-11-27, at the Tier 1 round cap (3 of 3)
**Iterations:** 3
**Final-round design findings:** 4 (three from the cross-model pass, one from the internal security lens), each corrected in the text and code after the round and listed under Left behind; the other internal lenses converged.

## Cross-model review: codex-cli:gpt-6.2-astra

A GPT-tier pass ran through the agent's Codex CLI in all three rounds, each returning a result. Gemini is not installed on the M5 Pro, where the pass ran (it is on the Studio).

## ELI10 Overview

When the operator corrects an agent, a built-in reviewer decides whether a standard or the way work is done needs to change, and files a proposal when it does. Before it can be switched on for every agent, its ladder has to see evidence that its proposals are any good. Until now nothing wrote that evidence, so it could never pass.

This change has the reviewer note each review it finishes and each failure, and turns the operator's existing PIN-protected decision on a proposal into a grade: accepted is right, rejected is wrong, the latest decision standing if it changes. Only the operator's decision grades; the agent's own actions never do, and no one holding the agent's token can write a grade in the operator's name. The grade is honestly acceptance, a proxy for correctness, and is read beside how many proposals were graded at all.

## Original vs Converged

- **Who grades.** Originally a completed work item also graded a proposal right. After review, only the operator's PIN-gated decision grades: work items are usually completed by the agent's own session on an unpinned route, so grading there would have let the reviewer certify itself (security and adversarial, round 1). The grader is a required argument with no default (Codex and decision-completeness, round 2), the ladder bar filters on it, and the open evidence route refuses operator grader names (security, round 3).
- **What gets graded.** Originally only a move away from "proposed" graded. After review, only arms the review actually proposed are graded (a "nothing to do" arm can never be graded through a deferral), and every operator decision grades whatever came before, so the agent shipping its own action first cannot keep the operator's rejection out of the count, and a confirmation after the agent is counted (Codex, adversarial, constitution check). The latest decision stands, matching the ladder reader.
- **The grade id.** Originally the review key cut at 64 characters, which could merge two proposals. After review, a fixed-length digest of key and arm.
- **Error rows.** Originally a raw message, counted as a model failure even after the judgment was stored. After review, a fixed code with its stage, written before any callback can throw.
- **Honesty about the measure.** The spec now states the grade is acceptance, defines coverage per proposal, states the multi-machine posture (the evidence log is per machine, as already declared), and names what is not graded (no-action calls; recurrence grading is follow-up CMT-066, due 2026-12-11).

## Experience fit

- **Source:** the feature review of 2026-11-20 (CMT-2086), both reviewers choosing "improve": bring the filled rows and the error rate into the evidence log, and assess correctness separately from fill rate.
- **Ordinary journey:** the operator sees nothing new and is asked nothing new; their existing PIN-gated accept or reject of a proposal now also counts as the review's grade.
- **Contrasting cases:** the agent completes its own action (no grade); the agent ships first and the operator rejects (graded wrong); the operator changes their mind after a recurrence (the latest decision stands); a caller with the agent's token posts a grade in the operator's name (refused).
- **Evidence limits:** acceptance is a proxy; if operators decide few proposals, the bar stays unmeasured rather than passed; each machine's ladder sees only its own reviews' grades.
- **Disposition:** delivers both halves of the request: the fill and error evidence in the log, and a quality measure from decisions the review does not make.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | codex; security, adversarial, integration, decision-completeness, lessons-aware; scalability precision only | 11 | grading tied to proposed arms; action completion stops grading; digest id; fired row moved; error stage; latest decision stands; multi-machine posture; CMT-066 |
| 2 | codex; adversarial; decision-completeness | 5 | grader required; ladder filter on grader; write order; operator decisions grade whatever came before; fixed error codes |
| 3 | codex; security | 4 | reserved operator grader names on the open route; real-reader metric test; coverage query and failure-mode wording |

Standards-Conformance Gate, every round, on the Studio (whole text, not degraded):
- Round 1 (entry text): ran (5, 6 and 8 flags), fit weak, fit, fit.
- Round 2 (entry text): ran (5, 4 and 3 flags), fit, weak, weak.
- Round 3 (entry text): ran (4, 5 and 5 flags), fit.

Internal reviewers ran on claude-opus-5-5, grouped two or three lenses to an agent, all six lenses each round.

## Proportion

Tier 1: evidence rows and a grading rule on an existing advisory feature, a one-line route guard, a ladder filter; no new flag or stored state; reversible by revert. Three rounds used against a cap of three. ⚠ The cap was reached; the last round's points were narrower than round 2's and none was data loss.

## Left behind

Corrected after round 3, not re-reviewed: the open evidence route refuses `operator` and `operator-*` grader names (security); a unit test reads the shipped metric through the real `LadderEvidenceReader` (five proposals, one redecided; reversal fails the bar; non-operator rows never count); coverage defined as a reproducible join; the failure mode of a lost redecision stated (a failed append as well as a process death); operator rationale described as not captured.

Repeated by the constitution check and recorded rather than iterated:
- The ladder's 5-grade, 30-day, 10% thresholds are inherited, not set here; meeting them only triggers the recurring review.
- Acceptance is not correctness (stated as a proxy, read with coverage).
- A lost redecision can leave a stale grade (stated; visible by comparing the record's outcome with the latest grade).
- Machines without the ladder record no evidence (the log's own design).
- Pre-existing, outside this change: the unpinned actions route can mark an arm shipped without a PIN; it no longer grades.

## Full Findings Catalog

Round dispositions are in the working notes kept with this report (`r1-findings.md`, `r2-findings.md`); every reviewer's full text is in the convergence session transcript.
- **Security:** forged grades through the unpinned actions route (round 1); raw error messages (round 2); operator grader names on the open evidence route (round 3).
- **Scalability:** converged from round 1 (precision only).
- **Adversarial:** self-grading via action completion (round 1); agent ships first to block a rejection (round 2); converged round 3.
- **Integration:** multi-machine claim, no-action via deferral, regrade after reopen (round 1); converged round 2.
- **Decision-completeness:** docs versus code, missing rows (round 1); default grader (round 2); reserved-name row (round 3, precision).
- **Lessons-aware:** docs versus code, first-versus-latest, recurrence signal (round 1); converged rounds 2 and 3.

## Convergence verdict

Converged at the round cap (3 of 3). The internal lenses converge apart from the one round-3 security point, which is fixed and tested; the cross-model round-3 points are fixed and listed above. No data-loss or safety finding remains open. The spec is the agent's to approve: it changes neither the constitution nor a protected path.
