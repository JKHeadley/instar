/**
 * FreshProbeScheduler (spec docs/specs/stale-process-login-expired.md, D1b): when a fresh-login probe
 * may run and which result is current. Bounded, persisted, validate-then-cache.
 */
import { describe, it, expect } from 'vitest';
import {
  FreshProbeScheduler, MAX_SPAWNS_PER_WINDOW, BREAKER_AFTER, VERDICT_TTL_MS, type PersistedState, type SchedulerDeps,
} from '../../src/core/FreshProbeScheduler.js';
import type { FreshProbeResult } from '../../src/core/freshLoginProbe.js';

type Mode = FreshProbeResult['verdict'] | 'shed' | 'usage-limit';

function harness(opts: { mode?: Mode; fp?: string; store?: { s: PersistedState } } = {}) {
  let t = 1_000_000;
  const store = opts.store ?? { s: {} as PersistedState };
  const h = {
    mode: (opts.mode ?? 'ok') as Mode, fp: opts.fp ?? 'fp1' as string | null, enabled: true, spawns: 0, breakers: 0,
    verdicts: [] as string[], gate: null as null | Promise<void>,
    advance: (ms: number) => { t += ms; },
  };
  const deps: SchedulerDeps = {
    now: () => t,
    fingerprint: () => h.fp,
    enabled: () => h.enabled,
    load: () => JSON.parse(JSON.stringify(store.s)),
    persist: async (s) => { store.s = JSON.parse(JSON.stringify(s)); },
    probe: async (_id, reserve) => {
      if (h.mode === 'shed') return { verdict: 'not-run', reason: 'spawn-cap-shed' };
      if (!(await reserve())) return { verdict: 'not-run', reason: 'reserve-refused' };
      h.spawns++;
      if (h.gate) await h.gate;
      if (h.mode === 'usage-limit') return { verdict: 'not-run', reason: 'usage-limit' };
      return { verdict: h.mode as FreshProbeResult['verdict'], reason: 'x' };
    },
    onBreaker: () => { h.breakers++; },
    onVerdict: (_id, v) => { h.verdicts.push(v); },
  };
  return { h, store, sched: new FreshProbeScheduler(deps), deps };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FreshProbeScheduler', () => {
  it('an ok within the wait is returned and cached; a second caller reuses it (one spawn)', async () => {
    const { h, sched } = harness();
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('ok');
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('ok');
    expect(h.spawns).toBe(1);
    expect(h.verdicts).toEqual(['ok']);
  });

  it('two callers at once share one probe', async () => {
    const { h, sched } = harness();
    let release!: () => void; h.gate = new Promise((r) => { release = r; });
    const p1 = sched.evaluate('a', { waitMs: 1000, start: true });
    const p2 = sched.evaluate('a', { waitMs: 0, start: true });
    expect(await p2).toBe('pending');
    release();
    expect(await p1).toBe('ok');
    expect(h.spawns).toBe(1);
  });

  it('join-only (start:false) with nothing running starts nothing', async () => {
    const { h, sched } = harness();
    expect(await sched.evaluate('a', { waitMs: 0, start: false })).toBe('inconclusive');
    expect(h.spawns).toBe(0);
  });

  it('a credential change during the probe discards the result: not cached, counters untouched', async () => {
    const { h, sched, store } = harness();
    let release!: () => void; h.gate = new Promise((r) => { release = r; });
    void sched.evaluate('a', { waitMs: 0, start: true });
    await flush(); h.fp = 'fp2'; release(); await flush(); await flush();
    expect(sched.cached('a')).toBeNull();
    expect(h.verdicts).toEqual([]);
    expect(store.s.a.consecutiveInconclusive).toBe(0);
  });

  it('contrary evidence after a probe started discards its ok; a probe started later is kept', async () => {
    const { h, sched } = harness();
    let release!: () => void; h.gate = new Promise((r) => { release = r; });
    void sched.evaluate('a', { waitMs: 0, start: true });
    await flush(); h.advance(10); sched.noteContrary('a'); release(); await flush(); await flush();
    expect(sched.cached('a')).toBeNull();
    h.gate = null; h.advance(31 * 60_000);
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('ok');
  });

  it('turning the switch off hides cached verdicts and stops new probes', async () => {
    const { h, sched } = harness();
    await sched.evaluate('a', { waitMs: 50, start: true });
    h.enabled = false;
    expect(sched.cached('a')).toBeNull();
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('inconclusive');
  });

  it('a cached verdict expires after its lifetime', async () => {
    const { h, sched } = harness({ mode: 'refused' });
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('refused');
    h.advance(VERDICT_TTL_MS);
    expect(sched.cached('a')).toBeNull();
  });

  it('a shed reserves nothing and returns the spawn budget untouched', async () => {
    const { h, sched, store } = harness({ mode: 'shed' });
    expect(await sched.evaluate('a', { waitMs: 50, start: true })).toBe('inconclusive');
    expect(store.s.a?.spawns ?? []).toEqual([]);
    expect(h.spawns).toBe(0);
  });

  it('inconclusive results (incl. usage limit) back off and trip the breaker once', async () => {
    const { h, sched, store } = harness({ mode: 'usage-limit' });
    for (let i = 0; i < BREAKER_AFTER + 2; i++) {
      await sched.evaluate('a', { waitMs: 50, start: true });
      h.advance(5 * 60 * 60_000);
    }
    expect(h.spawns).toBe(BREAKER_AFTER);
    expect(h.breakers).toBe(1);
    expect(store.s.a.breakerUntil).not.toBeNull();
  });

  it('settling: sightings every minute for 12 h never exceed the ceiling, under every mode', async () => {
    for (const mode of ['ok', 'refused', 'unavailable', 'usage-limit'] as Mode[]) {
      const { h, sched } = harness({ mode });
      for (let m = 0; m < 12 * 60; m++) {
        await sched.evaluate('a', { waitMs: 5, start: true });
        h.advance(60_000);
        if (mode === 'ok' && m % 90 === 0) h.fp = `fp-${m}`; // credential churn
      }
      expect(h.spawns).toBeLessThanOrEqual(MAX_SPAWNS_PER_WINDOW);
    }
  });

  it('a restart keeps the reserved spawns and the breaker (persisted)', async () => {
    const store = { s: {} as PersistedState };
    const first = harness({ mode: 'unavailable', store });
    for (let i = 0; i < 3; i++) { await first.sched.evaluate('a', { waitMs: 50, start: true }); first.h.advance(5 * 60 * 60_000); }
    expect(store.s.a.spawns.length).toBe(3);
    const second = harness({ mode: 'unavailable', store });
    second.h.advance(0);
    expect(second.sched.cached('a')).toBeNull(); // verdicts are memory-only
    expect(store.s.a.consecutiveInconclusive).toBe(3); // counters survived
  });
});
