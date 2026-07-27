/**
 * ropeHealth — the U4.3 rope-health snapshot SEAM (u4-4 spec R-r2-7).
 *
 * U4.4's hand-back reconciler needs "is the preferred captain reachable on ≥1
 * rope?". Pre-U4.3 the per-rope dial results are process-private to the
 * PeerEndpointResolver — there is NO readable health source, so U4.4's spec
 * mandates: an ABSENT snapshot reading ⇒ NOT-healthy ⇒ defer (the reconciler
 * fails toward holding, never toward a transfer on missing data).
 *
 * This module is that seam: U4.3 registers its snapshot provider here when it
 * lands; until then `reachableOnAnyRope` returns undefined for every machine
 * and the hand-back reconciler simply never arms. Tests (and the U4.4 E2E
 * synthetic-transition drive) may register a synthetic provider through the
 * same function.
 */

export interface RopeHealthProvider {
  /** Is `machineId` reachable on ≥1 rope per the latest snapshot?
   *  `undefined` = no snapshot record for that machine (never dialed /
   *  evicted / provider absent) — consumers MUST treat it as not-healthy. */
  reachableOnAnyRope(machineId: string): boolean | undefined;
}

/** Minimal row shape consumed from PeerEndpointResolver.snapshot(). */
export interface RopeHealthSnapshotVerdictRow {
  peer: string;
  dead: boolean;
  lastOkAt: number;
  lastFailAt: number;
}

let provider: RopeHealthProvider | null = null;

/** Register the snapshot provider (U4.3's landing point; tests use it too). */
export function setRopeHealthProvider(p: RopeHealthProvider | null): void {
  provider = p;
}

/**
 * Adapt the resolver's single-authority snapshot into U4.4's per-peer verdict.
 * A row that has never recorded a dial is UNKNOWN, not healthy.
 */
export function ropeHealthProviderFromSnapshot(
  snapshot: () => readonly RopeHealthSnapshotVerdictRow[],
  options: { maxAgeMs: number; now?: () => number },
): RopeHealthProvider {
  return {
    reachableOnAnyRope(machineId: string): boolean | undefined {
      const now = (options.now ?? Date.now)();
      const observed = snapshot().filter(
        (row) => row.peer === machineId && (row.lastOkAt > 0 || row.lastFailAt > 0),
      );
      if (observed.length === 0) return undefined;
      return observed.some(
        (row) =>
          row.lastOkAt > 0 &&
          row.lastOkAt > row.lastFailAt &&
          now - row.lastOkAt <= options.maxAgeMs,
      );
    },
  };
}

/** Read the current provider's verdict; absent provider ⇒ undefined (defer). */
export function ropeReachableOnAnyRope(machineId: string): boolean | undefined {
  try {
    return provider?.reachableOnAnyRope(machineId);
  } catch {
    // @silent-fallback-ok — a throwing provider reads as "no data" (undefined),
    // which consumers MUST treat as not-healthy → defer (fail toward holding).
    return undefined;
  }
}
