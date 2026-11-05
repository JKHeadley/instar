import { describe, expect, it, vi } from 'vitest';
import {
  NUDGE_FAILURE_PAUSE_MS,
  NUDGE_FAILURE_STREAK_LIMIT,
  NUDGE_MAX_PASSES_PER_HOUR,
  NUDGE_MAX_PENDING_KEYS,
  OwnershipNudgeReceiver,
  parseOwnershipNudge,
  sendOwnershipNudges,
  type OwnershipNudgeReceiverDeps,
  type OwnershipNudgeRow,
} from '../../src/core/OwnershipNudge.js';

const nudge = (sessionKey: string, epoch = 5, landedAt = 1000) => ({ sessionKey, epoch, landedAt });

function harness(over: Partial<OwnershipNudgeReceiverDeps> = {}) {
  let clock = 10_000;
  const epochs = new Map<string, number>();
  const rows: OwnershipNudgeRow[] = [];
  const woken: string[] = [];
  const pulls: string[] = [];
  const order: string[] = [];
  const r = new OwnershipNudgeReceiver({
    available: () => true,
    pullPlacements: async (s) => { pulls.push(s); order.push('pull'); return true; },
    tickApplier: () => { order.push('tick'); },
    localEpoch: (k) => epochs.get(k) ?? null,
    wake: (k) => { woken.push(k); order.push('wake'); },
    record: (row) => rows.push(row),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...over,
  });
  return { r, epochs, rows, woken, pulls, order, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('sendOwnershipNudges', () => {
  const deps = (send: (id: string) => Promise<unknown>) => ({
    selfMachineId: 'me',
    activeMachineIds: () => ['me', 'a', 'b', 'a'],
    flush: vi.fn(),
    send: (id: string) => send(id),
  });

  it('reaches every other active machine once, after flushing', () => {
    const order: string[] = [];
    const d = deps(async (id) => { order.push(id); });
    d.flush.mockImplementation(() => order.push('flush'));
    sendOwnershipNudges(d, nudge('1'));
    expect(order).toEqual(['flush', 'a', 'b']);
  });

  it('a refused send, a thrown send, a failed flush and a failed peer list all leave the caller untouched', async () => {
    const rejected = deps(() => Promise.reject(new Error('claim-unauthorized')));
    expect(() => sendOwnershipNudges(rejected, nudge('1'))).not.toThrow();
    const thrown = deps(() => { throw new Error('boom'); });
    thrown.flush.mockImplementation(() => { throw new Error('disk'); });
    expect(() => sendOwnershipNudges(thrown, nudge('1'))).not.toThrow();
    expect(() => sendOwnershipNudges({ ...thrown, activeMachineIds: () => { throw new Error('x'); } }, nudge('1'))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('OwnershipNudgeReceiver', () => {
  it('pulls only from the sender, ticks, then wakes a key at the nudge epoch', async () => {
    const h = harness();
    h.epochs.set('1', 5);
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.pulls).toEqual(['peer']);
    expect(h.order).toEqual(['pull', 'tick', 'wake']);
    expect(h.woken).toEqual(['1']);
    expect(h.rows[0]).toMatchObject({ outcome: 'reached', sender: 'peer', sessionKey: '1', epoch: 5 });
    expect(h.rows[0].landedToReachedMs).toBe(h.now() - 1000);
  });

  it('a key one epoch below the nudge is not woken: waking it would retry against the old owner', async () => {
    const h = harness();
    h.epochs.set('1', 4);
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.woken).toEqual([]);
    expect(h.rows[0].outcome).toBe('not-reached');
  });

  it('a key above the nudge epoch counts as reached', async () => {
    const h = harness();
    h.epochs.set('1', 6);
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.woken).toEqual(['1']);
  });

  it('an unknown key has no epoch to reach and wakes nothing', async () => {
    const h = harness();
    h.r.receive('peer', nudge('junk'));
    await h.r.whenSettled();
    expect(h.woken).toEqual([]);
  });

  it('overlapping nudges for different keys all wake after a pass that covers them, spaced 1 s apart', async () => {
    let release: (v: boolean) => void = () => {};
    const starts: number[] = [];
    let first = true;
    const h2 = harness({
      pullPlacements: () => {
        starts.push(h2.now());
        if (first) { first = false; return new Promise((resolve) => { release = resolve; }); }
        return Promise.resolve(true);
      },
    });
    for (const k of ['1', '2', '3']) h2.epochs.set(k, 5);
    h2.r.receive('peer', nudge('1'));
    h2.r.receive('peer', nudge('2'));
    h2.r.receive('peer', nudge('3'));
    expect(starts).toHaveLength(1);
    release(true);
    await h2.r.whenSettled();
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect([...h2.woken].sort()).toEqual(['1', '2', '3']);
  });

  it('a pass whose gap has already passed does not wait', async () => {
    const sleep = vi.fn(async () => {});
    const h = harness({ sleep });
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('one sender cannot hold up another', async () => {
    const pulled: string[] = [];
    const h = harness({
      pullPlacements: (s) => { pulled.push(s); return s === 'slow' ? new Promise(() => {}) : Promise.resolve(true); },
    });
    h.r.receive('slow', nudge('1'));
    h.r.receive('fast', nudge('2'));
    expect(pulled).toEqual(['slow', 'fast']);
  });

  it('pending keys stop at the cap, dropping the oldest', async () => {
    const seen: string[] = [];
    let release: (v: boolean) => void = () => {};
    let first = true;
    const h = harness({
      pullPlacements: () => (first ? (first = false, new Promise((resolve) => { release = resolve; })) : Promise.resolve(true)),
      localEpoch: () => 5,
      wake: (k) => seen.push(k),
    });
    h.r.receive('peer', nudge('first'));
    for (let i = 0; i < NUDGE_MAX_PENDING_KEYS + 1; i++) h.r.receive('peer', nudge(`k${i}`));
    release(true);
    await h.r.whenSettled();
    expect(seen).toContain('first');
    expect(seen).not.toContain('k0');
    expect(seen).toContain(`k${NUDGE_MAX_PENDING_KEYS}`);
    expect(seen).toHaveLength(NUDGE_MAX_PENDING_KEYS + 1);
  });

  it('the hourly budget stops passes at the limit, not before, and frees up an hour later', async () => {
    const h = harness();
    for (let i = 0; i < NUDGE_MAX_PASSES_PER_HOUR; i++) {
      h.epochs.set(`${i}`, 5);
      h.r.receive('peer', nudge(`${i}`));
      await h.r.whenSettled();
    }
    expect(h.pulls).toHaveLength(NUDGE_MAX_PASSES_PER_HOUR);
    h.r.receive('peer', nudge('over'));
    await h.r.whenSettled();
    expect(h.pulls).toHaveLength(NUDGE_MAX_PASSES_PER_HOUR);
    expect(h.rows.at(-1)?.outcome).toBe('budget-stop');
    h.advance(3_600_001);
    h.epochs.set('later', 5);
    h.r.receive('peer', nudge('later'));
    await h.r.whenSettled();
    expect(h.pulls).toHaveLength(NUDGE_MAX_PASSES_PER_HOUR + 1);
  });

  it('the failure brake stops at the streak limit, not before; a clean pass resets it; it lifts after the pause', async () => {
    const h = harness({ pullPlacements: async () => false });
    for (let i = 0; i < NUDGE_FAILURE_STREAK_LIMIT - 1; i++) {
      h.r.receive('peer', nudge('1'));
      await h.r.whenSettled();
    }
    expect(h.rows.every((r) => r.outcome === 'not-reached')).toBe(true);
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    const before = h.rows.length;
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.rows.slice(before).map((r) => r.outcome)).toEqual(['failure-pause']);
    h.advance(NUDGE_FAILURE_PAUSE_MS + 1);
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.rows.at(-1)?.outcome).toBe('not-reached');

    let ok = false;
    const pullsSeen: boolean[] = [];
    const reset = harness({ pullPlacements: async () => { pullsSeen.push(ok); return ok; } });
    reset.epochs.set('1', 5);
    for (let i = 0; i < NUDGE_FAILURE_STREAK_LIMIT - 1; i++) { reset.r.receive('peer', nudge('1')); await reset.r.whenSettled(); }
    ok = true;
    reset.r.receive('peer', nudge('1'));
    await reset.r.whenSettled();
    ok = false;
    for (let i = 0; i < NUDGE_FAILURE_STREAK_LIMIT - 1; i++) { reset.r.receive('peer', nudge('1')); await reset.r.whenSettled(); }
    expect(reset.rows.some((r) => r.outcome === 'failure-pause')).toBe(false);
  });

  it('a thrown pull, tick or read is a failed pass, not a crash', async () => {
    const h = harness({ pullPlacements: async () => { throw new Error('net'); }, localEpoch: () => { throw new Error('disk'); } });
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.rows[0].outcome).toBe('not-reached');
  });

  it('a strict no-op with an evidence row when replication is off or the puller is unbound', async () => {
    const h = harness({ available: () => false });
    h.r.receive('peer', nudge('1'));
    await h.r.whenSettled();
    expect(h.pulls).toEqual([]);
    expect(h.rows[0].outcome).toBe('off');
  });
});

describe('parseOwnershipNudge', () => {
  it('accepts the three fields and refuses anything malformed', () => {
    expect(parseOwnershipNudge(nudge('1'))).toEqual(nudge('1'));
    expect(parseOwnershipNudge({ sessionKey: '', epoch: 1, landedAt: 1 })).toBeNull();
    expect(parseOwnershipNudge({ sessionKey: 'x'.repeat(257), epoch: 1, landedAt: 1 })).toBeNull();
    expect(parseOwnershipNudge({ sessionKey: '1', epoch: Number.NaN, landedAt: 1 })).toBeNull();
    expect(parseOwnershipNudge({ sessionKey: '1', epoch: 1 })).toBeNull();
  });
});
