# Side-Effects Review — Structured parked-test recheck outcomes

**Version / slug:** `r3-structured-parked-test-outcomes`
**Date:** `2026-08-18`
**Author:** `Instar-codey`
**Second-pass reviewer:** not required

## Summary of the change

`scripts/recheck-parked-tests.mjs` now classifies a sampled Vitest run from the pinned JSON reporter
and process completion state rather than matching the human `basic` reporter summary. It preserves the
three public outcomes `pass`, `fail`, and `errored`, adds reason-bearing `runDetails`, and keeps the
script's deliberate unconditional exit-zero contract. Focused end-to-end coverage in
`tests/unit/recheck-parked-tests.test.ts` proves altered human wording cannot hide a real failure and
that passing, absent-runner, and unparseable-report cases remain distinct.

This is Tier 1. It is a small, low-risk correction to a non-gating contributor signal; no application
runtime, CI definition, protected action, persistent schema, or external authority changes. The PR is
the independent review surface.

## Build grounding and plan record

- Fresh isolated worktree created with `instar worktree create` from protected `upstream/main` at
  `248ed7177f5bf416aa7bdad9763741478195e1fc`.
- Remotes: `upstream=https://github.com/JKHeadley/instar.git` and
  `origin=https://github.com/JKHeadley/instar-codey.git`.
- Package version before build: `1.3.1180`.
- Problem: a real executed failure became `could-not-run` when human summary wording changed.
- Fix: validate the pinned structured report and keep completed failures separate from unknown runs.
- Acceptance: the pre-fix negative control misclassifies altered wording; the repaired path returns
  `fail`; genuine pass returns `pass`; infrastructure and parse failures return reasoned `errored`;
  the script remains non-gating and exit zero.
- Rollback: revert this pure script/test change; no stored state needs repair.

## Decision-point inventory

- `classifyStructuredResult` — **modify** — classifies a completed sampled run as pass, fail, or
  errored from validated machine-readable evidence.
- Per-file verdict aggregation — **pass-through** — continues to derive deterministic pass/fail,
  could-not-run, or genuinely-flaky from the individual run outcomes.
- Process exit — **unchanged** — remains unconditional zero; this command reports and never gates.

## 1. Over-block

No block/allow surface — over-block is not applicable. A future Vitest schema change can cause a
sample to report `could-not-run` until reviewed, but it cannot block a user action or merge. Strictly
rejecting unknown structured shapes is preferable to assigning them a known test outcome.

## 2. Under-block

No blocking authority is intended. The signal can still be incomplete: it samples a rotating subset,
glob exclusions are reported rather than executed as a single file, and a test may behave differently
in CI. Those limitations are visible and pre-existing. This repair specifically closes the class where
a completed failing run was absorbed into execution error by presentation wording.

An adversarial or internally wrong Vitest JSON report is trusted only after consistency checks; this
change does not independently reimplement Vitest's assertion engine. The dependency is pinned and its
executed package bytes are recorded in the proof record.

## 3. Level-of-abstraction fit

Vitest owns test execution and emits the structured facts. The recheck script owns the bounded mapping
of those facts into its informational outcomes. That is the correct boundary: the wrapper no longer
parses presentation text, and it does not duplicate CI's authority or make the quarantine decision.
Fresh temporary report paths prevent two sampled runs from sharing an output artifact.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The command is explicitly a brittle, cheap detector and remains one. It always exits zero, never edits
the quarantine, and never re-arms a test. Structured validation improves the detector's accuracy; it
does not promote the detector into an authority.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgement point. Process completion, JSON
shape, numeric counts, and assertion statuses are enumerable evidence invariants. Whether a passing
sample justifies removing a quarantine remains outside this script and is not statically decided.

## 5. Interactions

- **Shadowing:** the structured report replaces only the old human-summary regex. The normal reporter
  is retained for operators and cannot affect the verdict.
- **Double-fire:** there is one spawned Vitest process per sample. Multiple reporters observe that same
  process; they do not execute the test twice.
- **Races:** each run owns a unique `mkdtemp` directory and removes it in `finally`. No shared report
  filename is introduced. Cleanup routes through `SafeFsExecutor`; each real invocation therefore
  appends the ordinary allowed-operation entry to the local destructive-operations audit log.
- **Feedback loops:** outcomes are printed and discarded. They do not automatically edit
  `FLAKY_TESTS`, schedule another run, or feed a retry controller.
- **Adjacent CI:** the quarantine continues to narrow configured shards exactly as before. This signal
  only makes stale entries easier to identify; it changes no CI selection logic itself.

## 6. External surfaces

Contributors and agents reading this script's JSON gain `runDetails` and human output gains reasons for
`could-not-run`. The existing `runs` values and top-level verdict names remain compatible. Temporary
report cleanup now emits the repository-standard local `.instar/audit/destructive-ops.jsonl` entry;
that gitignored machine audit is the only new persistent record. There are no application-user,
Telegram, Slack, GitHub API, dashboard, database, cross-machine ledger, or approval changes. Test
execution time and environment remain machine-dependent, as they already were.

No operator-facing action or URL is added. The local safety-audit entry above is the only persistent
state generated.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** This command observes test execution in the current checkout, dependency
tree, operating system, and machine environment. Those are intentionally per-machine facts and should
not be replicated as durable truth. A local pass is explicitly not treated as proof about CI or another
machine. The standard destructive-operation audit entry for temporary cleanup is likewise a
machine-local safety record.

The change emits no user-facing notice requiring one-voice gating, holds no durable state that could
strand on topic transfer, and generates no URL.

## 8. Rollback cost

- **Hot-fix release:** revert the script and focused test changes and ship the next patch.
- **Data migration:** none.
- **Agent state repair:** none; reports are temporary and deleted after each run.
- **User visibility:** contributors would temporarily regain the older, less accurate informational
  classification. CI and merge authority would remain unchanged.

## Conclusion

No side effect requires a design change. The strict JSON contract can make a future dependency schema
change visibly unknown, which is the honest failure mode for a non-gating signal. The implementation
keeps every authority boundary intact, preserves compatibility at the existing outcome fields, and is
clear to submit for independent judgement.

## Second-pass review

Not required. The change does not touch outbound/inbound messaging, dispatch, session lifecycle,
coherence, trust, idempotency, a gate, guard, sentinel, watchdog, or self-triggered controller. It
modifies only a manually invoked, signal-only test observation.

## Evidence pointers

- `tests/unit/recheck-parked-tests.test.ts`
- `scratchpad/phaseB/REPORT-R3.md` in the coordinating checkout
- Focused proof: one file and eight tests passed; pre-fix and post-fix real-process controls are
  recorded in the lane report.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable. This is an
ordinary result-parser defect in a manually invoked contributor script.

## CI5 addendum — rendered-summary assertion hardening

PR #1938's Node 20 and Node 22 shard-4 jobs exposed a defect in the test's secondary, rendered-output
assertion. The production classifier remained structured and the wrapper's combined capture already
contained both stdout and stderr. The captured value also contained the required `Checks` wording.
The assertion failed because Vitest's ANSI style bytes occurred between `Checks`, `1`, and `failed`,
so the raw `/Checks\s+1\s+failed/` expression could not span the presentation markup.

The focused test now removes only VT control characters from that same combined rendered capture
before applying the original two wording requirements. It still requires `Checks 1 failed` and still
forbids `Tests 1 failed`; neither requirement is deleted or weakened. The synthetic wrapper also has
an explicit wrong-wording mode, and a must-fire control proves the assertion rejects that mode. A
separate ANSI-decorated mode makes the CI failure deterministic even on a non-colour local terminal.

This addendum changes test robustness only. `scripts/recheck-parked-tests.mjs`, its two simultaneous
reporters, its structured classification, its signal-only exit-zero contract, and every authority
boundary described above are unchanged.

Final focused proof against the restored CI5 bytes passed one file and all nine tests on Node 22. The
repair-reverted ANSI control and the deliberately wrong-worded control were also run as actual red
tests before their final expected-control forms were restored.
