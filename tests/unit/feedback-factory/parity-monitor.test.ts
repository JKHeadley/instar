/**
 * Unit tests (Tier 1) — Phase-3 parity monitor + cutover gate (spec §2.5).
 *
 * Both sides of every gate boundary: too-few passes, too-short window, too-few clusters,
 * the satisfied window, and the streak-reset on any divergent pass. `gate().cleared` is the
 * objective condition the Coordination Mandate's execute-cutover authority reads.
 */

import { describe, it, expect } from 'vitest';
import { ParityMonitor, DEFAULT_GATE_POLICY } from '../../../src/feedback-factory/monitor/parityMonitor.js';
import type { ParityResult } from '../../../src/feedback-factory/processor/parity.js';

const result = (over: Partial<ParityResult> = {}): ParityResult => ({
  clustersCompared: 10,
  clustersWithFingerprint: 10,
  outcomesCompared: 10,
  fingerprintDivergences: [],
  outcomeDivergences: [],
  divergent: false,
  ...over,
});

// A tiny policy so tests don't need hour-long windows.
const policy = { requiredCleanPasses: 3, minWindowMs: 60_000, minClustersObserved: 5 };

describe('ParityMonitor.gate — blocked states', () => {
  it('blocks with no passes', () => {
    const m = new ParityMonitor(policy);
    expect(m.gate('2026-06-05T01:00:00Z').cleared).toBe(false);
  });

  it('blocks when fewer than requiredCleanPasses', () => {
    const m = new ParityMonitor(policy);
    m.recordResult(result(), '2026-06-05T00:00:00Z');
    m.recordResult(result(), '2026-06-05T00:30:00Z');
    const g = m.gate('2026-06-05T02:00:00Z');
    expect(g.cleared).toBe(false);
    expect(g.reason).toMatch(/consecutive clean passes/);
  });

  it('blocks when the clean window is too short (enough passes, not enough time)', () => {
    const m = new ParityMonitor(policy);
    m.recordResult(result(), '2026-06-05T00:00:00Z');
    m.recordResult(result(), '2026-06-05T00:00:10Z');
    m.recordResult(result(), '2026-06-05T00:00:20Z');
    const g = m.gate('2026-06-05T00:00:30Z'); // 30s < 60s required
    expect(g.cleared).toBe(false);
    expect(g.reason).toMatch(/clean window/);
  });

  it('blocks when too few clusters observed across the streak', () => {
    const m = new ParityMonitor(policy);
    m.recordResult(result({ clustersCompared: 1 }), '2026-06-05T00:00:00Z');
    m.recordResult(result({ clustersCompared: 1 }), '2026-06-05T00:30:00Z');
    m.recordResult(result({ clustersCompared: 1 }), '2026-06-05T01:00:00Z'); // 3 clusters < 5
    const g = m.gate('2026-06-05T01:30:00Z');
    expect(g.cleared).toBe(false);
    expect(g.reason).toMatch(/clusters/);
  });
});

describe('ParityMonitor.gate — cleared state', () => {
  it('clears when passes, window, and clusters are all satisfied', () => {
    const m = new ParityMonitor(policy);
    m.recordResult(result(), '2026-06-05T00:00:00Z');
    m.recordResult(result(), '2026-06-05T00:30:00Z');
    m.recordResult(result(), '2026-06-05T01:00:00Z');
    const g = m.gate('2026-06-05T01:30:00Z'); // 3 passes, 90min window, 30 clusters
    expect(g.cleared).toBe(true);
    expect(g.cleanPasses).toBe(3);
    expect(g.clustersObserved).toBe(30);
    expect(g.lastDivergentAt).toBeNull();
  });
});

describe('ParityMonitor — streak reset on divergence', () => {
  it('a divergent pass resets the clean streak (prior clean passes do not count)', () => {
    const m = new ParityMonitor(policy);
    // three clean...
    m.recordResult(result(), '2026-06-05T00:00:00Z');
    m.recordResult(result(), '2026-06-05T00:30:00Z');
    m.recordResult(result(), '2026-06-05T01:00:00Z');
    // ...then a divergence (resets)...
    m.recordResult(result({ fingerprintDivergences: [{ clusterId: 'c', instar: 'a', portal: 'b' }], divergent: true }), '2026-06-05T01:30:00Z');
    // ...then two clean (not yet enough).
    m.recordResult(result(), '2026-06-05T02:00:00Z');
    m.recordResult(result(), '2026-06-05T02:30:00Z');
    const g = m.gate('2026-06-05T03:00:00Z');
    expect(g.cleared).toBe(false);
    expect(g.cleanPasses).toBe(2); // only the two after the divergence
    expect(g.lastDivergentAt).toBe('2026-06-05T01:30:00Z');
  });

  it('re-clears once a fresh full clean window elapses after a divergence', () => {
    const m = new ParityMonitor(policy);
    m.recordResult(result({ divergent: true, outcomeDivergences: [{ fingerprint: 'f', kind: 'status', instar: 'x', portal: 'y' }] }), '2026-06-05T00:00:00Z');
    m.recordResult(result(), '2026-06-05T00:30:00Z');
    m.recordResult(result(), '2026-06-05T01:00:00Z');
    m.recordResult(result(), '2026-06-05T01:30:00Z');
    const g = m.gate('2026-06-05T02:00:00Z');
    expect(g.cleared).toBe(true);
    expect(g.lastDivergentAt).toBe('2026-06-05T00:00:00Z');
  });
});

describe('ParityMonitor — recordResult derivation + defaults', () => {
  it('derives divergence count from a ParityResult', () => {
    const m = new ParityMonitor();
    m.recordResult(result({ fingerprintDivergences: [{ clusterId: 'c', instar: 'a', portal: 'b' }], divergent: true }), '2026-06-05T00:00:00Z');
    expect(m.passes[0].divergences).toBe(1);
    expect(m.passes[0].divergent).toBe(true);
  });
  it('default policy requires a 1h window', () => {
    expect(DEFAULT_GATE_POLICY.minWindowMs).toBe(60 * 60 * 1000);
    expect(DEFAULT_GATE_POLICY.requiredCleanPasses).toBe(3);
  });
});
