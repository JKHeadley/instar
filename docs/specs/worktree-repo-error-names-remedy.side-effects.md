# Side-Effects Review — worktree create: the failure names its remedy

**Version / slug:** `worktree-repo-error-names-remedy`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `not required (Tier 1, operator-surface text only, no behaviour change)`

## Summary of the change

`resolveInstarRepo` (`src/core/InstarWorktreeManager.ts`) consults an ordered candidate chain — `INSTAR_REPO`, CWD, `INSTAR_AGENT_HOME`, then two default checkout locations — and throws when none passes integrity validation. The throw enumerated every candidate and its rejection reason, which is honest and diagnostic, but never named `INSTAR_REPO` — the FIRST candidate it consults and the documented escape hatch for a checkout in a non-default location. The remedy is now appended to that message, and `src/cli.ts`'s `worktree create` description gains a sentence describing repo resolution (it already described agent-home resolution in detail). Two tests are added. No behaviour changes: the same candidates are tried in the same order, the same integrity checks apply, the same inputs succeed and fail.

## Decision-point inventory

**No decision point is added, removed, or modified.** The candidate chain, the ordering, the integrity validation, and the success/failure boundary are all untouched. This change alters the TEXT emitted on an already-existing failure path, plus a CLI help string.

## 1. Over-block

Could this refuse where it should permit? No — the change cannot cause a refusal. It only executes on a path that has already decided to throw. Every candidate that resolved before this change resolves after it, verified by the existing 49-test suite passing unchanged.

## 2. Under-block

Could this permit where it should refuse? No. Nothing is loosened; no new candidate is admitted and no validation is skipped. A reader following the new advice sets `INSTAR_REPO`, and that path is then subject to exactly the same integrity validation it always was — the guidance routes an operator to a checked input, never around a check.

## 3. Level-of-abstraction fit

The remedy belongs in the throw, not in the CLI catch-block, because `resolveInstarRepo` is the function that knows the candidate chain — it is the only layer that can state which inputs it consults. The CLI's `catch` prints `err.message` verbatim, so the guidance surfaces without the CLI needing to duplicate knowledge it does not own. The help-text sentence is separately in the right place: it documents the command's inputs before the operator runs it.

## 4. Signal vs authority compliance

**Signal only, and strictly less than that** — this is operator-facing prose on an existing failure. It gains no authority: it does not gate, permit, block, retry, or change an exit code. The command's exit behaviour is byte-for-byte identical.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. There is no heuristic, model call, threshold, or classification — the change is two string literals.

## 5. Interactions

Blast radius measured, not assumed. `resolveInstarRepo` is consumed by `createWorktree` in the same module and re-exported through `src/commands/worktree.ts` to `src/cli.ts`. `AgentWorktreeDetector` deliberately does NOT use it (it resolves via its own chain, documented at `AgentWorktreeDetector.ts:423`), so the detector is unaffected. Callers that match on the error message: the existing suite matches `/no candidate passed integrity validation/`, which is preserved verbatim as the message's opening clause — a prefix match, so appending cannot break it. Verified by the suite passing.

## 6. External surfaces

None. No network call, no new file, no state written, no credential, no telemetry, no config key. The only outputs are a thrown `Error.message` and a Commander description string.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change IS an operator-surface fix, so the bar applies to itself. The appended text is plain English, names the setting exactly as it must be typed, and gives a concrete example using a placeholder path (`/path/to/instar`) rather than any real machine path. It contains no stack trace, no internal field name, and no absolute path from the authoring machine. It is appended after the diagnostics so the specific reasons stay first, where a reader looking for "why" finds them without scrolling past advice.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. This is a local developer CLI path with no shared state, no lease, no replication, and no cross-machine surface.

## 8. Rollback cost

Very low. Two source files, one commit, no migration, no persisted state, no config flag. Reverting restores the previous message exactly; nothing downstream records anything that depends on the new text.

## Conclusion

Ship. The change fixes an operator-surface defect with a measured real-world cost, adds no authority, alters no behaviour, and is guarded by a test that fails if the diagnostics it appends to are ever lost.

## Second-pass review (if required)

Not required — Tier 1. `classify-tier.mjs` matched none of the safety-invariant patterns for either in-scope file, and the in-scope change is 16 LOC across 2 files (tests are out of scope per the gate's own `inScope()` definition: `src/`, `scripts/`, `.husky/`, `skills/`).

## Evidence pointers

- Defect reproduced before any edit: `resolveInstarRepo` from a non-repo CWD with no env set throws a message listing three candidates and their reasons, containing zero occurrences of `INSTAR_REPO`.
- The source file was confirmed BYTE-IDENTICAL to `main` (40,979 bytes both) before editing, so the defect is live on mainline and not an artifact of a local branch.
- Negative control executed: reverting the source change makes the new `THE DEFECT` test FAIL (1 failed / 50 passed) while the `CONTROL` test still PASSES — proving the control is load-bearing on the diagnostics rather than merely echoing the fix. Source restored byte-identical (sha + size 41,860 verified).
- `tsc --noEmit` exit 0; `tests/unit/InstarWorktreeManager.test.ts` 51/51 (was 49).
- Verified in a dedicated worktree checked out from `origin/main` on its own installed dependency set, not inherited from another tree.

## Class-Closure Declaration (display-only mirror)

Class: "an honest error that does not name its remedy, so the operator routes around the safeguard." This change closes it for `resolveInstarRepo` only. It does NOT claim to close the class repo-wide — other thrown errors naming a failed lookup without its escape hatch may exist and were not audited here.
