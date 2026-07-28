/**
 * The loop must actually close — and must not lie about closing.
 *
 * The reader and the actuator are pure, which made them testable but left "the
 * loop closes" a designed property rather than a demonstrated one. This is where
 * it gets demonstrated: real reads in, real writes out.
 *
 * The failure mode to guard hardest is at the very END of the loop. A write that
 * FAILS must not be reported the same way as a decision NOT to write. One is an
 * outage; the other is a principled refusal. Conflating them would let real
 * breakage present as sound judgment — this project's own disease, committed on
 * the last line of the thing built to cure it.
 */
import { describe, it, expect, vi } from 'vitest';
import { runRecurrenceLoop, type LoopDeps } from '../../src/core/recurrenceLoop.js';
import type { Observation } from '../../src/core/RecurrenceReader.js';

const obs = (title: string, store: Observation['store'] = 'attention'): Observation => ({
  store, title, open: true,
});

const many = (title: string, n: number, store: Observation['store'] = 'attention') =>
  Array.from({ length: n }, () => obs(title, store));

const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({
  readAttention: async () => many('a loud recurring thing', 40),
  readActions: async () => [],
  readSentinel: async () => [],
  createAction: async () => ({ id: 'ACT-001' }),
  ...over,
});

describe('the loop closes', () => {
  it('reads, groups, plans and CREATES — end to end', () => {
    const created: string[] = [];
    return runRecurrenceLoop(deps({
      createAction: async (a) => { created.push(a.title); return { id: `ACT-${created.length}` }; },
    })).then((r) => {
      expect(r.created).toHaveLength(1);
      expect(r.created[0].id).toBe('ACT-1');
      expect(r.created[0].observedCount).toBe(40);
      expect(created[0]).toContain('a loud recurring thing');
      expect(r.refused).toBeUndefined();
      expect(r.writeFailures).toHaveLength(0);
    });
  });

  it('passes the real store contents through to the report', async () => {
    const r = await runRecurrenceLoop(deps({
      readAttention: async () => many('x', 12),
      readSentinel: async () => many('y', 5, 'sentinel'),
    }));
    expect(r.report.observationsConsidered).toBe(17);
    expect(r.report.coverage.completeness).toBe('complete');
    expect(r.report.verdict).toBe('recurrence-found');
  });
});

describe('a failed WRITE is not a refusal', () => {
  it('records write failures separately, and does not call them a refusal', async () => {
    // THE test for this module. If the action store rejects the write, that is an
    // OUTAGE. Reporting it as `refused` would dress a real failure as sound
    // judgement — the exact absence-reads-as-presence move this whole project
    // exists to remove, committed on the last line of the loop that cures it.
    const r = await runRecurrenceLoop(deps({
      createAction: async () => { throw new Error('503 action store unavailable'); },
    }));

    expect(r.created).toHaveLength(0);
    expect(r.refused, 'a write outage was reported as a refusal').toBeUndefined();
    expect(r.writeFailures).toHaveLength(1);
    expect(r.writeFailures[0].error).toMatch(/503/);
  });

  it('one failed write does not abort the others', async () => {
    let n = 0;
    const r = await runRecurrenceLoop(deps({
      readAttention: async () => [...many('alpha', 40), ...many('bravo', 40), ...many('charlie', 40)],
      createAction: async (a) => {
        n += 1;
        if (n === 2) throw new Error('transient');
        return { id: `ACT-${n}` };
      },
    }), { maxPerRun: 3 });

    expect(r.created).toHaveLength(2);
    expect(r.writeFailures).toHaveLength(1);
  });
});

describe('an unreadable store is data, not an exception', () => {
  it('does not throw, and names the gap in coverage', async () => {
    const r = await runRecurrenceLoop(deps({
      readSentinel: async () => { throw new Error('log absent'); },
    }));
    expect(r.report.coverage.unreadable).toEqual([{ store: 'sentinel', reason: 'log absent' }]);
    expect(r.report.coverage.completeness).toBe('partial');
    // Sentinel only understates counts, so acting is still correct.
    expect(r.created).toHaveLength(1);
  });

  it('REFUSES to write when the ACTION store is unreadable, and creates nothing', async () => {
    const create = vi.fn(async () => ({ id: 'should-never-happen' }));
    const r = await runRecurrenceLoop(deps({
      readActions: async () => { throw new Error('ENOENT evolution store'); },
      createAction: create,
    }));

    expect(create).not.toHaveBeenCalled();
    expect(r.created).toHaveLength(0);
    expect(r.refused?.reason).toBe('actions-store-unreadable');
    expect(r.writeFailures).toHaveLength(0);
  });

  it('every store unreadable → no verdict, no writes, no crash', async () => {
    const r = await runRecurrenceLoop(deps({
      readAttention: async () => { throw new Error('a'); },
      readActions: async () => { throw new Error('b'); },
      readSentinel: async () => { throw new Error('c'); },
    }));
    expect(r.report.coverage.unreadable).toHaveLength(3);
    expect(r.report.verdict).toBeUndefined();
    expect(r.created).toHaveLength(0);
    expect(r.refused?.reason).toBe('actions-store-unreadable');
  });
});

describe('bounded, and honest about what it held back', () => {
  it('reports deferredByCap so the backlog is never silently truncated', async () => {
    const r = await runRecurrenceLoop(deps({
      readAttention: async () => [
        ...many('alpha', 40), ...many('bravo', 40), ...many('charlie', 40),
        ...many('delta', 40), ...many('echo', 40),
      ],
    }), { maxPerRun: 2 });

    expect(r.created).toHaveLength(2);
    expect(r.deferredByCap).toBe(3);
  });

  it('creates nothing when nothing qualifies', async () => {
    const create = vi.fn(async () => ({ id: 'no' }));
    const r = await runRecurrenceLoop(deps({
      readAttention: async () => many('seen twice', 2),
      createAction: create,
    }));
    expect(create).not.toHaveBeenCalled();
    expect(r.refused?.reason).toBe('no-qualifying-clusters');
  });
});
