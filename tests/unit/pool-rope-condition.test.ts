/**
 * Unit tests — decorateWithRopeCondition (src/server/poolRopeCondition.ts).
 *
 * Semantic-correctness coverage for both sides of every boundary: monitor
 * present vs dark, tracked vs untracked machine, all-down vs healthy
 * classification, and the identity pass-through contract (absent stays
 * ABSENT, never an `undefined`-valued key).
 */
import { describe, it, expect } from 'vitest';
import { decorateWithRopeCondition } from '../../src/server/poolRopeCondition.js';

const row = (machineId: string) => ({ machineId, nickname: machineId, online: true });

describe('decorateWithRopeCondition', () => {
  it('attaches ropeCondition to rows the monitor tracks', () => {
    const out = decorateWithRopeCondition(
      [row('m_a'), row('m_b')],
      [{ machineId: 'm_b', condition: 'peer-offline', allDownSince: 1784861757377 }],
    );
    expect(out.find((m) => m.machineId === 'm_b')?.ropeCondition).toBe('peer-offline');
    expect(out.find((m) => m.machineId === 'm_b')?.ropeAllDownSince).toBe(
      new Date(1784861757377).toISOString(),
    );
  });

  it('leaves untracked rows untouched — no ropeCondition key at all (self / unknown peers)', () => {
    const out = decorateWithRopeCondition(
      [row('m_a'), row('m_b')],
      [{ machineId: 'm_b', condition: 'ok', allDownSince: null }],
    );
    const selfRow = out.find((m) => m.machineId === 'm_a')!;
    expect('ropeCondition' in selfRow).toBe(false);
    expect('ropeAllDownSince' in selfRow).toBe(false);
  });

  it('omits ropeAllDownSince when the condition is not all-down (null onset)', () => {
    const out = decorateWithRopeCondition(
      [row('m_b')],
      [{ machineId: 'm_b', condition: 'degraded', allDownSince: null }],
    );
    expect(out[0].ropeCondition).toBe('degraded');
    expect('ropeAllDownSince' in out[0]).toBe(false);
  });

  it('is the identity when the monitor is dark (undefined / null / empty peers)', () => {
    const machines = [row('m_a')];
    expect(decorateWithRopeCondition(machines, undefined)).toBe(machines);
    expect(decorateWithRopeCondition(machines, null)).toBe(machines);
    expect(decorateWithRopeCondition(machines, [])).toBe(machines);
  });

  it('does not mutate the input rows (decoration is a copy)', () => {
    const machines = [row('m_b')];
    decorateWithRopeCondition(machines, [
      { machineId: 'm_b', condition: 'urgent', allDownSince: 1784861757377 },
    ]);
    expect('ropeCondition' in machines[0]).toBe(false);
  });

  it('ignores a non-finite allDownSince rather than rendering an invalid date', () => {
    const out = decorateWithRopeCondition(
      [row('m_b')],
      [{ machineId: 'm_b', condition: 'peer-offline', allDownSince: Number.NaN }],
    );
    expect(out[0].ropeCondition).toBe('peer-offline');
    expect('ropeAllDownSince' in out[0]).toBe(false);
  });
});

// CMT-1541: whether this machine is working to reconnect a peer it cannot reach.
import { decorateWithReconnect } from '../../src/server/poolRopeCondition.js';

describe('decorateWithReconnect', () => {
  const machines = [{ machineId: 'a' }, { machineId: 'b' }, { machineId: 'c' }];
  it('no prober rows (dark) leaves every row untouched — absent, never "nothing is fixing it"', () => {
    expect(decorateWithReconnect(machines, undefined)).toBe(machines);
    expect(decorateWithReconnect(machines, [])).toBe(machines);
  });
  it('one working connection means connected; all dead means retrying; all exhausted means retrying slowly', () => {
    const out = decorateWithReconnect(machines, [
      { peer: 'a', state: 'healthy', nextProbeDueAt: null },
      { peer: 'a', state: 'dead', nextProbeDueAt: 5 },
      { peer: 'b', state: 'dead', nextProbeDueAt: 2_000 },
      { peer: 'b', state: 'exhausted', nextProbeDueAt: 1_000 },
    ]);
    expect(out[0]).toEqual({ machineId: 'a', reconnect: { state: 'connected' } });
    expect(out[1]).toEqual({ machineId: 'b', reconnect: { state: 'retrying', nextTryAt: new Date(1_000).toISOString() } });
    expect(out[2]).toBe(machines[2]);
    const slow = decorateWithReconnect([{ machineId: 'd' }], [{ peer: 'd', state: 'exhausted', nextProbeDueAt: null }]);
    expect(slow[0]).toEqual({ machineId: 'd', reconnect: { state: 'retrying-slowly' } });
  });
});
