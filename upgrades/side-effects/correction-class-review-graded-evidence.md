# Side-Effects Review — Correction class review writes graded evidence

**Version / slug:** `correction-class-review-graded-evidence`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent Opus reader for the Chief of Staff (record .instar/state/handoffs/reviews/cmt-2086-graded-evidence-review.md on the Studio): concur at 830d00212`

## Summary of the change

The correction class review (`src/monitoring/CorrectionClassReview.ts`) and its store (`src/monitoring/ClassReviewStore.ts`) write rows to the shared feature evidence log: a `fired` row per filled review (verdicts only), an `error` row per failed attempt (a fixed code and its stage), and an `outcome` row when the operator decides a proposed arm through the PIN-gated outcome route (ratified/shipped right, rejected wrong, latest decision stands). `transitionOutcome` gains a required `gradedBy` argument; the outcome route in `src/server/routes.ts` passes `operator-outcome`, the unpinned actions-route completion and the store's own deferral pass `null`. The open `POST /maturation/evidence` route (`src/server/maturationLadderRoutes.ts`) refuses operator grader names (`isReservedGrader` in `src/monitoring/FeatureEvidenceLog.ts`). The shared `LadderEvidenceReader` lets only rows inside a metric's where/of take a deduplicated id's slot. The ladder entry's graded-wrong bar (`src/data/feature-ladders.json`) filters on the operator grader. Spec: `docs/specs/correction-class-review-graded-evidence.md`.

## Decision-point inventory

- `ClassReviewStore.transitionOutcome` grading — add — grades an operator decision on a proposed arm; required grader argument.
- `POST /maturation/evidence` — modify — refuses `gradedBy` `operator` / `operator-*` with 400.
- `LadderEvidenceReader` dedupe — modify — out-of-scope rows no longer take an id's last-row slot.
- Ladder graded-wrong metric — modify — counts only `gradedBy: operator-outcome` rows.
- Outcome route and actions route — pass-through — their transitions are unchanged; only the grader argument is added.

---

## 1. Over-block

The evidence route now refuses a POST whose `gradedBy` is `operator` or starts `operator-`. A legitimate external grader using that name would be refused; none exists (the only users of those names are in-process: the class review store and the skill-learning confirm). Nothing else is refused.

---

## 2. Under-block

- A grade is acceptance, a proxy for correctness: a sound proposal rejected for cost counts as wrong (stated in the spec; read with coverage).
- A process death or a failed evidence append between the outcome write and the grade write can leave a stale latest grade on a redecision (stated; visible by comparing the record's outcome with the latest grade).
- "Nothing to do" calls are not graded (follow-up CMT-066).

---

## 3. Level-of-abstraction fit

The grade is written in the store, the one function every outcome path calls, so routes carry no grading logic; the provenance check sits at the open route that accepts outside rows; the dedupe scope fix sits in the shared reader, where every ladder metric benefits.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The rows are evidence read by the ladder and the recurring feature review (which decides moves with two independent readings). The route refusal is a provenance floor on who may write an operator-named row, not a judgment.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals point. The grading map (ratified/shipped right, rejected wrong) is a closed enumeration of the operator's own decision; the judgment of what the grades mean stays with the recurring feature review.

---

## 5. Interactions

- **Shadowing:** none; the grade is written after the outcome update and before the replication emit.
- **Double-fire:** a repeated operator decision writes the same grade again under the same id; the ladder counts one row per id (latest).
- **Races:** `transitionOutcome` is synchronous sqlite in one process; the evidence append follows it in the same tick.
- **Feedback loops:** none; the ladder reads the rows, nothing reads the ladder back into the review.
- The shared reader change affects every ladder metric with `dedupe`: rows outside a metric's where/of no longer overwrite matching rows. All ladder and reader tests pass (LadderEvidenceReader, MaturationLadderService, MaturationLadder, feedback-drain-fleet-bars, recovery-maturation-ladder).
- Identity and Security's class-review action-binding patch rebases after this one (agreed 2026-11-27 17:27) and keeps `gradedBy: null` on the completion call.

---

## 6. External surfaces

- Persistent state: new rows in the existing `logs/feature-evidence.jsonl` (rotated); no new store or column.
- `POST /maturation/evidence` answers 400 for operator grader names.
- Operator surface: none added; the operator's existing PIN-gated outcome choice now also grades.
- Other agents and external systems: none.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard renderer, approval page or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, inherited: the feature evidence log is declared machine-local in `src/data/state-coherence-registry.json` (`feature-evidence-log`, transport none), and a class review's outcome is single-writer on the machine that holds it, so its grade is written once, there. Consequence stated in the spec: each machine's ladder sees only the grades of reviews it holds; the recurring feature review reads every machine's ladder. No user-facing notices, no URLs, no new status surfaces.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. Rows already written stay in the log and the unchanged ladder keeps reading them for their 30-day window; they are identifiable by `featureId` and the `class-review:` grade-id prefix if they must be excluded. No migration, no agent state repair.

---

## Conclusion

Three review rounds (six internal lenses plus Codex each round) and an independent reader's review shaped it: grading moved from any outcome change to operator decisions only, action completion stopped grading, the grader became a required argument, the open route reserves operator grader names, and the shared reader stopped letting unrelated rows erase grades. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent Opus reader for the Chief of Staff
**Independent read of the artifact: concur**

Concurred at 830d00212 after both blockers (out-of-scope dedupe, unhandled rejection in the unit file) were fixed and the reproduction re-run.

---

## Evidence pointers

Whole-file runs on the exact tree 85212189 on main 1d2c1ea8 through the M5 heavy-job wrapper (2026-11-27 18:23 PT): tsc clean; unit 61/61 and 92/92; integration 38/38; e2e 9/9. Convergence report: `docs/specs/reports/correction-class-review-graded-evidence-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change adds evidence writers and fixes a scoping bug in the shared evidence reader (code, not an agent-authored artifact); it adds no self-triggered controller.
