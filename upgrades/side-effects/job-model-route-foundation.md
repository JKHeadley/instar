# Side-Effects Review — Job model route foundation

**Version / slug:** `job-model-route-foundation`  
**Date:** 2026-10-27  
**Author:** Echo  
**Second-pass reviewer:** independent route review — concurred after model-recording correction

## Summary of the change

Adds optional framework/model fields to the job manifest and run ledger, and a pure decision seam for benchmark-backed session pins. `JobScheduler` reads cached evidence only for a pinned job. A code-owned audit-readiness constant is false, so no pin can activate in this change. Existing jobs use their current framework and model. The build is in a fresh worktree from `JKHeadley/instar` main at `0868b62c`, package version 1.3.1467; the remote is `https://github.com/JKHeadley/instar.git`.

## Decision-point inventory

- `decideJobModelRoute` — add — checks the bounded pin and machine evidence, returning either a bench route or a reasoned default fallback.
- `JobScheduler.spawnJobSession` — modify — applies the code-owned audit gate before the route decision and records the actual spawned framework and model.
- `SessionManager.spawnSession` — modify — records the resolved launch model after a Codex rate-limit swap.
- `AgentMdJobLoader.validateManifest` — modify — rejects incomplete or malformed model pins.

## 1. Over-block

A valid pin may stay on the default route if its evidence cache is unavailable, its benchmark row is stale, or the Codex deny canary is absent. That costs the intended optimization but does not skip the job. The audit gate holds every pin in this foundation slice by design.

## 2. Under-block

The source of the future machine evidence is not wired yet; a later change must prove its benchmark, pool, hook and canary snapshots are current and must supply the required audit adapter before lifting the code gate. A provider returning a false positive would be a route risk after that later change. No production provider is installed here.

## 3. Level-of-abstraction fit

Manifest shape and model-id bounds are structural validation at load time. The route decision is a deterministic safety floor over concrete machine facts, while benchmark model selection stays in the reviewed benchmark and PR process. The scheduler consumes the decision and does not perform a new model judgment.

## 4. Signal vs authority compliance

**Required reference:** [Signal vs Authority](../../docs/signal-vs-authority.md)

- [x] No — this change is a hard-invariant validation and a safety floor for an optional route.

The checks never block the scheduled job; they only decline a model optimization and run the established route. The model-quality judgment belongs to the benchmark and review process.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. Each check is an enumerable prerequisite (valid pin, matching benchmark, active door and pool, trusted hooks, current canary, closed breaker). The future reviewer chooses a pin from quality evidence.

## 5. Interactions

- **Shadowing:** The audit gate is applied before the route choice; it prevents saved settings or a future evidence provider from activating a pin prematurely. The existing scheduler allowlist is resolved first and supplied to the Codex pin check.
- **Double-fire:** One scheduler spawn remains the only effect. A failed pin check never starts a second session.
- **Races:** Evidence cache failure falls back; the run records the spawned framework and model if the session manager changes lanes or swaps models after the decision. Such a run is marked `fallback`, not `bench`.
- **Feedback loops:** None. This slice reads no run grades and changes no breaker state.

## 6. External surfaces

New optional fields can appear in job and run-history API responses. No new operator action, message send, external API call, or model call is introduced. Existing manifest files need no migration; newly regenerated built-in manifests carry the fields only when a template declares them. Run-history rows gain optional route metadata; absent provenance on old rows means `unknown`. Queries preserve capped rows without adding a field after the 2 KB write limit is enforced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** A route uses the machine that won the job claim. Binary, pool, hook and canary evidence is specific to that machine. The optional pin lives in the shipped template and is identical across machines; the per-run route outcome stays in each machine's existing job ledger.

## 8. Rollback cost

Revert the code in a patch. Existing jobs continue on the old route while this slice is installed. Optional run-history fields are additive JSON; older versions ignore them. No data repair or external reversal is required.

## Conclusion

This slice is safe to commit as a dark, reversible foundation. It needs the audited call adapter, real machine snapshot wiring, three-tier tests and review before a pin becomes live. The code gate stays false until those later pieces pass.

## Second-pass review

The reviewer found that a Codex rate-limit swap could execute on one model while recording the pin as successful. Corrected SessionManager to record the launched model and JobScheduler to compare both returned framework and model. The reviewer rechecked and concurred, with no remaining blocker for this dark foundation.

## Evidence pointers

`tests/unit/JobModelRoute.test.ts` and `tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts`: 23 focused tests passed. TypeScript check passed. Existing manifest-loader and run-history tests: 127 passed.

The first full Local Verify found a stale source-shape assertion in `modelTier-launchMechanisms.test.ts` after the corrected launch-model recording. The assertion now checks the resolved `launchModel`; its companion behavioral test checks the value saved in the session. The same run reported one failure in `detector-canary-cleanup.test.ts`; both affected files passed together on a targeted rerun (38 tests). The full rerun on the updated PR head remains the authority.

## Class-Closure Declaration

This adds a guarded scheduler route but no new autonomous trigger, loop or retry. No agent-authored-artifact defect is being fixed — not applicable.
