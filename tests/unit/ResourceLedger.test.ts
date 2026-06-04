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

describe('ResourceLedger — CPU/memory samples (Phase B)', () => {
  let ledger: ResourceLedger | null = null;
  afterEach(() => { ledger?.close(); ledger = null; });
  const mk = () => { ledger = new ResourceLedger({ dbPath: ':memory:' }); return ledger; };

  it('records a sample and counts it', () => {
    const l = mk();
    l.record({ ts: 1000, source: 'agent-server', pid: 42, cpuPercent: 12.5, rssBytes: 100 * 1024 * 1024, heapUsedBytes: 40 * 1024 * 1024 });
    expect(l.sampleCount()).toBe(1);
  });

  it('summary reports current (latest), avg, and peak per source', () => {
    const l = mk();
    const now = 1_000_000;
    // agent-server: three samples in window → current is the newest (ts highest).
    l.record({ ts: now - 200, source: 'agent-server', pid: 1, cpuPercent: 10, rssBytes: 100, heapUsedBytes: 50 });
    l.record({ ts: now - 100, source: 'agent-server', pid: 1, cpuPercent: 30, rssBytes: 200, heapUsedBytes: 60 });
    l.record({ ts: now - 50,  source: 'agent-server', pid: 1, cpuPercent: 20, rssBytes: 150, heapUsedBytes: 55 });
    const rows = l.summary(now - 1000);
    const srv = rows.find(r => r.source === 'agent-server')!;
    expect(srv.currentCpuPercent).toBe(20);   // newest sample
    expect(srv.currentRssBytes).toBe(150);
    expect(srv.currentHeapUsedBytes).toBe(55);
    expect(srv.avgCpuPercent).toBe(20);        // (10+30+20)/3
    expect(srv.peakCpuPercent).toBe(30);
    expect(srv.peakRssBytes).toBe(200);
    expect(srv.sampleCount).toBe(3);
  });

  it('summary separates each source (server / session / aggregate)', () => {
    const l = mk();
    const now = 500_000;
    l.record({ ts: now, source: 'agent-server', pid: 1, cpuPercent: 5, rssBytes: 100 });
    l.record({ ts: now, source: 'session:abc', pid: 2, cpuPercent: 25, rssBytes: 300 });
    l.record({ ts: now, source: 'aggregate', pid: 0, cpuPercent: 30, rssBytes: 400 });
    const rows = l.summary(now - 1000);
    expect(rows.map(r => r.source).sort()).toEqual(['agent-server', 'aggregate', 'session:abc']);
    expect(rows.find(r => r.source === 'session:abc')!.currentCpuPercent).toBe(25);
    // session sources never carry heapUsed
    expect(rows.find(r => r.source === 'session:abc')!.currentHeapUsedBytes).toBeNull();
  });

  it('recentSamples returns newest first, honors window + source filter + limit', () => {
    const l = mk();
    l.record({ ts: 1000, source: 'aggregate', pid: 0, cpuPercent: 1, rssBytes: 10 });
    l.record({ ts: 3000, source: 'aggregate', pid: 0, cpuPercent: 3, rssBytes: 30 });
    l.record({ ts: 2000, source: 'agent-server', pid: 1, cpuPercent: 2, rssBytes: 20 });
    const agg = l.recentSamples({ sinceMs: 1500, source: 'aggregate' });
    expect(agg.map(r => r.ts)).toEqual([3000]); // only aggregate ≥ 1500
    const all = l.recentSamples({ sinceMs: 0, limit: 2 });
    expect(all.length).toBe(2);
    expect(all[0].ts).toBe(3000); // newest first
  });

  it('pruneOlderThan deletes only rows older than the cutoff', () => {
    const l = mk();
    l.record({ ts: 1000, source: 'aggregate', pid: 0, cpuPercent: 1, rssBytes: 10 });
    l.record({ ts: 5000, source: 'aggregate', pid: 0, cpuPercent: 5, rssBytes: 50 });
    const deleted = l.pruneOlderThan(3000);
    expect(deleted).toBe(1);
    expect(l.sampleCount()).toBe(1);
    expect(l.recentSamples({ sinceMs: 0 })[0].ts).toBe(5000);
  });

  it('clamps negative/NaN readings so a bad sample cannot poison aggregates', () => {
    const l = mk();
    l.record({ ts: 1000, source: 'agent-server', pid: 1, cpuPercent: -5, rssBytes: -10, heapUsedBytes: NaN });
    const row = l.recentSamples({ sinceMs: 0 })[0];
    expect(row.cpuPercent).toBe(0);
    expect(row.rssBytes).toBe(0);
    expect(row.heapUsedBytes).toBe(0);
  });

  it('record/prune never throw after close (observability safety)', () => {
    const l = mk();
    l.close();
    expect(() => l.record({ ts: 1, source: 'agent-server', pid: 1, cpuPercent: 1, rssBytes: 1 })).not.toThrow();
    expect(() => l.pruneOlderThan(0)).not.toThrow();
    expect(l.pruneOlderThan(0)).toBe(0);
  });

  it('recordSamples writes a batch in one transaction', () => {
    const l = mk();
    l.recordSamples([
      { ts: 1, source: 'agent-server', pid: 1, cpuPercent: 1, rssBytes: 10 },
      { ts: 1, source: 'session:x', pid: 2, cpuPercent: 2, rssBytes: 20 },
      { ts: 1, source: 'aggregate', pid: 0, cpuPercent: 3, rssBytes: 30 },
    ]);
    expect(l.sampleCount()).toBe(3);
  });
});
