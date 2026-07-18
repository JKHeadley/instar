# Side-Effects Review — Decision trace identity and scope

**Version / slug:** `decision-trace-identity`
**Date:** 2026-07-18
**Author:** Instar Agent (instar-codey)
**Second-pass reviewer:** required — development commit gate

## Summary of the change

The canonical trace writer persists its artifact-derived work-item identity in the trace body. The commit gate falls back to the bound artifact basename for older trace shapes and expands each decision record with the exact in-scope file list, added lines, deleted lines, and a named counting basis. Legacy `files` and `loc` counters remain for compatible readers.

## Decision-point inventory

The gate's allow/block requirements do not change. This patch changes only the evidence attached to every existing gate evaluation and the identity used to name that evidence.

## 1. Over-block

No new refusal is introduced. Legacy traces remain accepted through deterministic artifact-bound fallback.

## 2. Under-block

The fallback uses only the trace's already-verified review artifact path, never a branch guess or free-form inference. A trace lacking both explicit identity and a bound artifact retains the honest `unknown` value.

## 3. Level-of-abstraction fit

The writer owns the canonical trace shape; the pre-commit audit writer owns the persisted decision schema. Fixing both ends prevents downstream consumers from reconstructing identity or counter semantics heuristically.

## 4. Signal vs authority compliance

Identity and scope are evidence, not authority. The existing declared tier and requirement set still decide which gate path runs.

## 4b. Judgment-point check

No new competing-signals judgment is added. Fallback is closed and deterministic: explicit trace identity, then bound artifact basename, then honest unknown.

## 5. Interactions

- Current trace writers produce explicit identity.
- Older traces with an artifact bind cleanly without migration.
- Existing consumers keep reading `files` and `loc`; new consumers can inspect `scope`.
- Per-decision filenames become stable for canonical traces, reducing the untraceable bucket without changing collision handling.

## 6. External surfaces

Internal JSON evidence gains additive fields. No runtime API, agent state, credential, or operator action changes.

## 6b. Operator-surface quality

The audit becomes explainable: a reviewer can see which source files and line categories produced the compact counters instead of mistaking an in-scope count for the whole PR diff.

## 7. Multi-machine posture

Decision entries remain repository evidence committed with their change. Distinct per-entry paths preserve parallel-branch conflict immunity; no machine-local authority is introduced.

## 8. Rollback cost

A direct revert restores the former trace shape and compact-only audit. Additive fields in already-merged entries remain harmless to older readers.

## Conclusion

The patch improves evidence identity and interpretability without changing gate authority or refusal semantics. Focused writer/gate tests are green.

## Second-pass review

Required because this changes evidence emitted by the development commit gate. Echo exact-head review is the ship gate.

## Class-Closure Declaration

This closes the class where a producer derives a stable identity but fails to persist it in the payload consumed by downstream audit machinery. The guard is a writer round-trip assertion plus a legacy-fallback gate assertion.
