---
title: "Correction analyzer groups reworded records of one preference by meaning"
slug: "correction-meaning-grouping"
author: "echo"
parent-principle: "Signal vs. Authority"
parent-spec: "docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md"
eli16-overview: "docs/specs/correction-meaning-grouping.eli16.md"
commitment: "CMT-1034"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-10-29T17:34:00Z"
approved-via: "Build brief for CMT-1034 (topic 95267, 2026-10-29): make the analyzer group reworded records by meaning with deterministic complete-link bounds, keep the gate thresholds, enable the correction-analyzer job on this development agent only. Stands on Justin's standing approval for Jev work (topic 95267) and his standing direction that only constitution changes need him (2026-09-28, both repos since 2026-10-22). No constitution change. Revocable: meaningGrouping.enabled false (live) or revert."
review-convergence: "2026-10-29T18:30:00Z"
review-iterations: 1
review-completed-at: "2026-10-29T18:30:00Z"
review-report: "upgrades/side-effects/correction-meaning-grouping.md"
single-run-completable: true
---

# Correction analyzer groups reworded records of one preference by meaning

## Problem statement

The Correction & Preference Learning ledger held 131 open records on
2026-10-29, every one with `occurrenceCount` 1, and no preference has ever been
produced (`GET /preferences/session-context` → `present: false`).
`CorrectionAnalyzer` groups open same-kind records before its recurrence gate
(4 qualifying occurrences, 2 distinct days, 2 distinct sessions for a
preference) using normalized-token Jaccard at 0.65, complete-link. A user who
repeats a preference does so in new words, so the distilled `learning` strings
share few tokens: measured on the live `learning` field, true repeats score
0.07–0.50 (e.g. "approval only for constitution changes" ×2 = 0.50; the three
"remove the test bottleneck" records = 0.07–0.25). Zero pairs reach 0.65, so the
gate can never pass and the `correction-analyzer` job was left disabled.

## Proposed design

A second edge source for the analyzer's existing complete-link clustering.
Module: `src/core/JevCorrectionGrouping.ts` (`JevCorrectionGrouper`).

1. **Candidates.** Same-kind pairs whose word overlap (the analyzer's own
   Jaccard over normalized tokens) is at least `candidateFloor` (0.05). Below
   the floor a pair gets no meaning edge and is never sent anywhere. On the
   live corpus: 583 of 5,865 same-kind pairs.
2. **Jev question.** One TypeSafe `systemone` call per pair, one choice question
   asked in both option orders: `same` ("the same core rule or preference …
   one note may add extra detail"), `related`, `different`, `cannot_tell`.
   pSame = min(P(same) forward, P(same) reversed). Above 0.7 → same; below
   0.3 → not same; inside → unsure (the shared `DEFAULT_CASCADE_BAND`).
3. **Referee (the Jev cascade default).** Unsure pairs go to GPT-6 Luna through
   the Codex fast tier (`askReferee` in `JevCascade.ts`, its own provider and
   breaker built in `server.ts`). `true` → same; `false` → not same; timeout or
   error → stays unsure (no edge; asked again next run).
4. **Edges and clustering.** An edge between two records is Jaccard ≥ 0.65
   (unchanged) OR a cached `same` verdict. `clusterCorrectionRecords` is
   unchanged otherwise: stable creation order, a record joins a cluster only
   with an edge to EVERY member, so A~B~C bridges stay rejected whichever source
   an edge came from.
5. **Cache.** `.instar/state/correction-pair-verdicts.json`, keyed by the sorted
   pair of dedupeKeys (a dedupeKey hashes the normalized learning, so a verdict
   can never describe different text) plus question version and model. Each
   run keeps only current candidate pairs, so the file is bounded by the
   candidate count.
6. **Bounds.** ≤ 800 Jev calls and ≤ 24 referee calls per run, a 240 s run
   budget, 3 s Jev fetch timeout, 4 Jev and 3 referee calls in flight. Pairs
   left over are `deferred` (no edge this run) and asked next run.
7. **Egress hygiene.** Learnings are already post-scrubbed in the ledger; each
   note is scrubbed again with `scrubForStore` and cut to 600 characters before
   it leaves the machine; a scrub failure or private-key marker skips the pair.
8. **Audit.** Content-free rows (pair key, probabilities, verdict, ms) in
   `logs/correction-meaning-grouping.jsonl`; every Jev call metered in feature
   metrics as `correction-meaning-grouping`; the referee call is attributed
   `CorrectionMeaningGrouping`.
9. **Surfaces.** `POST /corrections/analyze` awaits
   `analyzer.refreshMeaningGrouping()` first and adds `grouping` (the run
   report: mode, candidates, cached, jevCalls, refereeCalls, sameEdges,
   unsurePairs, deferred) plus `analysis.groups` / `analysis.largestGroup`.
   New `GET /corrections/groups` serves the current groups from cached verdicts
   only (no model calls), scrubbed summaries and metadata only, never raw
   `learning`.
10. **Gating.** `monitoring.correctionLearning.meaningGrouping.enabled`, omitted
    ⇒ dev-agent gate (live on a development agent, dark on the fleet), read
    live per run. No key, disabled, or an error → `mode: 'words'`: the analyzer
    behaves exactly as before.

## Decision points touched

The recurrence gate (unchanged thresholds) and the routing driver (unchanged)
remain the only authorities. This change only adds grouping edges; it is a
signal feeding them. Complete-link keeps the bound deterministic.

## Measurement

`docs/measurements/2026-10-29-correction-meaning-grouping.md`: question wording
comparison, the 583-pair distribution on the live `learning` field, referee
outcomes, and the groups formed on the live records, each read to check it is
one preference.

## Rollout

Dev-gated. On this development agent the `correction-analyzer` job file
(`.instar/jobs/schedule/correction-analyzer.json`, agent-local) is set
`enabled: true`; the fleet default stays off. Rollback:
`meaningGrouping.enabled: false` (live) restores word-only grouping; preferences
already written are ordinary entries in `.instar/preferences.json`.

## Multi-machine

Machine-local by design, like the correction ledger it reads: the pair cache is
derived data from this machine's ledger and is rebuilt from scratch by asking
again.
