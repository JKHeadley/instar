// Governed by (docs/STANDARDS-REGISTRY.md cites this file as enforcement of):
//   *Expected Capacity Enforcement Is an Outcome, Not a Degradation*

/** Mechanically enumerable outcomes for a declared bounded-storage contract. */
export type CapacityEnforcementResult<T> =
  | { kind: 'within-budget'; value: T; originalBytes: number; storedBytes: number; capBytes: number }
  | { kind: 'condensed'; value: T; originalBytes: number; storedBytes: number; capBytes: number }
  | { kind: 'invariant-failure'; originalBytes: number; storedBytes: number; capBytes: number };

export function capacityOutcome<T>(opts: {
  value: T;
  originalBytes: number;
  storedBytes: number;
  capBytes: number;
  condensed: boolean;
}): CapacityEnforcementResult<T> {
  if (opts.storedBytes > opts.capBytes) {
    return {
      kind: 'invariant-failure',
      originalBytes: opts.originalBytes,
      storedBytes: opts.storedBytes,
      capBytes: opts.capBytes,
    };
  }
  return {
    kind: opts.condensed ? 'condensed' : 'within-budget',
    value: opts.value,
    originalBytes: opts.originalBytes,
    storedBytes: opts.storedBytes,
    capBytes: opts.capBytes,
  };
}
