# Convergence Report — Framework Stall-Coverage Matrix

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in EVERY round (5/5 rounds, status ok each time). This is the clean RAN state — no ⚠.

## ELI10 Overview

An AI agent's work session can get stuck in a countable number of ways — killed mid-sentence by a server restart, sitting at a prompt ignoring messages, poisoned so every reply errors, walled by a usage limit, and so on. Until now, each framework's recovery machinery covered only the stall types its author had personally seen, so every unseen type was an invisible hole that failed silently in production (that's exactly how the drive-5 defect #9 two-hour stall happened). This spec makes the list of stall types itself official, and requires every framework being onboarded onto Instar to file a coverage matrix: for each stall type, either name the exact detection+recovery machinery with a test proving it fires, or declare the gap honestly with a tracked plan, or prove the type can't happen. Blank cells are illegal; CI re-checks every matrix on every push; a weekly self-check keeps the live parts honest; and every human sign-off is a challenge-anchored, content-bound record that can't be faked or replayed.

The main tradeoffs: the matrices cost authoring effort (four seed files ship with the build), the enforcement gate ships in observe-only mode first (it logs what it would refuse before it refuses anything), and the richer live-metering surface is deliberately a tracked follow-up rather than part of this build.

## Original vs Converged

Originally the standard was mostly a format: enumerate the classes, fill the cells, check symbols exist. Review found that version was gameable from a dozen directions — a "covered" claim needed no human review, a "covered-dark" label needed no proof the machinery even existed, evidence could point at any file, declared gaps could cite dead tracking refs forever, the seed matrices would never be re-checked after merge, acceptances could be fabricated or replayed, and the degraded no-source mode could be manufactured to dodge every check. The converged version closes each of those with structure rather than trust: paths are jailed and size-capped, every status token carries checkable obligations (guard bindings, executable collected evidence, live tracking refs), sign-offs are authenticated challenge-anchored artifacts bound to the exact content accepted, aging clocks are calendar-based with warning rungs before CI ever turns red, a weekly job re-runs the live checks that transitions alone would never reach, and every degraded or exempt path is a named, recorded verdict instead of a silent downgrade. Scope also got honest: all four frameworks get seed matrices (not just the two the author runs), the observability join moved to a tracked follow-up with its enabling mapping table shipped now, and the build lands as two staged PRs.

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Outcome |
|-------|----------------------|-------------------|---------|
| 1 | all six internal + codex + conformance gate (1 flag) | ~20 (deduped) | full rewrite, 309→505 lines |
| 2 | security, adversarial, integration, scalability, lessons, DC + codex | 8 (deduped; incl. 2 HIGH) | second rewrite, →652 lines |
| 3 | combined A (sec/adv/scal); combined B clean; gate 1 flag (judged editorial) | 3 | surgical edit, →684 lines |
| 4 | all-lens verifier; codex minor | 3 (narrow) | surgical edit, →713 lines |
| 5 | (converged) — all-lens verifier + codex | 0 | none |

Standards-Conformance Gate: ran every round (round 1: Framework-Agnostic flag → resolved by union-derived four-framework seeding; round 2: Observability flag → judged adequate honest engagement; round 3: Testing Integrity flag → resolved by explicit tier mapping; rounds 4-5: carried no new flags through the reviewers).

## Full Findings Catalog

The per-round finding lists, verdicts, and resolutions are recorded in `docs/specs/reports/framework-stall-coverage-matrix-convergence-log.md` (the running log kept during the convergence). Highlights: round-1's path-traversal oracle and requester-as-authorizer acceptance; round-2's covered-dark laundering and seed-matrix dead zone; round-3's acceptance-hash churn and pending-mint aging escape; round-4's provisional-gate seam, fleet provenance backfill, and future-dated seededAt clamp.

## Convergence verdict

Converged at iteration 5. No material findings in the final round (both the all-lens internal verifier and the GPT-tier external pass). Spec is ready for user review and approval — `approved: true` is the operator's step after reading this report.
