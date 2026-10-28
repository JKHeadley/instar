import { describe, it, expect } from 'vitest';
import { SingleFlightProvider, SingleFlightRefusedError } from '../../src/core/SingleFlightProvider.js';
import { askReferee } from '../../src/core/JevCascade.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

/** A manual clock + timer queue, so 120 s and 10 min elapse instantly. */
function fakeTime() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      t += ms;
      for (const [id, x] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at <= t) { timers.delete(id); x.fn(); }
      }
    },
  };
}

/** A provider whose calls settle only when the test says so (it ignores timeoutMs). */
function controllable() {
  const calls: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = [];
  const p: IntelligenceProvider = {
    evaluate: () => new Promise<string>((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { p, calls };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('SingleFlightProvider', () => {
  it('one call in flight: a second call fails at once when waitMs is 0', async () => {
    const time = fakeTime();
    const { p, calls } = controllable();
    const sf = new SingleFlightProvider(p, { waitMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    const first = sf.evaluate('a');
    await flush();
    await expect(sf.evaluate('b')).rejects.toBeInstanceOf(SingleFlightRefusedError);
    expect(calls).toHaveLength(1);
    calls[0].resolve('ok');
    await expect(first).resolves.toBe('ok');
    // slot free again
    const third = sf.evaluate('c');
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].resolve('ok2');
    await expect(third).resolves.toBe('ok2');
  });

  it('a referee provider that ignores its timeout keeps the slot after askReferee returns on its own timeout', async () => {
    const { p, calls } = controllable();
    const sf = new SingleFlightProvider(p, { waitMs: 0 });
    const out = await askReferee(sf, 'state', [{ rule: 'needs_session', instructions: 'x' }], { component: 'T', timeoutMs: 10 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('timeout');
    expect(sf.status().busy).toBe(true);
    const second = await askReferee(sf, 'state', [{ rule: 'needs_session', instructions: 'x' }], { component: 'T', timeoutMs: 10 });
    expect(second.ok).toBe(false);
    expect(calls).toHaveLength(1); // the overlapping call never reached the provider
    calls[0].resolve('{"needs_session": false}');
    await flush();
    expect(sf.status().busy).toBe(false);
  });

  it('abandons an unsettled call at 120 s, opens the breaker 10 min, then lets one test call through', async () => {
    const time = fakeTime();
    const { p, calls } = controllable();
    const sf = new SingleFlightProvider(p, { waitMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    void sf.evaluate('hang').catch(() => {});
    await flush();
    time.advance(119_000);
    expect(sf.status().busy).toBe(true);
    time.advance(2_000);
    expect(sf.status().busy).toBe(false);
    expect(sf.status().breaker).toBe('open');
    await expect(sf.evaluate('x')).rejects.toMatchObject({ reason: 'breaker-open' });
    time.advance(10 * 60_000);
    expect(sf.status().breaker).toBe('half-open');
    const probe = sf.evaluate('probe');
    await flush();
    // only one test call while half-open
    await expect(sf.evaluate('second-probe')).rejects.toMatchObject({ reason: 'breaker-open' });
    calls[1].resolve('fine');
    await expect(probe).resolves.toBe('fine');
    expect(sf.status().breaker).toBe('closed');
  });

  it('a failing half-open probe re-opens the breaker', async () => {
    const time = fakeTime();
    const { p, calls } = controllable();
    const sf = new SingleFlightProvider(p, { waitMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    void sf.evaluate('hang').catch(() => {});
    await flush();
    time.advance(121_000);
    time.advance(10 * 60_000);
    const probe = sf.evaluate('probe');
    await flush();
    calls[1].reject(new Error('boom'));
    await expect(probe).rejects.toThrow('boom');
    expect(sf.status().breaker).toBe('open');
  });

  it('a waiting instance (backup) waits for the slot, up to waitMs', async () => {
    const { p, calls } = controllable();
    const sf = new SingleFlightProvider(p, { waitMs: 60_000 });
    const first = sf.evaluate('a');
    await flush();
    const second = sf.evaluate('b');
    await flush();
    expect(calls).toHaveLength(1);
    calls[0].resolve('one');
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].resolve('two');
    await expect(second).resolves.toBe('two');
  });
});
