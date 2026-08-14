# Side-Effects Review — claim-check: absence of data is not zero results

**Version / slug:** `claimcheck-absence-is-not-zero`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `not required (Tier 1, advisory dev CLI, no authority surface)`

## Summary of the change

`instar dev:claim-check` asks GitHub which open/recently-merged PRs touch the files an agent is about to edit. `defaultGhJson` parsed `stdout || 'null'`, so **empty stdout on a zero exit** produced `null`; the caller then did `… as ClaimPr[] ?? []`, converting absence into an empty PR list. Nothing threw, so `ghDegraded` stayed null and the command printed a green `✓ No claims found` having learned nothing. Two files change: `src/commands/devClaimCheck.ts` (reject empty stdout at the gh boundary; add `asPrList()` which throws on any non-array, applied to BOTH the open and merged queries) and `tests/unit/dev-claim-check.test.ts` (+4 cases). Absence is routed into the pre-existing loud degrade path rather than a new channel.

## Decision-point inventory

One decision point is touched, and it is **modified, not added**: "did the claim check learn anything?" Previously that decision had two outcomes (error → degrade; anything else → trust the list). It now has three inputs collapsing to the same two outcomes — error → degrade, **absence → degrade**, real array → trust. No decision point is added or removed. The advisory verdict itself (overlap vs no overlap) is untouched.

## 1. Over-block

Could this refuse where it should permit? The realistic over-block is treating a genuine empty result as absence, which would make the tool cry "could not check" on every clean run and train readers to ignore it. Explicitly guarded: `gh … --json <fields>` emits `[]` for zero results, and `Array.isArray([])` is true, so a real zero passes straight through. A dedicated test (`CONTROL: a GENUINE zero (gh returns []) still prints the green all-clear`) fails if that ever regresses. This is advisory output, not a gate, so even a wrong degrade costs a warning line, never a blocked action.

## 2. Under-block

Could this permit where it should refuse? The previous behaviour WAS the under-block: absence permitted a confident all-clear. Remaining under-block surface: a gh reply that is a well-formed array of the wrong shape (e.g. missing `files`) still passes. That was already handled — `findPrOverlaps` treats a PR with no `files` as simply no overlap, with an existing test. Not widened here.

## 3. Level-of-abstraction fit

The guard sits at the data boundary (is this a list?) rather than in the reporting layer (should I print green?). That is the right level: the reporting logic already keys off `ghDegraded`, which is exactly the "I could not check" concept. Pushing the check up into the printer would have duplicated the concept; pushing it down into `gh` argument construction would not have covered injected implementations.

## 4. Signal vs authority compliance

This is **signal only**. The command is advisory: it prints and returns 0 on the normal path. It gains no authority over commits, pushes, or any agent action. Strict mode's existing behaviour (exit 1 when the claim space could not be verified) is unchanged in kind — it already did this for errors; silence now reaches the same code path. No new blocking authority is created anywhere.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. `Array.isArray()` is a deterministic type test with no heuristic, no model call, and no tunable threshold. There is nothing here for a floor to constrain.

## 5. Interactions

Blast radius measured, not assumed: exactly two importers of `devClaimCheck` — `src/cli.ts` (the `dev:claim-check` subcommand) and the unit test. No scheduler, sentinel, gate, or route consumes it. `asPrList` is module-private. The `ClaimCheckDeps.ghJson` interface signature is unchanged, so any existing injected implementation keeps working; an implementation that previously returned `null` now surfaces as a loud degrade instead of a silent zero, which is the intended behaviour change.

## 6. External surfaces

The only external surface is the `gh` CLI. No new invocation, flag, network call, or credential is introduced — the change is purely in how an existing reply is interpreted. No new files are written, no state is persisted, no telemetry is emitted.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator-visible text is the pre-existing line `⚠ gh unavailable (<reason>) — PR overlap NOT checked; spec scan only.` The new reason strings are plain English and name the actual condition: `gh exited 0 but produced no output — PR overlap is UNKNOWN, not zero.` and `gh returned no usable <open|merged>-PR list (<what arrived>) — PR overlap is UNKNOWN, not zero.` No raw paths, no stack traces, no internal field names.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. This is a local developer CLI with no shared state, no lease, no replication, and no cross-machine surface. It reads from GitHub and prints to the terminal of whichever machine invoked it.

## 8. Rollback cost

Very low. Two files, one commit, no migration, no persisted state, no config flag. Reverting restores the previous behaviour exactly; nothing downstream will have recorded anything that depends on the new semantics.

## Conclusion

Ship. The change narrows a false-negative in an advisory instrument, is guarded in both directions by tests, adds no authority, and touches nothing beyond one CLI command and its test.

## Second-pass review (if required)

Not required — Tier 1, advisory surface, no authority or safety-invariant path (`classify-tier.mjs` matched none of the 10 safety-invariant patterns for this file).

## Evidence pointers

- Defect verified in source before any edit: `defaultGhJson` `JSON.parse(stdout || 'null')` + caller `?? []`, with the green-tick branch gated on `total === 0 && !ghDegraded`.
- Negative control executed: reverting `asPrList` to the old `?? []` semantics makes **3 of the 4** new tests fail; restoring makes them pass. Source restored byte-identical (sha + size verified, zero markers left).
- Positive control: the genuine-`[]` case passes under BOTH old and new semantics, proving the guard distinguishes absence from zero rather than always firing.
- Verified on main's dependency set in a dedicated worktree: `tsc --noEmit` exit 0; `tests/unit/dev-claim-check.test.ts` 14/14 (was 10).

## Class-Closure Declaration (display-only mirror)

Class: "a lookup that returns nothing rendered as a confident zero." This change closes it at both call sites in this command and at the gh boundary. It does NOT claim to close the class repo-wide — other `?? []` coercions over external data may exist and were not audited here.
