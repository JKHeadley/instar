import { describe, it, expect, afterEach } from 'vitest';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';
import { ResourceSampler } from '../../src/monitoring/ResourceSampler.js';

/** A real (in-memory) ledger so we exercise the actual write path, plus fully
 *  injected OS seams so the test is deterministic and never forks `ps`. */
function harness(opts: {
  cpuSamples?: NodeJS.CpuUsage[];
  memSamples?: NodeJS.MemoryUsage[];
  nows?: number[];
  sessionPids?: () => Array<{ id: string; pid: number }>;
  samplePidsFn?: (pids: number[]) => Promise<Map<number, { cpuPercent: number; rssBytes: number }>>;
  intervalMs?: number;
  idleIntervalMs?: number;
}) {
  const ledger = new ResourceLedger({ dbPath: ':memory:' });
  let cpuIdx = 0;
  let memIdx = 0;
  let nowIdx = 0;
  const cpuDefaults: NodeJS.CpuUsage = { user: 0, system: 0 };
  const memDefaults = { rss: 50 * 1024 * 1024, heapUsed: 20 * 1024 * 1024, heapTotal: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage;
  const sampler = new ResourceSampler({
    ledger,
    getSessionPids: opts.sessionPids ?? (() => []),
    intervalMs: opts.intervalMs ?? 60_000,
    idleIntervalMs: opts.idleIntervalMs ?? 300_000,
    cpuUsageFn: () => opts.cpuSamples ? (opts.cpuSamples[Math.min(cpuIdx++, opts.cpuSamples.length - 1)]) : cpuDefaults,
    memoryUsageFn: () => opts.memSamples ? (opts.memSamples[Math.min(memIdx++, opts.memSamples.length - 1)]) : memDefaults,
    now: () => opts.nows ? (opts.nows[Math.min(nowIdx++, opts.nows.length - 1)]) : Date.now(),
    samplePidsFn: opts.samplePidsFn ?? (async () => new Map()),
  });
  return { ledger, sampler };
}

describe('ResourceSampler — CPU/memory sampling (Phase B)', () => {
  let ledger: ResourceLedger | null = null;
  let sampler: ResourceSampler | null = null;
  afterEach(() => { sampler?.stop(); ledger?.close(); ledger = null; sampler = null; });

  it('computes own-process CPU% from the cpuUsage delta over wall time', async () => {
    // start() primes baseline at now=1000 with cpu=0. The first tick is at
    // now=2000 (1s wall) consuming 500_000µs CPU → 50% of one core.
    const h = harness({
      cpuSamples: [
        { user: 0, system: 0 },           // start() baseline
        { user: 300_000, system: 200_000 }, // tick: +500_000µs over 1000ms wall
      ],
      nows: [1000, 2000, 2000, 2000],
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();        // primes baseline (cpu#0 @ now#0=1000)
    await sampler.tick();   // tick uses cpu#1 @ now#1=2000
    const srv = ledger.summary(0).find(r => r.source === 'agent-server')!;
    // 500_000µs / (1000ms*1000) * 100 = 50%
    expect(srv.currentCpuPercent).toBe(50);
  });

  it('returns 0% own CPU on the first tick when no baseline exists yet', async () => {
    const h = harness({
      cpuSamples: [{ user: 999, system: 999 }],
      nows: [5000, 5000],
    });
    ledger = h.ledger; sampler = h.sampler;
    // Call tick() WITHOUT start() → no primed baseline → 0%.
    await sampler.tick();
    const srv = ledger.summary(0).find(r => r.source === 'agent-server')!;
    expect(srv.currentCpuPercent).toBe(0);
  });

  it('samples session PIDs via the injected pid sampler and records per-session rows', async () => {
    const h = harness({
      sessionPids: () => [{ id: 'sess-a', pid: 111 }, { id: 'sess-b', pid: 222 }],
      samplePidsFn: async (pids) => {
        expect(pids.sort()).toEqual([111, 222]); // batched in one call
        return new Map([
          [111, { cpuPercent: 15, rssBytes: 100 * 1024 * 1024 }],
          [222, { cpuPercent: 25, rssBytes: 200 * 1024 * 1024 }],
        ]);
      },
      nows: [0, 0, 0, 0],
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();
    await sampler.tick();
    const rows = ledger.summary(0);
    expect(rows.find(r => r.source === 'session:sess-a')!.currentCpuPercent).toBe(15);
    expect(rows.find(r => r.source === 'session:sess-b')!.currentCpuPercent).toBe(25);
  });

  it('computes an aggregate = server + all sampled sessions', async () => {
    const h = harness({
      cpuSamples: [{ user: 0, system: 0 }, { user: 100_000, system: 0 }], // 10% over 1s
      nows: [0, 1000, 1000, 1000, 1000],
      sessionPids: () => [{ id: 's1', pid: 7 }],
      samplePidsFn: async () => new Map([[7, { cpuPercent: 40, rssBytes: 10 }]]),
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();
    await sampler.tick();
    const agg = ledger.summary(0).find(r => r.source === 'aggregate')!;
    // server 10% + session 40% = 50%
    expect(agg.currentCpuPercent).toBe(50);
  });

  it('tolerates a dead PID — absent from the ps map → that session is skipped, not crashed', async () => {
    const h = harness({
      sessionPids: () => [{ id: 'alive', pid: 1 }, { id: 'dead', pid: 999999 }],
      samplePidsFn: async () => new Map([[1, { cpuPercent: 5, rssBytes: 10 }]]), // 999999 absent
      nows: [0, 0, 0, 0],
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();
    await sampler.tick();
    const rows = ledger.summary(0);
    expect(rows.find(r => r.source === 'session:alive')).toBeTruthy();
    expect(rows.find(r => r.source === 'session:dead')).toBeUndefined(); // dead pid skipped
  });

  it('is fail-open — a throwing pid sampler never crashes the tick', async () => {
    const h = harness({
      sessionPids: () => [{ id: 's', pid: 5 }],
      samplePidsFn: async () => { throw new Error('ps blew up'); },
      nows: [0, 0, 0, 0],
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();
    await expect(sampler.tick()).resolves.toBeUndefined();
    // server + aggregate still recorded even though session sampling failed
    expect(ledger.summary(0).find(r => r.source === 'agent-server')).toBeTruthy();
  });

  it('is fail-open — a throwing getSessionPids never crashes the tick', async () => {
    const h = harness({
      sessionPids: () => { throw new Error('session enum blew up'); },
      nows: [0, 0, 0, 0],
    });
    ledger = h.ledger; sampler = h.sampler;
    sampler.start();
    await expect(sampler.tick()).resolves.toBeUndefined();
    expect(ledger.summary(0).find(r => r.source === 'agent-server')).toBeTruthy();
  });

  it('prunes beyond the retention window each tick', async () => {
    const h = harness({ nows: [0, 10_000_000, 10_000_000, 10_000_000] });
    ledger = h.ledger; sampler = h.sampler;
    // Seed an ancient sample directly.
    ledger.record({ ts: 0, source: 'aggregate', pid: 0, cpuPercent: 1, rssBytes: 1 });
    // retentionMs default is 7d; with now=10_000_000 (~2.8h) the seed at ts=0 is
    // NOT older than now-7d (negative), so use an explicit small retention.
    const ledger2 = new ResourceLedger({ dbPath: ':memory:' });
    ledger.close();
    ledger = ledger2;
    sampler.stop();
    sampler = new ResourceSampler({
      ledger: ledger2,
      getSessionPids: () => [],
      retentionMs: 1000, // 1s retention
      now: () => 10_000, // current
      memoryUsageFn: () => ({ rss: 1, heapUsed: 1, heapTotal: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      cpuUsageFn: () => ({ user: 0, system: 0 }),
    });
    ledger2.record({ ts: 100, source: 'aggregate', pid: 0, cpuPercent: 1, rssBytes: 1 }); // ancient (< 10_000-1000)
    sampler.start();
    await sampler.tick();
    // The ancient ts=100 row is pruned; only this tick's fresh rows (ts=10_000) remain.
    expect(ledger2.recentSamples({ sinceMs: 0 }).every(r => r.ts >= 9000)).toBe(true);
  });
});
