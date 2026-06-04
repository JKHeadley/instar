import { describe, it, expect, afterEach } from 'vitest';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';

describe('ResourceLedger — rate-limit event store (Phase A)', () => {
  let ledger: ResourceLedger | null = null;
  afterEach(() => { ledger?.close(); ledger = null; });

  const mk = () => { ledger = new ResourceLedger({ dbPath: ':memory:' }); return ledger; };

  it('records breaker trip/recover events and summarizes them', () => {
    const l = mk();
    const now = 1_000_000;
    l.recordRateLimitEvent({ ts: now - 3_600_000, kind: 'circuit-open', source: 'circuit-breaker', seq: 1, reason: '429' });
    l.recordRateLimitEvent({ ts: now - 1_800_000, kind: 'circuit-open', source: 'circuit-breaker', seq: 2, reason: '529' });
    l.recordRateLimitEvent({ ts: now - 600_000, kind: 'circuit-recover', source: 'circuit-breaker', seq: 3 });

    const s = l.rateLimitSummary(now, 2 * 3_600_000);
    expect(s.circuitOpenCount).toBe(2);
    expect(s.circuitRecoverCount).toBe(1);
    expect(s.totalEvents).toBe(3);
    expect(s.tripsPerHour).toBe(1); // 2 trips over a 2h window
  });

  it('is idempotent on (source, ts, seq) — same event twice collapses', () => {
    const l = mk();
    const e = { ts: 5_000, kind: 'circuit-open' as const, source: 'circuit-breaker' as const, seq: 7, reason: 'x' };
    l.recordRateLimitEvent(e);
    l.recordRateLimitEvent(e); // replay (e.g. restart) — must not double-count
    expect(l.rateLimitSummary(10_000, 10_000).circuitOpenCount).toBe(1);
  });

  it('keeps two genuine same-millisecond events distinct (different seq)', () => {
    const l = mk();
    l.recordRateLimitEvent({ ts: 5_000, kind: 'circuit-open', source: 'circuit-breaker', seq: 1 });
    l.recordRateLimitEvent({ ts: 5_000, kind: 'circuit-open', source: 'circuit-breaker', seq: 2 });
    expect(l.rateLimitSummary(10_000, 10_000).circuitOpenCount).toBe(2);
  });

  it('counts session-sentinel detections separately from breaker trips', () => {
    const l = mk();
    const now = 100_000;
    l.recordRateLimitEvent({ ts: now - 1000, kind: 'circuit-open', source: 'circuit-breaker', seq: 1 });
    l.recordRateLimitEvent({ ts: now - 900, kind: 'throttle', source: 'session-sentinel', seq: 1, sessionName: 'sess-a' });
    l.recordRateLimitEvent({ ts: now - 800, kind: 'throttle', source: 'session-sentinel', seq: 2, sessionName: 'sess-b' });
    const s = l.rateLimitSummary(now, 10_000);
    expect(s.circuitOpenCount).toBe(1);
    expect(s.sentinelCount).toBe(2);
    expect(s.totalEvents).toBe(3);
    // breaker and sentinel never collide on id even with same ts+seq
    const byKind = l.rateLimitByKind(now, 10_000);
    expect(byKind.find(k => k.kind === 'throttle')?.count).toBe(2);
  });

  it('rateLimitEvents returns newest first and respects the window', () => {
    const l = mk();
    l.recordRateLimitEvent({ ts: 1000, kind: 'circuit-open', source: 'circuit-breaker', seq: 1 });
    l.recordRateLimitEvent({ ts: 3000, kind: 'circuit-open', source: 'circuit-breaker', seq: 2 });
    l.recordRateLimitEvent({ ts: 2000, kind: 'circuit-open', source: 'circuit-breaker', seq: 3 });
    const rows = l.rateLimitEvents({ sinceMs: 1500 });
    expect(rows.map(r => r.ts)).toEqual([3000, 2000]); // newest first, 1000 excluded
  });

  it('never throws on write after close (observability safety)', () => {
    const l = mk();
    l.close();
    expect(() => l.recordRateLimitEvent({ ts: 1, kind: 'circuit-open', source: 'circuit-breaker', seq: 1 })).not.toThrow();
  });
});
