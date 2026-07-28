/**
 * Config-seam validation tests — the six invariants (spec §Config) + the
 * storage-fault test list item: each invariant violated → queue OFF + named
 * config-error (never half-boots).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INBOUND_QUEUE_CONFIG,
  DEFAULT_HOLD_FOR_STABILITY_CONFIG,
  validateInboundQueueInvariants,
  redispatchHorizonMs,
  sumBackoffMs,
  PROTOCOL_REDISPATCH_HORIZON_MAX_MS,
} from '../../src/core/inboundQueueConfig.js';
import { getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

const Q = DEFAULT_INBOUND_QUEUE_CONFIG;
const H = DEFAULT_HOLD_FOR_STABILITY_CONFIG;

describe('shipped defaults', () => {
  it('satisfy all six invariants by construction', () => {
    const res = validateInboundQueueInvariants(Q, H);
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('drain-rate invariant holds with the spec-claimed ~4.6x margin', () => {
    const drainRate = H.holdMaxMs + Math.ceil(Q.maxHeldTotal / Q.maxFailoverReleasesPerTick) * H.holdRecheckMs;
    expect(Q.entryTtlMs / drainRate).toBeGreaterThan(4);
  });

  it('ConfigDefaults SHARED_DEFAULTS block matches the canonical defaults (migration parity)', () => {
    const pool = (getMigrationDefaults('standalone') as Record<string, any>).multiMachine.sessionPool;
    expect(pool.inboundQueue).toEqual(Q);
    expect(pool.holdForStability).toEqual(H);
  });
});

describe('each invariant violated → named violation (queue stays OFF)', () => {
  it('(1) drain-rate: anti-herd cap must not become the loss mechanism', () => {
    const res = validateInboundQueueInvariants({ ...Q, entryTtlMs: 60_000, staleCustodyTtlMs: 60_000 }, H);
    expect(res.ok).toBe(false);
    expect(res.violations.some((x) => x.name === 'drain-rate')).toBe(true);
  });

  it('(2) dispatchDeadlineMs < claimStaleMs', () => {
    const res = validateInboundQueueInvariants({ ...Q, dispatchDeadlineMs: 120_000 }, H);
    expect(res.violations.some((x) => x.name === 'dispatch-deadline')).toBe(true);
  });

  it('(3) receipt floor includes pauseMaxMs (round-6/7 — the legal-but-bad tuning)', () => {
    // 2h retention passes the OLD formula (without pauseMaxMs) but fails the
    // corrected one: horizon ≈ 30min + Σbackoff + 2min + 4h + 5min > 2h.
    const res = validateInboundQueueInvariants({ ...Q, deliveredRetentionMs: 2 * 3600_000 }, H);
    expect(res.violations.some((x) => x.name === 'receipt-floor')).toBe(true);
    const horizonWithoutPause = Q.entryTtlMs + sumBackoffMs(Q) + Q.claimStaleMs;
    expect(2 * 3600_000).toBeGreaterThan(horizonWithoutPause); // proves the old formula would have passed
  });

  it('(4) holdMaxMs < entryTtlMs and holdRecheckMs < holdMaxMs', () => {
    expect(
      validateInboundQueueInvariants(Q, { ...H, holdMaxMs: Q.entryTtlMs + 1 }).violations.some((x) => x.name === 'hold-bounds'),
    ).toBe(true);
    expect(
      validateInboundQueueInvariants(Q, { ...H, holdRecheckMs: H.holdMaxMs + 1 }).violations.some((x) => x.name === 'hold-bounds'),
    ).toBe(true);
  });

  it('(5) staleCustodyTtlMs ≤ entryTtlMs', () => {
    const res = validateInboundQueueInvariants({ ...Q, staleCustodyTtlMs: Q.entryTtlMs + 1 }, H);
    expect(res.violations.some((x) => x.name === 'stale-custody')).toBe(true);
  });

  it('(6) protocol anchors: horizon ≤ constant, retention ≥ constant', () => {
    // Pump pauseMaxMs so the horizon exceeds 12h.
    const res = validateInboundQueueInvariants({ ...Q, pauseMaxMs: 13 * 3600_000 }, H);
    expect(res.violations.some((x) => x.name === 'protocol-horizon')).toBe(true);
    const res2 = validateInboundQueueInvariants({ ...Q, deliveredRetentionMs: PROTOCOL_REDISPATCH_HORIZON_MAX_MS - 1 }, H);
    // Retention below the protocol floor violates anchor (and possibly the
    // receipt floor too — both named).
    expect(res2.violations.some((x) => x.name === 'protocol-retention')).toBe(true);
  });

  it('default horizon sits comfortably inside the protocol constant', () => {
    expect(redispatchHorizonMs(Q)).toBeLessThan(PROTOCOL_REDISPATCH_HORIZON_MAX_MS);
  });
});
