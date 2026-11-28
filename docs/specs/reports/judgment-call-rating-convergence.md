# Convergence Report — Judgment-call rating

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through Echo's installed codex CLI (`gpt-6.2-astra`, `status:ok`)
in every round: six review rounds, then three verification passes under the Chief of Staff's ruling
(a). The round 1 first attempt degraded (the whole standards registry was too large as context) and
was rerun with excerpts. The internal reviewers ran on the session model (Claude Opus 5.5) every
round. The Standards-Conformance Gate was unavailable in rounds 1–6 (the M5's copy degraded; the
Studio unreachable from the M5) and then ran **authoritatively on the Studio four times** (21:48,
21:55, 22:02, 22:11 PT; 102 standards, `degraded: false` each time) through Studio Turns.

## ELI10 Overview

Some Instar rules depend on judgment: is this change risky enough for the careful process, did the
review really weigh the risks. The standards promise each such call is written down with its
context and graded, and nothing graded them. This spec keeps each Instar commit's short reasoning
and fingerprints in its commit record, refuses a passing commit whose record cannot be saved, and
adds a two-judge grader. The judges first propose a tier from the change alone, blind to what the
author declared and to the gate's suggestion, and never see what happened to the change later.
Reverts and blamed commits are used afterwards to check the judges, at the pull-request level.

## Original vs Converged

- **Originally:** copy the context into the record, mirror every record into the decision journal
  from the commit hook, rate a sample of records.
- **Converged:** no journal rows at all (the journal rotates, is per machine, and feeds the drift
  detector); no network call at commit time; the record keeps the short reasoning, object ids,
  `headCommit` and heading presence; each landed call is identified through its carrying commit and
  judged in two stages on its own rebuilt diff; stage 1 is blind to declared tier, suggested tier
  and risk floor; calibration by landing cohort with a 30-day follow-up, from per-call ledgers in
  the published totals; the CI check's coverage gap measured every run; the only new refusal is a
  passing commit whose record cannot be saved.

## Iteration Summary

| Pass | Internal (Opus 5.5) | GPT reviewer | Standards-Conformance Gate | Material / blocking |
|---|---|---|---|---|
| Round 1 | 2 reviewers, 3 lenses each | ok, serious | unavailable: M5 degraded (error); Studio unreachable | 17, all addressed |
| Round 2 | 1, all lenses | ok, serious | unavailable (not re-run) | 12 |
| Round 3 | 1 | ok, serious | unavailable | 9 |
| Round 4 | 1 | ok, serious | unavailable | 11 |
| Round 5 | 1 | ok, serious | unavailable | 5 |
| Round 6 | 1: converged | ok, serious | unavailable | 4 + 10 minor, applied |
| Verification 1 | 1: not clean | ok, serious | ran on c3dff0293: 10 flags, 5 changed the spec | 9, applied |
| Verification 2 | 1: not clean | ok, serious | ran on 56eb45787: 10 flags, none needed a change | 6, applied |
| Verification 3 | 1: clean | ok, serious | ran on 132dfa17: 7 flags, none | 4 GPT, applied |
| Cycle 1 (stop rule) | 1: **no blocking findings**, 7 edge | ok, 4 points, all edge under the rule | ran on abae9319: 8 flags, 2 small text fixes | **0 blocking** |

Stop rule (Chief of Staff, 2026-11-27 22:11): at most two more cycles; stamp converged when a
verification pass has no blocking finding (one that changes the data model, who can write, what the
judges see, or what gets refused); edge findings settled by a local fix plus a test are fixed and
listed here.

## Found in the final pass and fixed

From the GPT reviewer (cycle 1, on b457f0469), each classified edge:
1. Two graders could both publish after the pre-publish check. Fixed: the predecessor id is the
   idempotency key and readers settle a fork deterministically (earliest successor wins, the other's
   retry ids merged); acceptance 13.
2. The standard question mixed citation and alignment. Fixed: split into a citation question and a
   diff-dependent alignment question.
3. Artifacts were checked against the PR's final tree, so a later edit could disqualify an earlier
   call. Fixed: read and verify at the call's carrying commit. **Closest call to blocking:** it
   changes which version of the artifact the judges see. It is classed edge because the design
   already requires each call to be judged on its own work and the final-tree read contradicted
   that; it is settled by one local fix and one test (acceptance 13).
4. A family outage could overwrite forced dispositions. Fixed: forced dispositions are final; only
   questions needing a judge become `incomplete`; acceptance 10.

From the in-house reviewer (cycle 1), each edge: the one-writer section overstated the lease
(reworded to the `machines` pin and the per-machine live-run guard; no cross-machine lease is
claimed); landing used today's scope rule (now the carrying commit's parent tree); duplicate
records landing the same change (latest only); the cost estimate (recomputed per stage); null
declared tier never in `belowFloor` (derived effective value, labelled); grader version in
calibration (one version per cohort); "unavailable spec body" for spec-less Tier 1 calls (defined).

## Proportion

Tier 2: one new refusal at the commit gate and a weekly grading job. The design stopped moving in
round 5; later passes found edge cases, each real, none repeated.

## Left behind (named, not deferred)

- Three judgment-bound labels with no chokepoint: to Justin via Pipeline Strategy's group re-date.
- The countdown wording (record, not journal, as the durable surface): proposed in the
  countdown-closing registry PR after the first published rating run, with Justin's approval.
- The CI presence check's in-scope drift: named, not changed here.
- Calibration will rarely report before about late January 2027; the countdown closes on ratings.
- Gate flags kept with reasons: see the dispositions list in the benchmark session's notes.

## Full Findings Catalog

Every round's findings and dispositions are in the session's working notes and review outputs
(`.instar/state/handoffs/project-alignment/countdown-judgment-call-rating/` on the M5:
`r1-codex.json` to `r10-codex.json`, `gate-dispositions.md`, `notes.md`), and the Studio gate
reports under `.instar/state/handoffs/studio-turns/conformance-judgment-call-rating-*.json`.

## Convergence verdict

Converged under the Chief of Staff's stop rule: cycle 1's verification pass had no blocking finding
from either reviewer; all edge findings fixed and listed above.
