/**
 * ownershipApplierWiring — the testable construction factory for the transfer-fix §7.2
 * OwnershipApplier (spec: docs/specs/ownership-applier-meshself-ordering-fix.md).
 *
 * Why this exists: the applier's construction CONDITION used to live inline in
 * `server.ts` as `if (durableOwnershipStore && _meshSelfId)`. That guard read
 * `_meshSelfId` ~650 lines BEFORE the boot sequence assigns it, so it was always
 * `null` at the check → the applier was never constructed or ticked, on either machine,
 * and a transferred seat never materialized on the destination. The inline condition was
 * also untestable, which is precisely how the ordering bug shipped.
 *
 * The fix (Structure > Willpower): gate construction on the durable store ALONE — the
 * genuinely relevant condition (applying replicated placements is a durable-store concern;
 * the in-memory store has no cross-machine replication to apply) — and pass `selfMachineId`
 * as a LATE-BOUND getter so the (label-only) self id resolves at tick time instead of being
 * captured as a stale `null` at construction. This makes the wiring order-independent and
 * unit-testable without booting the whole server.
 */
import type { PlacementReader } from './OwnershipApplier.js';
import { OwnershipApplier } from './OwnershipApplier.js';
import type { SessionOwnershipStore } from './SessionOwnershipRegistry.js';

export interface OwnershipApplierWiringDeps {
  /** The durable per-session store, or null when the in-memory store is in use. */
  durableOwnershipStore: SessionOwnershipStore | null;
  /** Reads replicated + own placement entries (CoherenceJournalReader). */
  reader: PlacementReader;
  /**
   * Late-bound resolver for this machine's mesh id. May legitimately return null/undefined
   * at construction time (before the boot sequence assigns it); it is used ONLY for the
   * SELF-vs-peer log label, never for materialization.
   */
  getSelfMachineId: () => string | null | undefined;
  scanLimit?: number;
  logger?: (msg: string) => void;
  now?: () => number;
}

/**
 * Build the OwnershipApplier when (and only when) the durable ownership store is active.
 * Returns `null` for the in-memory store (nothing to apply). NEVER gates on the self id —
 * that was the boot-ordering bug. The caller schedules the boot tick + interval on a
 * non-null result.
 */
export function wireOwnershipApplier(deps: OwnershipApplierWiringDeps): OwnershipApplier | null {
  if (!deps.durableOwnershipStore) return null;
  return new OwnershipApplier({
    reader: deps.reader,
    store: deps.durableOwnershipStore,
    selfMachineId: deps.getSelfMachineId, // getter — resolved per-tick, never captured stale
    scanLimit: deps.scanLimit,
    logger: deps.logger,
    now: deps.now,
  });
}
