# Side-Effects Review — Jev-first job spec correction

**Version / slug:** `jev-first-spec-correction`
**Date:** 2026-10-27
**Author:** echo
**Second-pass reviewer:** not required for documentation-only draft

## Summary of the change

The job-cost and model-routing drafts now state Justin's intended Jev-first coverage for every completed script result, including the per-result outage replacement. Their ELI16 overviews are updated. Prior convergence and approval labels are removed or named as historical so they cannot be mistaken for approval of the new rule. Runtime code is unchanged.

## Decision-point inventory

The documents describe the future decision of whether a result needs a session. They do not add or modify a live decision point in this change.

## 1. Over-block

No live block/allow surface. A future implementation must keep critical alerts immediate even if model triage is slow or unavailable.

## 2. Under-block

No live behavior changes. The older technical details still appear as historical text and are explicitly superseded; they must be reconciled before an implementation spec can regain convergence or approval.

## 3. Level-of-abstraction fit

The design documents are the correct place to resolve scope before code changes. Result supervision belongs to spec 1; before-work Jev checks belong to spec 2.

## 4. Signal vs authority compliance

Per [signal vs authority](../../docs/signal-vs-authority.md), this documentation change adds no blocking authority. The proposed model check is the future judgment point; deterministic alert floors remain separate and immediate.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added to live code. The draft says uncertainty requests a session under bounded admission, with the fixed critical alert floor still active.

## 5. Interactions

The two specs now name the same after-run rule. The prior narrow classifications and cost estimate are marked outdated. No runtime race or double action is introduced by editing documentation.

## 6. External surfaces

The draft PR and its ELI16 overview are visible to reviewers. No agent, API, job, or external service changes behavior from this commit alone.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The opening ELI16 paragraph states the rule in plain language and distinguishes after-run checks from optional before-work checks. Approval status is plainly draft.

## 7. Multi-machine posture (Cross-Machine Coherence)

Documentation is repository-wide. Any future implementation must reconcile per-machine budgets and audit records before activation; this edit adds no machine-local state.

## 8. Rollback cost

Revert the documentation commit. No data migration or agent state repair is needed.

## Conclusion

The correction makes the requested scope explicit while retaining the live audit gate. The details require fresh review; this commit itself is safe to publish as a draft.

## Second-pass review (if required)

Not required for a documentation-only draft.

## Evidence pointers

`git diff --check` passes. The PR remains draft.

## Class-Closure Declaration (display-only mirror)

No live agent-authored artifact or self-triggered controller is changed.
