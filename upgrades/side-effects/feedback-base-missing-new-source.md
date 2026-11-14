# Side-Effects Review — Feedback base check accepts missing new source with zero collected tests

**Version / slug:** `feedback-base-missing-new-source`
**Date:** 2026-11-02
**Author:** Echo
**Second-pass reviewer:** independent read-only reviewer `/root/feedback_gate_review`

## Summary of the change

The feedback executor's `classifyBaseFailure` in `src/feedback-factory/execute/executorSession.ts` now examines a missing source import before treating Vitest's `Tests no tests` summary as a missing test. The recorded worker test imported `src/core/ConfigFileWriter.ts`, which the proposed fix adds; the base clone correctly lacks it. The change affects only the base-proof verdict. `tests/unit/feedback-factory/execute-units.test.ts` covers the recorded output and two negative cases. The release fragment is `upgrades/next/feedback-base-missing-new-source.md`. The driving approved, converged spec is `docs/specs/feedback-triage-and-execution.md` §4 step 8(a).

**Tier:** 2. This is a small, reversible diff, but it changes a safety proof gate before publication. One independent implementation review round concurred; local gate attempts: one focused test, one broad unit run that ended with a worker-process error, and a captured rerun that passed 55,549 tests. No merge or rollout yet.

## Decision-point inventory

- `classifyBaseFailure` — modify — decides whether the named regression test failed for an allowed reason on the original code. The new ordering recognizes the spec's missing-new-source case even when Vitest collected zero tests.
- Head-test pass count, lint, independent review, CI, and merge gates — pass-through — remain independent requirements.

## 1. Over-block

A test file genuinely absent at base still returns `test-not-found-at-base`. A failed suite with no recognized missing-source path still returns the same reason. An unusual Vitest wording for an allowed missing source may be rejected; this change does not expand the parser's accepted output vocabulary. The recorded Vitest wording is covered directly.

## 2. Under-block

The base check may accept a test whose only base failure is a newly added source file, even if the test's assertion would not prove the reported behavior. This allowance already exists in the approved spec. The head clone must run the named test and show at least one pass, and independent review must judge whether the test and fix address the report. An unrelated missing import is rejected before the zero-test summary is considered. A fake missing-source line from test output remains a possible parser concern inherited from the existing classifier; the head and review gates still apply.

## 3. Level-of-abstraction fit

The classifier is a deterministic proof validator for a constrained test-run output contract. It does not judge the feedback report's value or intent. Triage handles value; independent review handles semantic safety. The changed ordering implements an already declared allowed proof shape at the existing base-check layer.

## 4. Signal vs authority compliance

The change keeps a hard invariant before publishing a code change. A base test must fail for a listed reason; a head test must really pass. The domain is constrained by the recorded changed-source paths and Vitest output, and the publish action has a high cost for false acceptance. This fits the hard-invariant and irreversible-action exceptions in `docs/signal-vs-authority.md`. It adds no message-content or agent-intent blocker.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The check compares an observed missing import with the proposed change set. Human or model judgment about whether the fix is useful remains in triage and independent review.

## 5. Interactions

- **Shadowing:** The old generic `Tests no tests` check shadowed the allowed missing-new-source classification. The new order removes that shadow; `No test files found` still rejects before path inspection.
- **Double-fire:** No new action or notification is emitted. One base-check verdict is returned per run.
- **Races:** The classifier is pure and receives bounded output plus the immutable change-set paths from the executor. No shared state or timing is changed.
- **Feedback loops:** A previously rejected item may use its one automatic retry and reach head testing or a PR. A failed head test still stops publication; the daily start cap is unchanged.

## 6. External surfaces

The executor may open a feedback PR that this specific base-check error previously stopped. That PR still has the usual independent review and merge gates. No API shape, database schema, secret, operator action, URL format, or user notice changes. Existing agents receive the behavior through the next Instar release; no on-disk migration is required.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: each machine's installed executor validates its own confined attempt against its local clone. The same code is shipped to every updated agent. This change emits no user-facing notices, stores no new durable state, and generates no URLs; topic transfer needs no new replication path.

## 8. Rollback cost

Revert the classifier ordering and release a patch. There is no data migration or agent-state repair. During rollback propagation, the affected test shape may again be rejected and consume an attempt, which would be visible in the executor failure reason.

## Conclusion

The review found a narrow ordering error in an existing safety proof check. The revised order accepts only the specified missing-new-source failure while preserving negative cases and downstream gates. Local lint, build, focused regression, and a captured full unit rerun pass. The independent second pass concurred. Integration and end-to-end tests are required before publication.

## Second-pass review

**Reviewer:** `/root/feedback_gate_review`, read-only, 2026-11-02.
**Independent read of the artifact:** Concur with the review. The order matches §4 step 8(a), preserves the rejection of unrelated imports and absent tests, and leaves head-test and independent review gates in place. The reviewer found no new blocker. The inherited parser risk remains: output is untrusted and a missing-path regex uses suffix matching; the zero-collected-test variant now reaches that existing parser path.

## Evidence pointers

- Live failure: executor status `lastCheckFailure` for `feedback-bcac1212-d53c-46d6-8ef0-1eec8a518960:a1`, 2026-11-02.
- Local commit before artifact amendment: `5d96c49dd`.
- Run receipt: `.instar/autonomous/18330-evidence-20261102.md`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable. This is a source-code classifier correction.
