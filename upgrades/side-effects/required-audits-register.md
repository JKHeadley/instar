# Side-Effects Review — required audits register (audit-never-started)

## Summary of the change

This closes `STD-SUBCOUNTDOWN-audit-never-started` (*Iterative Audit to Convergence*): "nothing makes an audit RUN — a sweep that is simply never started satisfies no check". The change has four parts:
- `docs/audits/required-audits.json` lists the audits that must recur on a clock. It has seven proposed rows, pending the Chief of Staff's confirmation on 30 November. Family audits are named by reference only, because their content-change trigger already exists in `standards-coverage.mjs`.
- `scripts/lint-required-audits.mjs` joins the commit-time lint chain. It fails only on the register's *shape*, and reports never-started and overdue audits by name.
- `.github/workflows/required-audits-cadence.yml` runs weekly and never blocks. It keeps one marker-owned issue open while anything has lapsed, the same pattern as `standards-area-audit-cadence.yml`.
- Agent-local, so not part of this diff: the Feature maturation owner's daily watch (`.instar/scripts/standards-countdown-watch.py`, 08:00) now reads main's register and messages each owner about their lapsed audits.

## Decision-point inventory

- The commit-time check blocks a commit whose register is malformed. That is a closed-world format invariant, not an open-domain judgement.
- No date ever blocks a commit. Lapses are signals.

## 1. Over-block

A commit is refused only in these cases:
- **A malformed register:** a row with no id, owner, scope, whole-number cadence or real calendar date; a duplicate id; an unknown key; an empty `dueReason`; or a `retired` entry with no reason.
- **An unexplained snooze, judged against main's copy:** a row moved later, lengthened or removed without a new recorded reason.

Each is fixable in the file itself. A lapsed audit never refuses a commit, by design: on 2026-11-27 a passed countdown date stopped every commit for two hours.

## 2. Under-block

- A shallow audit that still converged passes. That is the convergence validator's job.
- An audit that should recur but was never listed is unseen. Adding a row is a review judgement.
- Only a stamped report counts as a run. On the day this merges, three seed rows whose only reports predate the validator read *never started*: keyword-intent, local-CI parity and the unlanded census. The security review is not yet due. Spec question Q3 asks whether an unstamped report should count once, as the baseline.
- The snooze comparison reads main's copy at the merge base with the first of `origin/main` (a CI checkout), `JKHeadley/main` (an agent worktree) or `main` that has the register. A ref without the register falls through to the next. When none has it (the first introduction) or none exists (a shallow or detached checkout), the comparison is skipped and a NOTE says so. On the first introduction there is nothing to compare against, so it is skipped by nature.
- Small, accepted: a new `reports` alias needs a new reason, but a reviewer must still judge whether the alias is honest.

## 3. Level-of-abstraction fit

The register sits beside the reports it governs (`docs/audits/`), and the check reuses the report frontmatter that the validator already writes (`audit:` and `converged:`). Area audits stay with `standards-coverage.mjs`, so nothing has two clocks.

## 4. Signal vs authority compliance

The blocking part is a format invariant at a dev-process chokepoint: the documented exemption class in `docs/signal-vs-authority.md`, the same as the convergence gate. Elapsed age is only a signal: printed on every run, sent daily to owners, and shown in a weekly issue.

## 4b. Judgment-point check

There is no judgement in the check. Which audits must recur, and how often, is a review decision recorded in the register (the Chief of Staff confirms the seed list).

## 5. Interactions

- It reads `docs/audits/*.md` frontmatter only, and writes nothing.
- The weekly workflow uses a distinct marker (`required-audits-cadence:v1`) and title, so it never touches the area-cadence issue.
- The daily watch's new reader returns nothing until the register is on main.
- Merge order: this change and two other open changes from the same author each add one entry to the single `"lint"` line in `package.json`. Whichever merges second needs a fresh merge with main.

## 6. External surfaces

None at runtime, and agents are unaffected. On GitHub, the weekly job opens or closes one issue authored by `github-actions[bot]`. Interpolated text is escaped the same way as in the area-cadence workflow.

## 6b. Operator-surface quality

The weekly issue names each lapsed audit, its owner, its last converged date and the two ways to resolve it. The daily owner messages say the same.

## 6c. Delight the user

No user-facing surface.

## 7. Multi-machine posture

Repository files are the same on every machine. The daily reader runs on the machine where the Feature maturation owner's session lives, and reads `JKHeadley/main`, so it is machine-independent. That is the same posture as the maturation overdue reader.

## 8. Rollback cost

Revert the change. The register and workflow go away, and the daily reader goes quiet again.

## Conclusion

The rule's never-started gap now has a named owner and a recurring, visible signal, without making the project's commits hostage to a calendar.

## Second-pass review (if required)

Reviewer: independent read-only subagent for Pipeline Strategy. Round 1 DISSENTed (.instar/state/handoffs/reviews/second-pass/echo-pipeline-strategy-audit-never-started.md), with four blocking findings, all fixed:
- **(1)** The script's main guard skipped a symlinked path (/var on macOS) or a path with a space, so the daily reader never ran. The guard now compares real paths, and a test covers it.
- **(2)** The lint was missing from `tests/unit/lint-chain-completeness.test.ts`; it is now added.
- **(3)** The header claimed the registry already cites the lint. It is reworded: the registry text that closes the countdown ships in the single registry PR for the 21 Dec cliff, per the Chief of Staff's 27 November split ruling.
- **(4)** A row could be snoozed or removed with no reason. It is now checked against main's copy.

Round 2 DISSENTed on one item (same file, section "Re-review (round 2)"): the comparison looked only for `JKHeadley/main`, so it was skipped in a CI checkout whose remote is `origin`. Fixed: it tries `origin/main`, `JKHeadley/main` and `main` in turn, and a ref without the register falls through. A git-fixture test with an `origin` remote covers both sides. Also fixed: a whitespace-only change no longer counts as a new reason, and a new `reports` alias needs one.

After round 3, a comment-only change, required by the commit-time lint `lint-no-direct-destructive`: the lint script gained a line-2 `// safe-git-allow:` naming its read-only git calls (the same form as the reviewed back-reference follow-up), and the test file gained the standard test-file `safe-git-allow` line. No code changed.

Round 3: **CONCUR** (same file, section "Re-review (round 3)"). The reviewer built git fixtures with an `origin` remote and found that, on a normal PR checkout or CI's merge checkout, the lookup cannot be made to skip the comparison.

Also fixed: seed dates now follow the spec's rule; the false day-one claim is corrected; the security row matches its real reports through `reports`; the workflow leaves the issue untouched on a malformed register; the daily reader can no longer break the countdown alert and extracts safely; CRLF frontmatter is read; `--today` is validated; unknown keys are refused; and the header contradiction about `--fail-on-lapsed` is resolved.

## Evidence pointers

- `tests/unit/lint-required-audits.test.ts`: pure parts and the command, covering both sides of each boundary.
- On the real tree on 2026-11-27: 7 rows and 4 lapsed. llm-decision-accountability is overdue (last converged 2026-07-12, monthly); keyword-intent, local-CI parity and the unlanded census are never started (their only reports are unstamped).

## Review binding (2026-11-28)

The independent reader's concurrences (echo-pipeline-strategy-audit-never-started.md) cover this change. This section and a fresh trace were written after the final merge of main d42c7aa6db into 6a66a3343f, so the trace covers every path the PR changes as it now stands.
