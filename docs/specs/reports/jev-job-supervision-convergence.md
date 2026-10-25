# Convergence Report — Jev job-completion audit (observe-only v1)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in EVERY round
(10 of 10, all `status: ok`). A clean-door Anthropic second read
(`claude-code:claude-fable-5`, disclosed separately — it is NOT a cross-model
opinion) also ran every round. The Standards-Conformance Gate ran every round
(findings folded in each time; its one persistent advisory — the 8 KB bound is
derived from the measured trial's size class rather than producer/consumer
capacity — is answered in the spec by making the bound a frozen constant whose
validity the soak's truncated-vs-complete breakout explicitly tests).

## ⚠ Convergence status: STOPPED AT THE 10-ROUND CAP — final round design-quiet, formal criterion not met

Read this before approving. The convergence rule requires **two consecutive
rounds with zero design-class findings**. This spec ran the full 10-round cap
and finished with ONE design-quiet round, not two: the round-10 internal panel
reported NO DESIGN FINDINGS, and round 10's external items (cap accounting
under vendor failure, retry backoff, durable-admission wording, re-weighting
inputs) were bookkeeping-level and are fixed in the final text — but by the
letter of the rule this is `convergence-failed-at-cap`, and the decision to
accept it is yours, not mine. What makes acceptance reasonable: the
architecture has been STABLE since round 8 (capture-then-batch); rounds 9–10
produced no architectural findings, only accounting/wording corrections, and
every one of them is addressed in the final document.

## ELI10 Overview

Instar's scheduled jobs are marked "successful" when their program exits
cleanly — nobody checks whether the work actually happened, and we have four
documented cases of jobs that "succeeded" while doing nothing. This design
saves a small evidence snapshot the moment each job finishes, then a few times
a day asks Jev — the very cheap decision model we measured — whether the
evidence shows the promised work was done, recording the answers alongside a
free deterministic file check so we can measure whether Jev adds anything. It
acts on nothing: no blocking, no alerts, records only. If a trial shows it is
reliable, giving it a voice is a separate future decision.

## Original vs Converged

The review process changed this design more than any spec we've run:

- **It lost its authority-sounding shape.** Originally "Tier-1 job
  supervision" with a live escalation to a second LLM; now honestly a
  "completion audit" — the escalation tier, second vendor, and its whole
  consent/concurrency surface were cut (nothing acts on verdicts, so a second
  uncalibrated LLM refereed nothing).
- **It moved from live to batch.** Originally a live queue/worker-pool judging
  each completion in real time; now capture-at-completion (a durable evidence
  file) plus a batch pass — identical measurement, far less machinery, the
  crash gap closed by construction, and the whole corpus re-runnable against
  future models for free.
- **Its evidence became auditable.** Originally hash-only rows (the exact
  anti-pattern our own research diagnosed in our stores); now full scrubbed
  evidence packs retained machine-local so every verdict can be reconstructed
  and graded.
- **Its claims got honest.** The 0.70 "confidence" line turned out to be
  undefined for Jev's yes/no questions (they return a bare probability, and
  the calibration evidence came from a different question type) — the derived
  quantity is now defined, frozen, and explicitly under test. The 8/8 measured
  result is flagged as a step-level result being extrapolated to run level.
- **Its fields stopped overloading the constitution.** Audit eligibility got
  its own manifest field (`completionAudit`); the constitutional `supervision`
  field is never read.
- **Every counted claim gained a floor or a check**: graduation n-floors with
  extend-until-n, a precision bar, corroboration asymmetry (file existence can
  prove failure, never success), stratified sampling with re-weighting inputs,
  retry brakes with backoff, a capture concurrency cap, and a reconciliation
  that makes coverage loss a checked number.

## Iteration Summary

| Round | Design-class findings | Main outcome |
|---|---|---|
| 1 | ~25 (all six internal + gate + 2 externals) | Provenance, egress, isolation, wiring gaps identified |
| 2 | ~12 | Key-read isolation, jailing, dual-vendor consent, asymmetries |
| 3 | ~6 | Noul-confidence undefined; supervision wiring gap found |
| 4 | ~6 | Crash-gap honesty, corroboration asymmetry, alternatives |
| 5 | ~5 | No-declaredEffects gate bug; graduation floors |
| 6 | ~4 | completionAudit field cut; accounting invariant dropped |
| 7 | ~3 | Escalation tier cut entirely (structural) |
| 8 | ~2 | Batch architecture adopted (structural); honest renaming |
| 9 | 2 | Self-audit exclusion; cap accounting under vendor failure |
| 10 | 0 internal; external bookkeeping items fixed in final text | Design-quiet close |

Standards-Conformance Gate: ran all 10 rounds (4→1 findings, converging).
Cross-model externals: ran all 10 rounds, both families, all ok.
Per-round models: internal reviewers on sonnet-class subagents (disclosed:
the authoring session ran on claude-fable-5); externals codex-cli:gpt-5.5 and
clean-door claude-code:claude-fable-5.

## Full Findings Catalog

The per-round reviewer outputs are retained in the session scratchpad
(jjs-r1..r10-*.md). Every design-class finding and its resolution is
reflected in the spec's own sections; the structural cuts are described in
Original vs Converged above.

## Convergence verdict

Stopped at the 10-round cap with a design-quiet final round. The formal
two-quiet-rounds criterion was NOT met; the architecture has been stable for
the last three rounds and every remaining finding is addressed in the final
text. The spec is ready for the operator's judgment: accept-at-cap and
approve, or fund further rounds.
