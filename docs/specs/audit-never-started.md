---
title: Required audits — a register that makes recurring audits actually run
slug: audit-never-started
author: echo (Pipeline Strategy; owner of the 21 Dec countdown cliff, assigned by the Chief of Staff 2026-11-27)
status: draft
closes: the mechanism for STD-SUBCOUNTDOWN-audit-never-started (registry, *Iterative Audit to Convergence*; due 2026-12-21; build date 2026-12-14). The countdown itself closes when the single registry PR for the 21 Dec cliff, merged after this, retires the unenforced sentence and lists these files under "Applied through".
tier: 1 (proposed; a revert undoes it, and it adds no runtime behaviour)
eli16-overview: docs/specs/audit-never-started.eli16.md
---

# Required audits

## The obligation

*Iterative Audit to Convergence* holds that an audit is never one-off. The registry names the gap: "nothing makes an audit RUN — a sweep that is simply never started satisfies no check". The countdown `STD-SUBCOUNTDOWN-audit-never-started` owes a mechanism by 21 December.

## What exists today (main 4185b651, 2026-11-27)

- `scripts/write-audit-convergence.mjs` stamps `converged:` on a report under `docs/audits/` only when its ledger earns it. The commit gate and `tests/unit/audit-convergence-reports.test.ts` re-check the form. Each converged report carries `audit: <id>` and `converged: <ISO time>` in its frontmatter. There are 67 reports.
- The family (area) audits are already forced to re-run, but by content and not by time: `scripts/standards-coverage.mjs --check` fails an area audit whose area text hash changed.
- Nothing lists which audits must recur, or notices when one never started or has lapsed.

## Design

1. **The register**, `docs/audits/required-audits.json`. It holds one row per audit that must recur on a clock:
   - `id`: the audit's id;
   - optional `reports`: other ids its past reports used;
   - `scope`: one sentence;
   - `owner`: the session that runs it;
   - `cadenceDays`;
   - `firstDueBy`: a real calendar date, one cadence after the audit's last report, stamped or not, else about one month from merge;
   - optional `dueReason`.

   A row matches a report whose frontmatter `audit:` id, or (when it declares none) whose file name, is the row id or a `reports` id, exactly or with a `-YYYY-MM-DD` suffix. Unknown keys are refused. Family audits are not rows: the register names them by reference (`"contentTriggered"`), because their re-run trigger already exists, and counting them twice would create a second, conflicting clock. A retired row moves to `"retired": [{"id", "reason"}]`.

2. **The check**, `scripts/lint-required-audits.mjs`. For each row it finds the newest converged report matching the row's `id`, then sorts the row into one of four states:
   - **ok**: a converged report exists and is newer than `cadenceDays` plus 14 days of grace;
   - **never started**: no converged report, and `firstDueBy` has passed;
   - **overdue**: the newest converged report is older than `cadenceDays` plus 14 days;
   - **not yet due**: none of the above.

3. **Structure fails the build; dates do not.** The check runs on every commit, but in two parts. It fails the build only on *shape* and on an *unexplained snooze*. Shape means a row without an id, owner, scope, cadence or real date, a duplicate id, or an unknown key. An unexplained snooze is judged against main's copy of the register, which is read from git the same way the back-reference baseline is. It is a row that moved its `firstDueBy` later or lengthened its `cadenceDays` without a *new* `dueReason`, or a row removed without a `retired` entry and reason. Emptying the list counts as removing every row. *Never started* and *overdue* are reported by name on every run. Every morning, the Feature maturation owner's existing daily watch (`.instar/scripts/standards-countdown-watch.py`, 08:00) also messages each owner about their lapsed rows, and gives the Chief of Staff the list. A date-triggered build failure is exactly what stopped every commit on 27 November, when one countdown passed. The article asks that audits *run*, not that the whole project stops when one is late.

4. **A scheduled check makes a lapse visible outside the commit path.** A weekly workflow, `.github/workflows/required-audits-cadence.yml`, follows the existing `standards-area-audit-cadence.yml` precedent. That precedent says "elapsed age is reported, never used as a blocking proxy". The workflow runs the check and keeps one marker-owned issue open while any required audit has lapsed, and closes it when none has. So a never-started audit no longer passes silently: it is named every week in a public place, and every morning to its owner. The commit gate stays a format check (the documented exemption class in *Signal vs Authority*). `--fail-on-lapsed` exists for anyone who wants a hard exit, but neither the commit chain nor the workflow uses it.

## Seed list (to be confirmed by the Chief of Staff on Monday 30 November)

| id | cadence | owner |
|---|---|---|
| security review of auth, credential and identity surfaces | 90 days | echo-identity-and-security-levels |
| keyword-intent classification audit | 90 days | echo-engine-feature-optimization |
| bounded judgment-input review | 90 days | Pipeline Strategy |
| LLM decision accountability | 30 days | echo-instar-benchmark |
| local and CI test parity | 30 days | echo-scaling-the-test-line |
| unlanded-work census | 30 days | echo-machine-stewardship |
| Substrate membership sweep | 365 days | Pipeline Strategy |

Each row's `firstDueBy` is one cadence after its last report, or one month from merge for a row with no report yet.

## Stated limits

- The check proves that a converged report exists and is recent. It cannot prove the audit was deep. That stays with the convergence validator and its reviewers.
- An audit that should recur but is never put in the register is still unseen. Adding a row is a review judgement, and the register's owner is named in the registry text.

## Open questions for review

- Q1: Is 14 days the right grace period, or should it scale with the cadence (for example a quarter of it)?
- Q2: Should the weekly scheduled job also post to the Chief of Staff's conversation, or is the 08:00 watch enough?
- Q3: **Reports from before the validator.** Five of the seven seed audits have only reports with no `converged:` stamp, because they predate `write-audit-convergence.mjs`. These are the two conversation-graph security reports of 2026-11-05, `keyword-intent-classification-audit-2026-07-03`, `local-ci-test-parity` and `unlanded-work-census`. Draft rule: only a stamped report counts as a run, and an unstamped match is listed as "ran, not converged". With dates set one cadence after each last report, three rows read *never started* on the day this merges (keyword-intent, local-CI parity and the unlanded census), and the security review is not yet due (3 February 2027). That tells each owner the next run must go through the validator. None of it fails a commit. Should that be the rule, or should an unstamped report count once, as the baseline?
