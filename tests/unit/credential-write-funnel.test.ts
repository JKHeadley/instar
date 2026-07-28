import { describe, it, expect } from 'vitest';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('CredentialWriteFunnel — per-slot serialization', () => {
  it('serializes two operations on the SAME slot (no interleave)', async () => {
    const f = new CredentialWriteFunnel();
    const events: string[] = [];
    const a = f.withSlotLock('/h/x', async () => {
      events.push('a-start');
      await delay(30);
      events.push('a-end');
    });
    const b = f.withSlotLock('/h/x', async () => {
      events.push('b-start');
      events.push('b-end');
    });
    await Promise.all([a, b]);
    // b must not start until a has ended.
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs operations on DIFFERENT slots concurrently', async () => {
    const f = new CredentialWriteFunnel();
    const events: string[] = [];
    const a = f.withSlotLock('/h/x', async () => {
      events.push('a-start');
      await delay(30);
      events.push('a-end');
    });
    const b = f.withSlotLock('/h/y', async () => {
      events.push('b-start');
      events.push('b-end');
    });
    await Promise.all([a, b]);
    // b (different slot) runs while a is still delaying → b-start before a-end.
    expect(events.indexOf('b-start')).toBeLessThan(events.indexOf('a-end'));
  });

  it('releases the lock when fn THROWS (finally), letting the next op run', async () => {
    const f = new CredentialWriteFunnel();
    const a = f.withSlotLock('/h/x', async () => {
      throw new Error('boom');
    });
    await expect(a).rejects.toThrow('boom');
    const b = await f.withSlotLock('/h/x', async () => 'ok');
    expect(b).toEqual({ ran: true, value: 'ok' });
    expect(f.trackedSlotCount).toBe(0); // GC'd after release
  });
});

describe('CredentialWriteFunnel — try-lock-with-timeout (never wedged)', () => {
  it('SKIPS (ran:false, named reason) when the slot is held past the timeout', async () => {
    const f = new CredentialWriteFunnel();
    // A holds the slot for 80ms.
    const a = f.withSlotLock('/h/x', async () => {
      await delay(80);
      return 'a';
    });
    // B tries with a 20ms timeout while A holds → skipped, never blocks.
    const b = await f.withSlotLock('/h/x', async () => 'b', { timeoutMs: 20 });
    expect(b.ran).toBe(false);
    expect(b.skippedReason).toContain('timed out');
    expect(b.skippedReason).toContain('/h/x');
    await a; // let A finish cleanly
  });

  it('does NOT deadlock after a skip — a later op on the same slot still runs', async () => {
    const f = new CredentialWriteFunnel();
    const a = f.withSlotLock('/h/x', async () => {
      await delay(60);
      return 'a';
    });
    const b = await f.withSlotLock('/h/x', async () => 'b', { timeoutMs: 15 });
    expect(b.ran).toBe(false);
    await a;
    // After A releases, a fresh acquire must succeed (the queue recovered).
    const c = await f.withSlotLock('/h/x', async () => 'c');
    expect(c).toEqual({ ran: true, value: 'c' });
  });
});

describe('CredentialWriteFunnel — single-mover mutex', () => {
  it('SKIPS a concurrent swap while one is in flight', async () => {
    const f = new CredentialWriteFunnel();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = f.withSingleMover(async () => {
      await held;
      return 'first';
    });
    // While first holds, a second mover is refused.
    expect(f.isSingleMoverHeld()).toBe(true);
    const second = await f.withSingleMover(async () => 'second');
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toContain('single-mover');
    release();
    await first;
    // After release, a new mover succeeds.
    const third = await f.withSingleMover(async () => 'third');
    expect(third).toEqual({ ran: true, value: 'third' });
  });
});

describe('CredentialWriteFunnel — ordered multi-slot', () => {
  it('runs fn holding all slot locks and releases them (no leftover tails)', async () => {
    const f = new CredentialWriteFunnel();
    const res = await f.withSlotLocks(['/h/b', '/h/a'], async () => 'done');
    expect(res).toEqual({ ran: true, value: 'done' });
    expect(f.trackedSlotCount).toBe(0);
  });

  it('two concurrent multi-slot ops over the SAME pair do not interleave (canonical order)', async () => {
    const f = new CredentialWriteFunnel();
    const events: string[] = [];
    // Cross-ordered inputs — the funnel sorts to a canonical order, preventing deadlock.
    const op1 = f.withSlotLocks(['/h/a', '/h/b'], async () => {
      events.push('1-start');
      await delay(25);
      events.push('1-end');
    });
    const op2 = f.withSlotLocks(['/h/b', '/h/a'], async () => {
      events.push('2-start');
      events.push('2-end');
    });
    await Promise.all([op1, op2]);
    // Whichever ran first ran to completion before the other started.
    const firstEnd = events.indexOf(events[0].replace('start', 'end'));
    expect(firstEnd).toBeLessThan(2); // first op's end comes before the second op's start
    expect(events).toHaveLength(4);
  });
});
