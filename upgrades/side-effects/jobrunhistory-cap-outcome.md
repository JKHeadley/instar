# Side-Effects Review — JobRunHistory cap outcome classification

**Version / slug:** `jobrunhistory-cap-outcome`
**Date:** `2026-07-19`
**Author:** `instar-codey`
**Second-pass reviewer:** `independent Codex review lane`

## Summary of the change

`JobRunHistory` stops routing successful 2 KB row-budget enforcement into
`DegradationReporter`, keeps the existing durable `truncated` row signal, and
adds `budgetCondensedRuns` to computed job stats. The standards registry names
the class; `CapacityEnforcementResult` makes the three outcomes explicit; and a
versioned contract registry plus lint binds each source, typed result, durable
signal, and unexpected-failure annotation mechanically. The final serialized
size is rechecked after every transform; an essential-fields overflow is refused
and emits one bounded, revision-bound unexpected degradation.
The registry is strictly versioned and non-empty, rejects duplicate or
cross-path markers, validates every binding field, and refuses base-contract
removal without a reviewed retirement tombstone.

## Decision-point inventory

- `JobRunHistory.applyRowSizeCap` — modified — successful budget enforcement
  remains deterministic, but no longer enters the defect-reporting pipeline.
- `lint-expected-capacity-degradations` — added — a structural invariant checks
  exact contract/marker/type/failure bindings at build time.
- No runtime block/allow decision is added. The linter is a build invariant over
  a closed source-code shape, not a judgment about user intent.

## 1. Over-block

No runtime input is blocked. The lint can block a legitimate source edit when an
author changes a contract revision or symbol without updating the registry and
marker together; its error names the exact missing mechanical binding.

## 2. Under-block

The lint cannot decide whether an unregistered source ought to be a bounded-store
contract; semantic review remains responsible for enrollment. Once enrolled,
synonymous prose and stale nearby annotations cannot bypass the exact typed and
revision-bound checks. Essential-field overflow is covered by an adversarial
test and now takes the explicit invariant-failure branch.
Silent contract removal is checked against the Git diff base and requires a
timestamped, reasoned, review-referenced retirement tombstone.

## 3. Level-of-abstraction fit

The behavior change sits at the storage component that owns the budget outcome.
The class guard is a shared typed primitive plus registry convention for bounded
writers; it does not try to infer semantics from reporter prose. Outcome counts
are computed from the durable row flag rather than introducing a second ledger.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The runtime outcome is deterministic storage mechanics. The build lint enforces
closed registry/marker/type/revision equality and does not interpret natural
language from a user, source comments, or report strings.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Whether a
serialized row exceeded a declared byte cap and was stored within it is an
enumerable invariant. Semantic review still owns whether a source exception is
truthfully an unexpected failure.

## 5. Interactions

- **Shadowing:** JobRunHistory no longer opens DegradationReporter or Remediator
  episodes for successful condensing. Final over-budget rows take one explicit
  invariant-failure report path; filesystem write failures retain their existing
  console error path.
- **Double-fire:** Removed; a capped row has one durable outcome flag and no
  parallel degradation event.
- **Races:** Stats derive from the existing deduplicated ledger view, preserving
  current multi-instance cache validation and compaction semantics.
- **Feedback loops:** The feedback factory stops receiving healthy cap outcomes;
  real degradation reports remain unchanged.

## 6. External surfaces

`JobRunStats` gains the additive `budgetCondensedRuns` number. Health, feedback,
and remediation surfaces no longer receive successful JobRun cap events. The
JSONL schema is unchanged because `truncated` already existed. No operator action,
external API mutation, credential, URL, or notification path is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: job-run ledgers describe executions on the machine that
ran them, and the existing job-history read surface already follows that model.
No user-facing notice is emitted, no new durable state is introduced, and no URL
is generated. Each machine computes its own truthful cap count from its own rows.

## 8. Rollback cost

Hot-fix revert only. No migration or state repair is needed. Existing rows remain
valid, and older code ignores the additive stats field. Reverting would resume
the known feedback flood but would not corrupt data.

## Conclusion

The design removes a category error while preserving both the storage invariant
and durable observability. Review caught and removed an English-regex authority
and added the missing final-byte failure branch. Restart-spanning and adversarial
tests now prove both successful and impossible-to-fit outcomes. Clear to ship
after independent second-pass review.

## Second-pass review (if required)

**Reviewer:** independent Codex review lane
**Independent read of the artifact:** concur

Concur with the review. Three review rounds verified the final-byte
invariant-failure branch, removed the original English-regex authority, and
hardened the contract registry against malformed schema, duplicate/cross-path
markers, unbound fields, and silent contract removal. The final review reran 54
targeted tests, TypeScript, the upstream-main contract lint, and inspected a
clean diff.

## Evidence pointers

- Focused unit evidence — 65 passed across JobRunHistory, the contract lint,
  and the scheduler run-record consumer.
- Changed-file pre-push smoke — 330 tests (the legacy scheduler expectation was
  updated from degradation emission to durable outcome telemetry).
- Integration: `jobrunhistory-budget-outcome.test.ts` — 1 passed.
- E2E: `jobrunhistory-cap-feedback-boundary.test.ts` — 1 passed.
- `node scripts/lint-expected-capacity-degradations.js --diff-base upstream/main` — PASS.
- Essential-field overflow — no JSONL row; degradation re-read from disk after
  `DegradationReporter.resetForTesting()`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller addition —
not applicable. The runtime defect class is expected-capacity-outcome
misclassification; closure is the registered standard plus blocking source lint.
