# Side-Effects Review — pull-request description lint at open time

**Version / slug:** `pr-description-lint`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy session, topic 150026)`
**Second-pass reviewer:** `not required (CI-only warning; no gate, sentinel, session or messaging surface)`

## Summary of the change

This adds two GitHub workflows and one script, with unit tests (`tests/unit/pr-description-lint.test.ts`) and an ELI16 note (`docs/specs/pr-description-lint.eli16.md`).
- `.github/workflows/pr-description-lint-trigger.yml` runs on every `pull_request`, whatever its base. It has no permissions, reads no pull-request text and only prints a line, so it always succeeds.
- `.github/workflows/pr-description-lint.yml` runs on `workflow_run` of that trigger. GitHub always loads a `workflow_run` workflow from the **default branch**, so neither the workflow nor its script can be changed by the pull request it judges, whatever that pull request's base.
- `scripts/pr-description-lint.mjs` reads the pull request **live** from the REST API: title, body, author, and the changed files exactly as safe-merge reads them, plus decision records at the head. It runs safe-merge's own `runLocalBodyChecks` (eli16, decision-audit, release-fragment) and, reported **separately**, the UX Impact rule (`scripts/ux-impact-lint.mjs`, unchanged). It then posts an always-`success` commit status, `description-early-warning`, saying what "would be refused if merged as it stands now", plus warnings and a job summary.
- Every step is `continue-on-error` and the script always exits 0, so this can never produce a red check row on a pull request. That matters because safe-merge refuses on any red row, required or not.

Tier 1: five new files and no change to existing code. Effort: a design pass, then one round after two rule 7 dissents (Jobs and Projects; the Chief of Staff's reviewer), which moved the check to `workflow_run`, separated the UX advice, read live data, and made every step non-failing.

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
- **Fork pull requests:** `workflow_run.pull_requests` is empty for a head in a fork, so those get no warning. Every pull request in this repository is same-repository today.
- **Bootstrap:** the check exists only once this merges, because a `workflow_run` workflow comes from the default branch. So this pull request does not check itself.
- **A run that cannot read the API or fetch the objects** prints a "could not run" warning and posts no status.

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

- **Shadowing:** for a pull request aimed at main, the same verdicts also come from the existing gates. This only adds a status that always passes, and it shadows nothing.
- **safe-merge:** safe-merge reads check rows and commit statuses. Here, the trigger row always succeeds, the `workflow_run` job's rows attach to the default branch rather than the pull request, and the posted status is always `success`. So none of them can ever refuse a merge. Tests pin each property.
- **Races:** the concurrency group, keyed by head sha, keeps only the latest run.
- **Feedback loops:** none.

## 6. External surfaces

- **GitHub:** one trigger row per pull request (always green), one `description-early-warning` commit status on the head (always success), and runs listed under Actions.
- **Permissions:**
  - The trigger has none.
  - The check has `contents: read`, `pull-requests: read` and `statuses: write`. That is the least it needs: it writes only its own status context.
  - Checkout credentials are not persisted. The objects are fetched anonymously, which works because the repository is public.
- **Trust:** the pull request's title, body, files and decision records are data only. They are never executed and never interpolated into a shell line; the body reaches the UX lint as a process argument, not through a shell.
- **Other agents, users, persistent state:** none. Nothing is installed into agents, and no runtime source changes.
- **Operator surface:** none.

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

- `tests/unit/pr-description-lint.test.ts`: 21 tests pass. A dry run against live pull requests #4010, #3890 and the stacked #3767 posted nothing and reported correctly: #3767 lacks an ELI16 section. Among them: verdict parity with `runLocalBodyChecks` on both sides, the CLI never blocking, and the workflow's base-agnostic, read-only, default-branch properties.
- The existing gates' `branches: [main]` filters in `eli16-pr-gate.yml`, `decision-audit-gate.yml` and `release-fragment-gate.yml`.
