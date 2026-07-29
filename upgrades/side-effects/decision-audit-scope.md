# Side-Effects Review — development decision audit scope

**Version / slug:** `decision-audit-scope`
**Date:** 2026-07-29
**Author:** Instar Agent (instar-codey)

## Summary

The development pre-commit gate now persists the exact in-scope staged file
list, added-line count, deleted-line count, and named counting basis beside
each decision record’s existing compact `files` and `loc` counters.

## Decision-point inventory

This changes evidence emitted by an existing gate, not its authority. Tier
classification, trace selection, refusal conditions, and verdict finalization
remain unchanged.

## 1. Over-block

No new refusal is introduced. Audit writing remains best-effort and fail-open,
as before. The additive fields cannot prevent a commit.

## 2. Under-block

The record still reflects only files covered by the gate’s existing `inScope`
predicate, not every file in the pull request. That boundary is now explicit
in the `staged-in-scope-additions-plus-deletions` basis and concrete file list,
rather than hidden behind a compact count. Removing the emitted object made the
focused assertion fail before the implementation was restored, proving the
test does not merely restate its own derivation.

## 3. Level-of-abstraction fit

The audit writer is the correct owner because it already receives the tier
signal and writes the durable decision record. The added values reuse the
same staged `numstat` calculation rather than asking downstream consumers to
reconstruct a vanished diff.

## 4. Signal vs authority compliance

Compliant with `docs/signal-vs-authority.md`. The scope fields are evidence
only. They add no detector, filter, or blocking authority and do not alter the
gate’s verdict.

## 5. Interactions

Existing consumers retain the unchanged `files` and `loc` fields. New
consumers can inspect `scope`. The values are captured before any gate exit and
therefore accompany both passing and blocked decision records through the
existing verdict-finalization path.

## 6. External surfaces

Internal decision JSON gains one additive object. No runtime API, user-facing
message, configuration, credential, or operator action changes.

## 7. Multi-machine posture

Repository-replicated evidence. Decision records already ride the commit as
distinct files, so the new fields follow the same Git replication path and do
not introduce machine-local state or cross-machine authority.

## 8. Rollback cost

A direct revert removes the additive fields. Records already written with
`scope` remain readable by older consumers because they ignore unknown keys.
No migration or state repair is required.

## Conclusion

The change makes existing gate evidence interpretable without changing what
the gate decides.
