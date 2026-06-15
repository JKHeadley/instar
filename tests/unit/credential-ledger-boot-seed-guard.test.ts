/**
 * Unit test for the B3a boot-seed guard (`shouldBootSeedCredentialLedger`).
 *
 * This is the NEW decision the boot-seed wiring introduced (server.ts, just before the B3b
 * rebalancer timer). Without a runtime trigger the CredentialLocationLedger stays NEVER-SEEDED
 * forever — getAssignments() returns [] and the rebalancer only ever sees the default slot, so it
 * can decide but never actuate a use-it-or-lose-it drain. The guard decides WHEN to fire the
 * (non-destructive, already-unit-tested) seedFromOracle() at boot.
 *
 * Both sides of every boundary (Testing Integrity — semantic correctness):
 *  - enabled + not-seeded            → seed   (the populate path AND the unknown-mode recovery path,
 *                                              since isSeeded() is false for both)
 *  - disabled (dark fleet)           → no-op  (byte-for-byte today's behavior; no probe)
 *  - enabled + already seeded        → no-op  (idempotent across restarts — never re-probes)
 *  - disabled + already seeded       → no-op
 */

import { describe, it, expect } from 'vitest';
import { shouldBootSeedCredentialLedger } from '../../src/core/CredentialLocationLedger.js';

describe('shouldBootSeedCredentialLedger — boot-seed guard (B3a)', () => {
  it('seeds when enabled AND the ledger is not yet seeded (never-seeded / unknown-mode recovery)', () => {
    expect(shouldBootSeedCredentialLedger(true, false)).toBe(true);
  });

  it('does NOT seed when the feature is disabled (dark fleet) — no probe, today’s behavior', () => {
    expect(shouldBootSeedCredentialLedger(false, false)).toBe(false);
  });

  it('does NOT re-seed when the ledger is already seeded — idempotent across restarts', () => {
    expect(shouldBootSeedCredentialLedger(true, true)).toBe(false);
  });

  it('does NOT seed when disabled even if somehow already seeded', () => {
    expect(shouldBootSeedCredentialLedger(false, true)).toBe(false);
  });
});
