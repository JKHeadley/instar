import { describe, expect, it } from 'vitest';
import { decideManagedCodexStop } from '../../src/core/ManagedCodexStopDecision.js';
import type { ManagedStopEnrollment, ManagedStopInput } from '../../src/core/ManagedCodexStopDecision.js';

const enrolled: ManagedStopEnrollment = {
  sessionId: 'session', machineId: 'machine', ownerEpoch: 3,
  state: 'active', remaining: 2, issuedCycles: [],
};
const first: ManagedStopInput = {
  enabled: true, sessionId: 'session', machineId: 'machine', ownerEpoch: 3,
  actionOpen: true, paused: false, cycle: 'first', marker: 'marker-first',
};

describe('managed Codex Stop decision', () => {
  it('issues two distinct response cycles and settles the final receipt without another send', () => {
    const a = decideManagedCodexStop(enrolled, first);
    const b = decideManagedCodexStop(a.enrollment, {
      ...first, cycle: 'second', marker: 'marker-second', receipt: a.directive,
    });
    const final = decideManagedCodexStop(b.enrollment, {
      ...first, cycle: 'third', marker: 'marker-third', receipt: b.directive,
    });
    expect(a.directive?.cycle).toBe('first');
    expect(b.directive?.cycle).toBe('second');
    expect(final.directive).toBeUndefined();
    expect(final.enrollment.remaining).toBe(0);
    expect(final.enrollment.outstanding).toBeUndefined();
  });

  it('refuses pending, disabled, paused, completed and foreign claims', () => {
    expect(decideManagedCodexStop({ ...enrolled, state: 'pending' }, first).directive).toBeUndefined();
    for (const change of [
      { enabled: false }, { paused: true }, { actionOpen: false },
      { sessionId: 'other' }, { machineId: 'other' }, { ownerEpoch: 4 },
    ]) {
      expect(decideManagedCodexStop(enrolled, { ...first, ...change }).directive).toBeUndefined();
    }
  });

  it('keeps a lost directive outstanding and prevents prior cycle replay', () => {
    const a = decideManagedCodexStop(enrolled, first);
    expect(decideManagedCodexStop(a.enrollment, first).directive).toBeUndefined();
    const withheld = decideManagedCodexStop(a.enrollment, { ...first, cycle: 'later' });
    expect(withheld.enrollment).toBe(a.enrollment);
    const settled = decideManagedCodexStop(a.enrollment, {
      ...first, cycle: 'later', paused: true, receipt: a.directive,
    });
    expect(settled.enrollment.outstanding).toBeUndefined();
    expect(decideManagedCodexStop(settled.enrollment, first).directive).toBeUndefined();
  });
});
