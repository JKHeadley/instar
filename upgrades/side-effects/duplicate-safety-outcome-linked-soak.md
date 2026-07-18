# Side-Effects Review — Outcome-linked reconciler soak evidence

**Version / slug:** `duplicate-safety-outcome-linked-soak`
**Date:** 2026-07-18
**Author:** Instar-codey
**Second-pass reviewer:** independent Codex subagent (concerns resolved)

## Summary of the change

The two observe-only session reconcilers now correlate each dry-run decision with one subsequent observation. `AutonomousLivenessReconciler` classifies whether a would-respawn opportunity recovered, remained orphaned, ended, stopped, moved owner, lost its lease, or entered the queue. `DuplicateSessionReconciler` classifies whether the duplicate disappeared, resolved under fresh probes, persisted with the same survivor, changed survivor evidence, or became ambiguous. The patch changes no feature flag, CAS, closeout, spawn, notification, or enforcement path.

## Decision-point inventory

- `AutonomousLivenessReconciler` dry-run branch — pass-through — records a decision identifier and later observation; it still returns before spawn authority.
- `DuplicateSessionReconciler` dry-run branch — pass-through — records a decision identifier and later observation; it still returns before CAS and closeout authority.

## 1. Over-block

No block/allow surface — over-block not applicable. Follow-up classification errors affect soak interpretation only and cannot refuse a spawn, terminate a session, mutate ownership, or notify a user.

## 2. Under-block

No block/allow surface — under-block not applicable. A process restart between decision and follow-up loses the in-memory correlation; this is intentionally honest rather than reconstructing causality from logs. Duplicate non-rediscovery means only that discovery did not return the key on the next observation, not proof that closeout occurred.

## 3. Level-of-abstraction fit

This is at the detector/observability layer beside the existing dry-run audit writes. It consumes the reconcilers' existing authoritative snapshots and emits bounded classifications. It does not duplicate routing, ownership, spawn, or closeout logic.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The new logic produces review evidence only. Existing deterministic safety floors and authorities remain unchanged, and both components remain dry-run.

## 4b. Judgment-point check

No new static heuristic controls a competing-signals decision. The outcome labels are explicitly observations for later human/reviewer judgment; none selects a survivor or authorizes a respawn.

## 5. Interactions

- **Shadowing:** Follow-ups run before the next tick's decision so they cannot be overwritten by a new decision identifier.
- **Double-fire:** Each pending entry is deleted immediately after one follow-up row; a topic/key has at most one pending correlation.
- **Races:** Tick execution is already single-instance per reconciler. State is process-local and bounded by topic/key.
- **Feedback loops:** The audit rows are not read by either reconciler and therefore cannot alter actuation.

## 6. External surfaces

The only external surface is additional fields and follow-up rows in the existing machine-local audit logs. There are no user-facing notices, routes, URLs, schema migrations, or external service calls. Timing affects which honest next-observation label is recorded; the decision timestamp is preserved for review.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** both logs describe what one machine's reconciler observed and decided from its local serving/lease context. Pool-wide graduation review can aggregate existing audit artifacts, but the correlation itself must not be replicated because that could falsely join one machine's decision to another machine's observation. No notices, durable authority state, or URLs are added, and no state can strand a topic transfer because pending correlations expire with the process and never actuate.

## 8. Rollback cost

Pure code rollback: revert the four implementation/test files and ship a patch. Existing appended JSONL rows remain harmless unknown event kinds to older readers. No data migration, agent repair, or user-visible rollback is required.

## Conclusion

The change closes the measured soak-evidence gap while preserving the plan's NOT-READY verdicts and observation-only posture. It is safe to ship once the independent session-lifecycle review concurs and CI is green.

## Second-pass review

**Reviewer:** independent Codex subagent
**Independent read of the artifact:** concur. The first pass found degraded discovery being mislabeled as resolution and safety-defaulted dependency failures being mislabeled as positive outcomes. The implementation now retains degraded duplicate follow-ups with a deduped `discovery-unknown` row, emits `evidence-unknown` for unreadable liveness evidence, and adds per-instance sequence values to decision IDs. The revised changes preserve observe-only authority; pending state remains bounded and 102 focused tests pass.

## Evidence pointers

- 100 focused unit tests passed.
- 34 relevant integration/E2E tests passed, with three pre-existing TODOs.
- Full lint/typecheck and build passed.
- Repository-wide unit suite had one designated flaky messaging test fail; its isolated rerun passed.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no action-bearing controller modification. The controller changes are observe-only audit signals with no self-action edge; class closure is not applicable.
