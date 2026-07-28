# Side-Effects Review — evolution action auto-expiry

**Version / slug:** `evolution-action-auto-expiry`
**Date:** 2026-07-10
**Author:** Instar-codey
**Second-pass reviewer:** not required

## Summary of the change

Adds a scheduled conservative cleanup pass to `EvolutionManager`, configured by `evolutionActions.autoExpiry`. It ships enabled but observation-only (`dryRun:true`), protects non-pending/critical/pinned/future-deadline records, coalesces real removals into one save, and routes them through the existing replication tombstone funnel. Config defaults, server wiring, installed-agent awareness/migration, three test tiers, and the self-action convergence registry are included.

## Decision-point inventory

- `EvolutionManager.runActionAutoExpirySweep` — add — deterministic retention eligibility over local queue records.
- `EvolutionManager.saveActions` removal candidates — modify — accepts explicit removals while retaining its survivor guard and established replication authority.

## 1. Over-block

No message/action block surface. A pending ordinary item older than the configured age can be removed after dry-run is deliberately disabled. Conservative precedence retains critical/pinned work, all non-pending states, malformed dates, and future deadlines.

## 2. Under-block

Old pending actions with a future deadline are intentionally retained, as are custom protection conventions other than `critical` priority or the case-insensitive `pinned` tag. New arrivals may become eligible between cadenced sweeps; this is bounded by the configured interval.

## 3. Level-of-abstraction fit

Eligibility belongs in `EvolutionManager`, the owner of queue status and persistence. Deletion reuses `saveActions` rather than creating a parallel filesystem or replication path. The scheduler is a thin cadence around that single operation.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no conversational block/allow surface.

This is a constrained retention policy over typed durable records, not a judgment about message meaning. Dry-run separates observation from mutation by default; an operator's explicit config supplies the authority to activate removal.

## 5. Interactions

- **Shadowing:** status/protection checks precede age, so age cannot override a stronger retention rule.
- **Double-fire:** all eligible IDs are collected and saved once; the interval is constructed once per manager.
- **Races:** the existing atomic temp-file rename remains the write mechanism. Concurrent cross-process writers were already outside this store's locking model; this change adds no second writer path.
- **Feedback loops:** a real sweep removes its own eligible inputs, so the next tick settles to zero until new eligible work arrives. The self-action registry ratchet proves horizon-independent convergence.

## 6. External surfaces

Fleet users receive the config and awareness text. Default dry-run produces only aggregate server logging. With dry-run disabled, persistent queue state changes and replication peers receive tombstones. No external service call, user-facing notice, URL, approval route, or phone-only operator action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Replicated.** Real expiry uses `EvolutionManager.saveActions` → `EvolutionActionReplicationEmitter.emitDelete` → coherence journal → peer replicated-store reader. The content-fingerprint tombstone wins over prior puts, including after cursor-zero resync. The cadence runs per machine, but deletion is idempotent by record fingerprint and convergence is shared through replication. It emits no user notices, holds no topic-bound state, and generates no URLs.

## 8. Rollback cost

Set `enabled:false` to stop scheduling or `dryRun:true` to stop mutation immediately. A code rollback is a normal patch release. Tombstones already emitted by an intentionally activated real sweep are durable deletions and should not be reversed automatically; restoring one requires re-adding the action as a new record. Default deployment emits none.

## Conclusion

The review tightened the implementation around the existing deletion funnel, added an explicit resync/no-resurrection proof, and registered the scheduler with the convergence ratchet. The dry-run default and protection precedence make fleet rollout conservative. Clear to ship after the full test and CI gates.

## Second-pass review

Not required: this does not touch messaging, dispatch, session lifecycle, compaction, trust, or a sentinel/guard/gate/watchdog.

## Evidence pointers

- `tests/unit/evolution-manager-action-replication.test.ts`
- `tests/integration/evolution-action-auto-expiry.integration.test.ts`
- `tests/e2e/ws2-evolution-actions-cross-instance.test.ts`
- `tests/unit/self-action-convergence.test.ts`
- `tests/unit/feature-delivery-completeness.test.ts` (new awareness section registered for Claude, Codex, and Gemini parity)

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registered model drives repeated expiry ticks under a permanent eligible-set fixture and requires the durable-removal brake to make emissions settle at three rather than scale with the horizon }`.
