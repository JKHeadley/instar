/**
 * Per-account Codex health — the gauge a degradation trigger reads.
 *
 * Instar records LLM metrics against the component that ASKED, never the account
 * that ANSWERED, so "is this account unwell" had no measurement behind it. These
 * pin the gauge, and above all pin the honest-unknown rule: it must refuse to
 * answer rather than guess, because a trigger acting on two samples would swap
 * live sessions on noise.
 */

import { describe, it, expect } from 'vitest';
import { CodexAccountHealth } from '../../src/core/CodexAccountHealth.js';

function sample(accountId: string, latencyMs: number, ok: boolean, atMs: number) {
  return { accountId, latencyMs, ok, atMs };
}

describe('CodexAccountHealth', () => {
  it('reports median latency and error rate from real samples', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, minSamples: 3 });
    h.record(sample('a', 100, true, now));
    h.record(sample('a', 200, true, now));
    h.record(sample('a', 300, false, now));

    const r = h.read('a')!;
    expect(r.p50LatencyMs).toBe(200);
    expect(r.errorRate).toBeCloseTo(1 / 3);
    expect(r.samples).toBe(3);
  });

  it('THE HONEST-UNKNOWN RULE: too few samples returns null, not a number', () => {
    // The load-bearing property. A trigger acting on one or two samples would
    // move live sessions on noise; the cost of a too-eager swap (thrash) is worse
    // than the cost of a late one (a slow account stays slow a little longer).
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, minSamples: 5 });
    for (let i = 0; i < 4; i++) h.record(sample('a', 60_000, false, now));

    expect(h.read('a')).toBeNull();

    // CONTROL: one more sample and it answers — so null was the sample guard, not
    // a broken store.
    h.record(sample('a', 60_000, false, now));
    expect(h.read('a')).not.toBeNull();
    expect(h.read('a')!.errorRate).toBe(1);
  });

  it('an unknown account returns null rather than a healthy-looking zero', () => {
    const h = new CodexAccountHealth();
    expect(h.read('never-seen')).toBeNull();
  });

  it('samples outside the window are ignored — health is about NOW', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, windowMs: 60_000, minSamples: 3 });
    // Old, terrible samples.
    for (let i = 0; i < 10; i++) h.record(sample('a', 60_000, false, now));
    // Time passes beyond the window; fresh, healthy samples arrive.
    now += 120_000;
    for (let i = 0; i < 3; i++) h.record(sample('a', 900, true, now));

    const r = h.read('a')!;
    expect(r.samples).toBe(3);
    expect(r.errorRate).toBe(0);
    expect(r.p50LatencyMs).toBe(900);
  });

  it('when the window empties, it returns to not-knowing rather than to stale good news', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, windowMs: 60_000, minSamples: 3 });
    for (let i = 0; i < 5; i++) h.record(sample('a', 500, true, now));
    expect(h.read('a')).not.toBeNull();

    now += 120_000;
    expect(h.read('a')).toBeNull();
  });

  it('accounts are measured independently — the whole point', () => {
    // If two accounts collapsed into one reading, "swap to the healthier one"
    // could not distinguish them.
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, minSamples: 3 });
    for (let i = 0; i < 4; i++) h.record(sample('slow', 60_000, false, now));
    for (let i = 0; i < 4; i++) h.record(sample('fast', 800, true, now));

    const slow = h.read('slow')!;
    const fast = h.read('fast')!;
    expect(slow.p50LatencyMs).toBeGreaterThan(fast.p50LatencyMs);
    expect(slow.errorRate).toBe(1);
    expect(fast.errorRate).toBe(0);
    expect(h.readAll().map((r) => r.accountId).sort()).toEqual(['fast', 'slow']);
  });

  it('readAll omits accounts that cannot answer rather than inventing readings', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, minSamples: 3 });
    for (let i = 0; i < 3; i++) h.record(sample('answerable', 500, true, now));
    h.record(sample('too-few', 500, true, now));

    expect(h.readAll().map((r) => r.accountId)).toEqual(['answerable']);
  });

  it('memory is bounded — a long-running process cannot grow it without limit', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, maxSamplesPerAccount: 10, minSamples: 1 });
    for (let i = 0; i < 500; i++) h.record(sample('a', i, true, now));
    expect(h.read('a')!.samples).toBe(10);
  });

  it('recording never throws, whatever it is handed', () => {
    // This sits on the hot path of every internal Codex call. A gauge that can
    // break the engine it measures is worse than no gauge.
    const h = new CodexAccountHealth();
    const junk = [
      undefined, null, {}, { accountId: '' }, { accountId: 'a' },
      { accountId: 'a', latencyMs: NaN, ok: true, atMs: 1 },
      { accountId: 'a', latencyMs: -5, ok: true, atMs: 1 },
    ];
    for (const j of junk) expect(() => h.record(j as never)).not.toThrow();
    expect(h.read('a')).toBeNull();
  });

  it('prune drops out-of-window samples and forgets empty accounts', () => {
    let now = 1_000_000;
    const h = new CodexAccountHealth({ now: () => now, windowMs: 60_000, minSamples: 1 });
    h.record(sample('a', 500, true, now));
    now += 120_000;
    h.prune();
    expect(h.read('a')).toBeNull();
    expect(h.readAll()).toEqual([]);
  });
});
