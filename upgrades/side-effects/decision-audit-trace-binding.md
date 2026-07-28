# Side-Effects Review — decision audit trace binding

**Version / slug:** `decision-audit-trace-binding`
**Date:** `2026-07-19`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `not required`

## Summary of the change

The trace writer now persists its derived slug, and the pre-commit gate selects the newest complete trace whose `coveredFiles` includes every staged behavior file before reading tier, slug, or class evidence. Legacy traces fall back to their artifact basename. Regression tests pin both causes from `fb-2b24aa04-540`: missing generated identity and a newer foreign trace.

## Decision-point inventory

- `scripts/instar-dev-precommit.js` trace selection — modified — deterministically binds evidence to the staged change and refuses when no binding exists.

## 1. Over-block

A legacy hand-written trace without `phase: complete` or without complete behavior-file coverage is now refused earlier. That is intentional: such a trace cannot honestly describe the staged decision.

## 2. Under-block

Two traces can both cover the same files; recency remains the tie-breaker. The trace SHA and artifact checks still validate the selected trace later in the gate.

## 3. Level-of-abstraction fit

The repair spans the canonical trace producer and the pre-commit evidence binder. It persists the already-derived artifact slug and reuses the existing `coveredFiles` contract instead of introducing another identity system.

## 4. Signal vs authority compliance

[docs/signal-vs-authority.md](../../docs/signal-vs-authority.md) applies. This is an enumerable integrity invariant: evidence either covers all staged behavior files or it does not. The deterministic gate correctly holds blocking authority over an invalid development commit.

## 4b. Judgment-point check

No competing-signals judgment is introduced. Scope membership is an exact set-containment invariant.

## 5. Interactions

The selector runs before Tier-1 branching and before the existing full trace validation. It cannot double-fire. Full artifact, SHA, and spec validation remain unchanged. Parallel worktrees may leave traces behind, but those traces no longer influence unrelated staged changes.

## 6. External surfaces

No runtime, user, operator, network, or API surface changes. The persistent decision audit becomes more accurate.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: pre-commit traces and staged changes belong to one development worktree on one machine. It emits no user notice, creates no transferable runtime state, and generates no URL.

## 8. Rollback cost

Pure development-tooling code change. Revert and ship; no migration or agent-state repair is required.

## Conclusion

The class review found the missing standard was scope-bound evidence selection, and the process gap was reading identity from the newest trace before proving it described the staged files. The code and regression ratchet now enforce scope-first, recency-second selection. Clear to ship.

## Second-pass review

Not required: this does not touch runtime messaging, sessions, sentinels, guards, or watchdogs.

## Evidence pointers

- `tests/unit/instar-dev-precommit-audit-staging.test.ts`
- `tests/unit/write-trace-tier.test.ts`
- Feedback `fb-2b24aa04-540`

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: scripts/instar-dev-precommit.js#freshestTraceEntry, howCaught: the gate selects only a complete trace covering every staged behavior file before using its slug or tier, so a newer foreign or unknown trace cannot label the decision }`.
