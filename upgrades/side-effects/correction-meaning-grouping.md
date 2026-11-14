# Side-Effects Review — correction analyzer groups reworded records by meaning

**Version / slug:** `correction-meaning-grouping`
**Date:** `2026-10-29`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`CorrectionAnalyzer` grouped open correction records only on word overlap
(Jaccard ≥ 0.65, complete-link), which never matched reworded repeats: 0 groups
from 131 live records. New `src/core/JevCorrectionGrouping.ts`
(`JevCorrectionGrouper`) asks Jev, per same-kind pair with word overlap ≥ 0.05,
whether the two records state the same core rule (both option orders, min
P(same)); > 0.70 same, < 0.30 not same, in between to the GPT-6 Luna referee
(`askReferee`). Verdicts are cached per pair of dedupeKeys. `clusterCorrectionRecords`
takes an optional `sameMeaning` lookup: an edge is word overlap at the floor OR
a cached `same`; complete-link is unchanged. `CorrectionAnalyzer` gains
`refreshMeaningGrouping()`, `useCachedMeaningGrouping()` and `groups()`.
`POST /corrections/analyze` awaits the refresh and reports `grouping`; new
`GET /corrections/groups` (cached verdicts only). Wiring in `server.ts`
(installed instance with its own Codex referee). Config type
`monitoring.correctionLearning.meaningGrouping`, dev-gated registry entry,
awareness card + `migrateClaudeMd` entry. Tier 1: dev-gated, revert or the live
kill switch undoes it fully. Size: 3 src modules changed + 1 new, 3 test files,
~700 LOC including tests and docs; 1 spec round, first commit attempt.

## Decision-point inventory

- Recurrence gate (`CorrectionAnalyzer.analyze`) — pass-through — thresholds untouched; it now sees larger clusters.
- Analyzer clustering (`clusterCorrectionRecords`) — modify — adds a second edge source; complete-link rule unchanged.
- Pair judgment (`JevCorrectionGrouper`) — add — produces "same?" signals; no authority of its own.
- Routing (`CorrectionLoopDriver.route`) — pass-through — unchanged; routes whatever the gate crosses.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The closest analogue is
over-merging (two different preferences counted as one). Bounded by
complete-link (every member pair must match), by the "same core rule" question
checked in both option orders, and by the unchanged 4/2/2 gate. Measured: 7
groups on the live corpus, each read and confirmed to be one preference.
Residual risk: a "hub" record that Jev matches broadly (record 057 matched 8
records) could pair with one borderline partner if creation order puts them
together first; the merged group would still need 4 qualifying occurrences
across 2 days and 2 sessions before anything is written, and the written
preference is an advisory hint.

---

## 2. Under-block

Under-merging remains: pairs below 0.05 word overlap are never asked (a repeat
phrased with no shared content word is missed); Jev/Luna say "not same" for some
true repeats (027/037 direct links, Luna false); greedy first-fit can place a
record in a smaller group than the largest clique. These only mean a preference
takes longer to be learned — the pre-change state for every pair.

---

## 3. Level-of-abstraction fit

Right layer. The grouping step is the analyzer's own; this feeds it a better
similarity signal and leaves the gate (authority) where it was. It reuses the
shared Jev cascade helper (`askReferee`, `DEFAULT_CASCADE_BAND`) and the same
TypeSafe call shape as `JevCorrectionShadow`, rather than a new client.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The pair verdicts are signals; the recurrence gate (code-determined provenance
filter + support/day/session prongs) and the driver's policy-relaxation routing
remain the authorities, unchanged. An LLM verdict can never by itself write a
preference: it can only make records count together, which then still need the
deterministic occurrence evidence.

---

## 4b. Judgment-point check

The new static pieces are bounds, not judgments: the 0.05 prefilter (a cost
floor, measured), the 0.3/0.7 band (the shared cascade band), and complete-link
(the existing deterministic diameter bound). The judgment ("same rule?") is
delegated to Jev and Luna. No new static heuristic at a competing-signals
decision point.

---

## 5. Interactions

- `CorrectionLoopDriver.route()` calls `analyzer.analyze()` again on the same
  analyzer instance; it uses the same loaded verdicts, so routing sees exactly
  the clusters the route handler measured.
- Shares the vault `typesafe_api_key` with the other Jev features; separate per-run caps,
  no shared daily counter. Referee has its own Codex provider and breaker, so a
  referee trip never pauses the shared provider (same pattern as the signal
  shadow and load assessor).
- `GET /corrections/groups` is registered before `GET /corrections/:id` so the
  literal path is not captured as an id (test-covered).
- Runs only inside the weekly `correction-analyzer` job (or a manual
  `POST /corrections/analyze`); no background timer.

---

## 6. External surfaces

- New outbound calls to TypeSafe (≤ 800/run, ~$0.0001 each) and Codex
  (≤ 24/run, subscription) only on a development agent or where enabled.
  Learnings are post-scrubbed in the ledger and scrubbed again + cut to 600
  chars before egress.
- New read route `GET /corrections/groups` (bearer-authed, summaries only, never
  raw `learning`). `POST /corrections/analyze` response gains `grouping`,
  `analysis.groups`, `analysis.largestGroup` (additive).
- New files: `.instar/state/correction-pair-verdicts.json` (0600, bounded to
  current candidates), `logs/correction-meaning-grouping.jsonl` (content-free).
- Timing: a first run on a large backlog takes up to the 240 s budget (the
  live 583-pair first run took 47 s). The server's 30 s default request timeout
  would 408 the job while the handler kept routing, so `/corrections/analyze`
  gets its own 330 s budget (`CORRECTIONS_ANALYZE_TIMEOUT_MS`, test-pinned above
  run budget + one referee call). The job calls the route with plain curl.

---

## 6b. Operator-surface quality

No operator surface touched (no dashboard, approval page or form).

---

## 7. Multi-machine posture

Machine-local by design: the correction ledger is per-machine, and the pair
cache is derived data from it that any machine can rebuild by asking again. No
user-facing notices.

---

## 8. Rollback cost

Live kill switch `monitoring.correctionLearning.meaningGrouping.enabled: false`
(read per run, no restart) restores word-only grouping; or revert the release.
Preferences written meanwhile are ordinary entries in `.instar/preferences.json`
(removable like any other). The cache and log files are inert when off.

---

## Conclusion

Ships as a dev-gated signal into the unchanged gate. Measured on the live
corpus: 0 → 7 groups, all correct; no group crosses the gate yet (largest has 3
occurrences on 1 day), which is the honest current state.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read the diff, not this artifact's conclusions)
**Independent read of the artifact: concern → resolved, then concur**

Concern raised: `POST /corrections/analyze` had the 30 s default request
timeout while grouping may run 240 s; the handler would keep routing after a
408 and the job's Tier-1 check would never see what was routed. Resolved: a
330 s route override + a unit test holding it above run budget + referee.
Minor: `GET /corrections/groups` reported `mode: meaning` with an empty cache —
resolved (`cachedLookup()` is null when nothing is cached, test added). Minor:
two overlapping runs shared one temp file — resolved (per-writer temp name).
Checked fine by the reviewer: complete-link preserved for both edge sources;
cache keying/pruning/version checks; worker cap accounting; band edges; referee
failure leaves unsure; no model verdict alone writes a preference; no raw
learning over HTTP or in logs; route order; dev gate + kill switch read live.

## Evidence pointers

- `docs/measurements/2026-10-29-correction-meaning-grouping.md`
- `tests/unit/JevCorrectionGrouping.test.ts`, `tests/integration/correction-meaning-grouping-routes.test.ts`, `tests/e2e/correction-meaning-grouping-lifecycle.test.ts`
