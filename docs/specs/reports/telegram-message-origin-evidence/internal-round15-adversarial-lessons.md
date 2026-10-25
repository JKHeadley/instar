# Round 15 — adversarial and lessons-aware review

Reviewed body `ede1222b4e57964ca5f275b04c4cb21c2845d9253413428b6d01ae2e6b86bd1a`, including the explicit operator metric surface, lifecycle/activation tables and approval/runtime distinction. These are two perspectives from the same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 1.**

The aggregate surface preserves operator scope and incomplete-peer coverage. Transactional event updates and idempotent-insert rules prevent retry/read inflation; sample time plus stale/unknown status prevents unreadable shards becoming fresh zeroes; archive moves cannot duplicate totals. Counters remain signals and grant neither claims nor replay permission. The new lifecycle table preserves one SQLite execution authority and precommitted attempts; the browser table preserves authenticated receipt proof, bounded read-only recovery and no uncertain replay during transport migration.

**P1 — Place partial delivery under the logical operation/group counting unit.** Operator observability currently lists `partial` among physical-child outcomes. The Terms section defines each child as one platform message or revision, while the existing partial-delivery contract concerns a logical group/companion plan in which some children have succeeded and others have not. Move the partial-delivery counter to logical operations/groups; retain individual children as accepted, known-failed, unknown, scheduled and their other concrete states. This aligns the metric label with already-required behavior and avoids implementers assigning the same partial parent state to every physical child. It is PRECISION: no additional delivery or recovery behavior is requested.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0.**

The explicit bounded operator aggregate surface now directly satisfies the full-funnel metrics reading of Observability, beyond relying on retained rows and model-evidence counts. Its test obligations address event duplication, archive invariance and unavailable snapshots. This resolves the prior performance review's concern; that review's original DESIGN classification remains intact despite my round-14 differing assessment.

The separate counting units and no-authority rule preserve Signal vs. Authority. Stale/unknown status and the existing restart-outage acceptance protect the actual-state lesson; the source/wiring matrix cannot replace runtime measurement. The approval flag is explicitly distinguished from runtime compliance. Browser canary recovery still satisfies P22 without a self-restarting repair loop or message replay, and the new summary tables do not weaken their detailed contracts.

## Counts and scope

Combined: **0 DESIGN, 1 PRECISION**. Conformance round 15 checked 90 standards, zero findings, not degraded. No earlier or external finding reclassified. No runtime/source edits or external sends; implementation, activation and complete aggregate convergence remain unclaimed.
