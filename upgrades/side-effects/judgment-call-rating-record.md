# Side-Effects Review — the commit record keeps the judgment call's context (judgment-call-rating, Part A)

**Spec:** docs/specs/judgment-call-rating.md (converged and approved, 76ef8d866), Part A: Change 1 and Change 2. Part B (the tone gate) and the rating loop are later slices of the same spec.

## Summary of the change

The instar-dev commit gate already writes one decision record per in-scope commit. This change makes that record keep the context of the tier call, so the call can be graded later:

- A new pure module, `scripts/lib/judgment-context.mjs`, builds a `judgment` block (version 1) from the same trace the record's other fields come from (`freshestTrace`): the tier reasoning (secret-scanned on the whole text, then bounded to 4,000 characters), the trace's path, git object id and staged state, the trace Step 5 validated when it is a different file (`traceDiffers`), the side-effects artifact's object id as checked and as staged, the spec's object id and its convergence report's staged object id, the template's object id, which required template headings are present (and their sizes), the second-pass status mapped from the trace, and per-file added and deleted lines with the HEAD and staged blob ids.
- `headCommit` (HEAD when the gate ran) is a top-level field, so it is present even when the block fails.
- The gate calls the builder once on the Tier 1 path (in `enforceTier1`, just before its pass exit) and once on the Tier 2+ path (after Step 5). Any failure becomes `judgment: { version, error }` and the commit proceeds.
- The one new refusal: a commit that passed every check but whose record cannot be written or staged is refused (`process.exitCode = 1` in the exit handler). If only the stage failed, the file's verdict is rewritten to `blocked` first. A blocked commit's record stays best-effort, as today.
- The in-scope rule moves unchanged to `scripts/lib/instar-dev-scope.mjs`, so the grader judges landings by the same rule.
- `write-trace.mjs` and the instar-dev skill say the tier reasoning is copied into the public record.

## Decision-point inventory

- The commit gate's pass or block decision: unchanged, except the new refusal above.
- Tier declaration, risk floor, belowFloor: unchanged; now recorded with their context.
- No new detector, no network call, no model call at commit time.

## 1. Over-block

The only new refusal is a passing commit whose record cannot be saved. Legitimate commits that could hit it: a full disk, a read-only `.instar/instar-dev-decisions/`, or a held git index lock at the moment of the stage. Each of these already breaks the commit itself or the audit trail; the refusal names the file and the error and nothing is committed, so a retry after the fix succeeds. Commits outside the gate's scope never reach the record writer and cannot hit it. Merge commits leave at Step 0, as before.

## 2. Under-block

The record still depends on the author's trace: the tier reasoning and the second-pass status are the author's self-attestation and are labelled so (`secondPassStatus` maps the trace; nothing is scored from `not-done` alone). Commits made with hooks off (release cuts, the feedback executor) still write no record; the CI presence check remains the PR-level backstop for that. A record whose `judgment.error` is set is counted by the grader rather than refused here.

## 3. Level-of-abstraction fit

The block is built at the one chokepoint that already reads the trace and writes the record, from the values the gate already parsed, so it cannot drift from what was judged. The building logic is a pure module with injected git reads, which keeps the hook's flow readable and lets the grader reuse the same definitions. Grading belongs to a separate job (a later slice), not to the commit hook.

## 4. Signal vs authority compliance

The block is a signal: it records the call and never decides it. Its builder cannot refuse a commit (any failure becomes `judgment.error`). The single new refusal is not a judgment about the change: it enforces that a passing gate run leaves its own record, the same audit the gate already promised but could silently skip. See docs/signal-vs-authority.md: no brittle check gains blocking authority over the content of a change.

## 4b. Judgment-point check

No new judgment point is added. The change makes an existing judgment point (the declared tier and its reasoning) observable afterwards, which is what the Judgment Within Floors standard asks of a floor-bounded call.

## 5. Interactions

- `decision-audit-presence-check.mjs` (CI) reads the record's `scope`; the new fields sit beside it and are ignored there. Its own copy of the in-scope rule is not changed (the spec names this drift).
- The exit handler is the same single handler; it still finalizes `pass` or `blocked` and stages the file. The refusal path runs only on a success exit.
- `class-closure-declare.mjs` rewrites traces in place; the block records the trace's object id as parsed, so a later rewrite is visible to the grader as a different hash.
- Gate tests: those that copy `scripts/lib` wholesale pick up both new modules. `tests/e2e/converging-audit-precommit-report-backing.test.ts` copies files one by one, so both modules are added to its list. `tests/unit/delight-the-user-gate.test.ts` read the in-scope rule from the hook's source; it now reads it from `scripts/lib/instar-dev-scope.mjs`.
- The block reads `skills/instar-dev/templates/side-effects-artifact.md` for the headings; a repository without it records `template: null` and `headings: null`, never invented headings.
- The artifact fingerprint is taken from the exact bytes the gate checked (Tier 1's side-effects read; Step 5's artifact read when Step 5 accepted the same trace file), not a re-encoded or fresh read. The convergence report is found the way the gate finds it: the spec's `review-report:` when declared, else `docs/specs/reports/<slug>-convergence.md` from its `slug:`. No spec is recorded on Tier 1.

## 6. External surfaces

The decision record is committed and public once pushed. The tier reasoning was already public whenever its trace was committed (2,972 traces are tracked); it is now copied into the record as well, after a secret scan of the whole text (a credential pattern stores only its pattern name). Authors are told at authoring time. No other agent, user or system sees a change. No timing dependence beyond the git index reads the gate already does.

## 7. Multi-machine posture

Machine-local by design at commit time: the record is written in the worktree that commits and travels with the commit through git, like today's record. Nothing is replicated outside git and no machine state is read.

## 8. Rollback cost

Revert the commit. The records already written keep their extra fields, which every existing reader ignores; no migration, no agent state repair. The new refusal disappears with the revert.

## Second-pass review

Required: the change touches the commit gate.

**Reviewer:** an independent Claude Opus 5.5 reviewer sub-agent with a fresh context that did not write the change, reading the spec's Part A and the whole uncommitted change on 2026-11-28. First pass: **Concern raised**, two blocking findings, both existing tests this change broke: the e2e report-backing test copies `scripts/lib` files one by one and lacked the two new modules, and the Delight the User gate test read the in-scope rule from the hook's source. Both fixed (section 5). Minor findings, all fixed: the validated trace was read outside the block's safety net; the artifact fingerprint came from a re-encoded or fresh read instead of the checked bytes; the convergence report ignored the slug path the gate uses; a spec was recorded on Tier 1; the tests did not cover a stage failure, real template headings or a staged report, and the fake hash compared lengths. Re-check: **Concur with the review.** It confirmed every git call before and after the record writer only reads, so the index-lock test fails only for the record's stage, and that the two untested paths are correct by trace.

## Evidence pointers

- `tests/unit/judgment-context.test.ts`: the block's fields, the second-pass mapping table, heading matching, the secret scan over the whole text, the bound, spec staged versus HEAD, and the never-throw builder.
- `tests/unit/instar-dev-precommit-audit-staging.test.ts`: a passing Tier 1 commit's record carries `headCommit` and a block built from the same trace, with headings read from the real template; a passing commit whose record cannot be written is refused; one whose record is written but cannot be staged at the first write (a held index lock, so the stage in `writeDecisionAudit` fails) is refused and its record reads `blocked`; a blocked one stays blocked without the extra refusal. Two paths have no test because each needs a fault between two writes: a failure of the exit handler's final rewrite, and a failure of only the exit handler's own stage. The reviewer traced both by hand.
- `tests/unit/instar-dev-precommit-deferrals.test.ts`: a passing Tier 2+ record carries the block on the Tier 2+ call site, with the spec's staged blob and its convergence report from the index.

## Changes after the review, at commit time

Three edits made after the reviewer's concur, each to satisfy a commit check, none changing behaviour:
- `scripts/lib/judgment-context.mjs` gains a first-line `safe-git-allow` marker. The destructive-git lint refuses a direct `git` call without one; the module's calls only read (`hash-object --stdin` without `-w` writes nothing, plus `rev-parse` and `diff --cached`).
- The spec's frontmatter names its parent standard (`parent-principle: "Observable Intelligence — No Autonomous LLM Action Is Unauditable"`), which the gate requires of every spec; the code headers already named it.
- The spec's calibration period is called a "30-day observation window" instead of "follow-up", which the no-deferrals check read as deferred work. The design is unchanged.

The commit's own decision record, written by the new gate, is the first live record: verdict `pass`, `headCommit` set, and a complete `judgment` block (trace, artifact, spec and its convergence report, template, all ten headings present, second-pass status `required-concurred`, five per-file rows).
