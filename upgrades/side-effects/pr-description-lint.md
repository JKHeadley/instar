# Side-Effects Review — pull-request description lint at open time

**Version / slug:** `pr-description-lint`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy session, topic 150026)`
**Second-pass reviewer:** `not required (CI-only warning; no gate, sentinel, session or messaging surface)`

## Summary of the change

This adds a new GitHub workflow, `.github/workflows/pr-description-lint.yml`, and its script, `scripts/pr-description-lint.mjs`, with unit tests (`tests/unit/pr-description-lint.test.ts`) and an ELI16 note (`docs/specs/pr-description-lint.eli16.md`).
- It runs on every pull request, whatever its base, on opened, edited, synchronize, reopened and ready_for_review.
- It runs safe-merge's own merge-time body checks (`runLocalBodyChecks`: eli16, decision-audit, release-fragment, imported from `scripts/safe-merge.mjs`), plus the UX Impact rule (`scripts/ux-impact-lint.mjs`, run as a subprocess).
- It reports warnings only: one warning annotation per failing check and a job summary. The job uses `continue-on-error`, always exits 0, and is not a required context.
- For a failing UX check, it adds a plain hint when an apostrophe inside the UX Impact section breaks the lint's quote matching.

Tier 1: four new files and no change to existing code. Effort: one design pass; the tests ran three times (one test-syntax fix, then one expectation fix).

## Decision-point inventory

- `safe-merge local floor body checks` — pass-through. It is read and reused unchanged, and its verdicts are only displayed earlier.
- `ux-impact-lint` — pass-through. It is run unchanged, with the same literal author scope as its own gate.
- No new decision point: the workflow cannot block a merge, an admission or a push.

---

## 1. Over-block

No block/allow surface, so over-block does not apply. A false warning costs a reader a few seconds, and the merge-time floor stays the decider.

---

## 2. Under-block

No block/allow surface, so under-block does not apply. As a warning it can still miss these cases:
- **A re-run of an old workflow run** judges the event's frozen body. The ELI16 gate re-reads the live body to avoid that; this lint does not. Every edit starts a fresh run, so a stale warning lasts only until the next edit, and it can never block.
- **A head whose objects cannot be fetched** produces a "could not run" warning instead of the check rows.

---

## 3. Level-of-abstraction fit

This is a signal producer at the CI layer. It feeds the authors who act on it. It re-implements nothing: the body functions are safe-merge's exported ones, so the early answer cannot drift from the merge-time answer. Admission stays with the verifier's admission reader, and merging stays with safe-merge.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It is a pure signal: warning annotations plus a summary, `continue-on-error: true`, exit 0 on every path (including internal errors), and no required-context registration.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

It adds no static heuristic at a competing-signals decision point. It displays the outputs of existing floors and decides nothing.

---

## 5. Interactions

- **Shadowing:** it runs beside the existing main-only ELI16, decision-audit and release-fragment gates and the path-scoped UX gate. For a pull request aimed at main, the same verdict appears twice: once from the gate, once as this warning. That is intentional and harmless. It shadows nothing.
- **Double-fire:** the existing gates fail a main-based pull request, and this lint only warns. Nothing else acts on its output.
- **Races:** the concurrency group, keyed by pull request with cancel-in-progress, keeps only the latest run.
- **Feedback loops:** none.

---

## 6. External surfaces

- **GitHub:** one extra check row per pull request, "Description early warning", which always succeeds, with warning annotations. It is read-only (`contents: read`), and it runs on `pull_request`, never `pull_request_target`, so forks get no secrets.
- **Checker trust:** the code is checked out from the default branch, never from the pull request's head, so a pull request cannot change the check that judges it.
- **Other agents, users, persistent state:** none. Nothing is installed into agents, and no runtime source changes.
- **Operator surface:** none.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or operator form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and in fact machine-free.** It runs only on GitHub's hosted runners, holds no state, emits no user-facing notices and generates no URLs. A second agent machine changes nothing.

---

## 8. Rollback cost

Revert the commit, or disable the workflow in the repository's Actions settings. There is no data, migration or agent state to repair.

---

## Conclusion

Safe to ship as a Tier 1, CI-only early warning. It closes the gap where stacked pull requests (21 open at 11:00 PT on 2026-11-27) met their first description refusal only at merge time, after a verifier run.

## Second-pass review (if required)

Not required (not a gate, sentinel, watchdog, session or messaging change). An independent rule 7 read will be asked for before queueing, as for every change.

## Evidence pointers

- `tests/unit/pr-description-lint.test.ts`: 13 tests pass. Among them: verdict parity with `runLocalBodyChecks` on both sides, the CLI never blocking, and the workflow's base-agnostic, read-only, default-branch properties.
- The existing gates' `branches: [main]` filters in `eli16-pr-gate.yml`, `decision-audit-gate.yml` and `release-fragment-gate.yml`.
