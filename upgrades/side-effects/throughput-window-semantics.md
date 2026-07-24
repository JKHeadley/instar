# Side-Effects Review — Throughput window semantics

**Version / slug:** `throughput-window-semantics`
**Date:** `2026-07-21`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `not required`

## Summary of the change

The existing `BlockerLifecycleService` completion projections now label their independently selected time scopes. Summary reports a rolling-hours window; trend reports rolling days, UTC buckets, and a partial current day. The existing pool sanitizer preserves and validates those additive labels. No count, state owner, action, or decision point changes.

## Decision-point inventory

No decision point is added, modified, or removed. This is a read-only measurement contract clarification.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Older servers do not emit the additive label until upgraded; schema-v1 peers remain explicitly unsupported under the existing pool rules.

## 3. Level-of-abstraction fit

The label is produced beside the count in the existing service projection and validated by the existing pool read sanitizer. This is the lowest layer that knows the actual requested window and avoids a parallel route, store, or derived aggregate.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It describes the scope of an existing observe-only signal and grants it no selection, pressure, notification, grading, gating, or action authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- **Shadowing:** none; the existing count fields and route envelopes remain intact.
- **Double-fire:** none; reads add no writes or events.
- **Races:** the exact caller-supplied window is labeled, avoiding drift from a second clock read.
- **Feedback loops:** none; no consumer or authority is changed.

## 6. External surfaces

The two authenticated blocker-lifecycle responses gain additive `window` metadata on the deliverable-completion factor. Clients keyed to schema version 2 already ignore additive fields. No persistent state, notice, URL, or operator action changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Proxied-on-read through the existing `scope=pool` composition. Each machine retains its local ledger truth and the pool sanitizer validates and preserves the machine-tagged window label. No user-facing notice is emitted, no durable state can strand on topic transfer, and no URL is generated.

## 8. Rollback cost

Pure additive code and documentation change: revert and ship a patch. There is no data migration or agent-state repair. Rolling back removes the labels and restores the prior ambiguity but does not change counts.

## Conclusion

The change makes two deliberately different scopes visibly different without inventing numbers or altering the measurement substrate. It is clear to ship.

## Second-pass review

Not required: no sentinel, guard, gate, watchdog, lifecycle, dispatch, or message-flow authority changes.

## Evidence pointers

- `tests/unit/BlockerLifecycleService-throughput.test.ts`
- `tests/integration/blocker-throughput-pool-routes.test.ts`
- `tests/e2e/blocker-throughput-count-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
