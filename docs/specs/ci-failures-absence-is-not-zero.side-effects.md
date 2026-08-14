# Side-Effects Review — ci-failures: a failed read is not "no annotations"

**Version / slug:** `ci-failures-absence-is-not-zero`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `not required (Tier 1, advisory dev CLI, no authority surface)`

## Summary of the change

`instar dev:ci-failures <pr>` prints a red PR's test-level failure annotations. Its `gh` boundary is deliberately hardened (`JSON.parse(stdout)` with no `|| 'null'`), and its SHA and check-list callers both report and exit 1 on failure. The per-check ANNOTATIONS caller did neither: `catch { continue; }` swallowed the error, so an unreadable check became indistinguishable from a check with no annotations. When every read failed, `total === 0` and the command printed *"The failed checks have no test-level annotations — likely a build/lint/type step"* — a diagnosis of the failure's NATURE asserted from data never received. The file's own docblock claimed "there is no path on which a failed read renders as a clean one"; that claim was false for this caller. Changes: track unread checks, report the gap (even when other failures WERE found), withhold the diagnosis when nothing was read, treat a non-array reply as absence, and correct the docblock. Plus a new `tests/unit/dev-ci-failures.test.ts` (the command had none).

## Decision-point inventory

One decision point is **modified, not added**: "what do zero printed failure lines mean?" It previously had one outcome (no annotations exist → diagnose as a build/lint step). It now has two, split on whether the reads succeeded — read-and-empty keeps the original diagnosis; not-read reports UNKNOWN. No decision point is added or removed, and the failure-extraction logic (`extractFailureLines`) is untouched.

## 1. Over-block

Could this refuse where it should permit? It cannot refuse anything — the command returns 0 on every path it did before, including all new ones. The realistic analogue is over-WARNING: emitting "annotations NOT read" on a healthy run, which would train readers to ignore it. Guarded by a dedicated control test asserting that a genuine `[]` reply produces the original message, no UNKNOWN, and no warning. `[]` is an array, so it never enters the unread path.

## 2. Under-block

Could this permit where it should refuse? The previous behaviour WAS the under-report: silence became a confident diagnosis. Remaining surface: a well-formed array whose ENTRIES are malformed still flows into `extractFailureLines`, which drops entries lacking a `failure` level or a message. That is pre-existing and unchanged — an annotation list that arrives and contains nothing actionable is genuinely "no test-level annotations".

## 3. Level-of-abstraction fit

The tracking sits in the loop that performs the read (the only place that knows a read failed) and the reporting sits at the summary (the only place that knows the totals). Pushing the check into `extractFailureLines` would have been wrong: that function is pure and receives an array, so by the time it runs the absence is already lost.

## 4. Signal vs authority compliance

**Signal only.** The command is a diagnostic and explicitly not a gate — its own RULE 3.1 rationale says so and it returns 0 even when it finds failures. It gains no authority: no exit code changes, nothing is blocked, retried, or escalated. The new warning goes to stderr so it cannot corrupt stdout parsing.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. `Array.isArray()` and a length comparison are deterministic; no heuristic, model call, or tunable threshold.

## 5. Interactions

Blast radius measured, not assumed: `devCiFailures` is imported by `src/cli.ts` (the `dev:ci-failures` subcommand) and by the new test only. `extractFailureLines` is exported and unchanged. No scheduler, sentinel, gate, or route consumes it. The `CiFailuresDeps` interface is unchanged, so injected implementations keep working; one that previously returned a non-array now surfaces as a reported gap instead of a silent zero, which is the intended behaviour change.

## 6. External surfaces

The `gh` CLI only. No new invocation, flag, endpoint, credential, or network call — the change is purely in how an existing reply is interpreted and reported. No file written, no state persisted, no telemetry.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

New text is plain English and names the concrete gap: `⚠ Annotations NOT read for N of M failed check(s): <names>. Their failures are NOT included below — this listing is incomplete.` and `No annotations could be read for any failed check — their nature is UNKNOWN, not "no test failures".` Check NAMES come from the GitHub API and are already printed elsewhere by this command. No paths from the authoring machine, no stack traces, no internal field names.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. A local developer CLI with no shared state, lease, replication, or cross-machine surface.

## 8. Rollback cost

Very low. One source file plus one new test file, one commit, no migration, no persisted state, no config flag. Reverting restores the previous output exactly.

## Conclusion

Ship. The change removes a false diagnosis from an advisory instrument, adds no authority, changes no exit code, and is guarded in both directions.

## Second-pass review (if required)

Not required — Tier 1. `classify-tier.mjs` matched no safety-invariant pattern for `src/commands/devCiFailures.ts`; the in-scope change is one file (tests are out of scope per the gate's own `inScope()`).

## Evidence pointers

- Defect verified in source before any edit: `catch { continue; }` at the annotations caller, with the unconditional `total === 0` diagnosis below it and zero occurrences of any degrade flag in the file (against a control of 7 in the sibling `devClaimCheck.ts`).
- Found by auditing the class-closure loop left open by `claimcheck-absence-is-not-zero`, which stated the class was NOT closed repo-wide. A pattern sweep over `src/` for awaited-expression `?? []` coercions returned exactly two sites; the other (`PeerVisibilityGuard.ts:198`) is an OPTIONAL-DEPENDENCY default carrying an explicit `@silent-fallback-ok` annotation and its spec reference, and is correct as written.
- Negative control executed: reverting the source change fails 3 of 5 tests while the CONTROL test still passes (2 passed) — proving the control is load-bearing rather than an echo of the fix. Source restored byte-identical (sha + size 9,751 verified).
- `tsc --noEmit` exit 0; `tests/unit/dev-ci-failures.test.ts` 5/5 (file newly created — the command had no tests).

## Class-Closure Declaration (display-only mirror)

Class: "a lookup that returns nothing rendered as a confident answer." With this change the class is closed at BOTH `src/commands/dev*` sites that exhibited it. The `src/`-wide sweep for awaited `?? []` coercions now returns one remaining site, reviewed and correct by design. This does NOT claim the class is closed for every shape it can take (e.g. `|| []` on a non-awaited external value, or object-shaped absences); only the audited pattern is closed.
