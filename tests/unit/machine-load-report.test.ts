/**
 * machineLoadReport (trustworthy-machine-load-and-mesh-floor spec, Part B1–B2):
 * every verdict row on both sides, the receive clamp, freshness, and the sampler.
 */
import { describe, expect, it } from 'vitest';
import {
  clampLoadReport,
  deriveLoadVerdict,
  isLoadReportFresh,
  loadReportAgeMs,
  parseDarwinPressureLevel,
  parseLinuxPressureFile,
  MachineLoadSampler,
  LOAD_REPORT_MAX_AGE_MS,
  type LoadSample,
} from '../../src/core/machineLoadReport.js';

const ok = (over: Partial<LoadSample> = {}): LoadSample => ({
  atMs: 0,
  loadPerCore: 0.4,
  cpuIdlePct: 70,
  memAvailablePct: 50,
  memPressureNative: 'normal',
  eventLoopLagP99Ms: 20,
  sessionsActive: 2,
  sessionsMax: 10,
  ...over,
});
const three = (over: Partial<LoadSample>) => [ok(over), ok(over), ok(over)];
const live = { inGrace: false };

describe('deriveLoadVerdict (B2 table, top to bottom)', () => {
  it('fewer than 2 samples → unknown (one reading never decides); three healthy samples → ok', () => {
    expect(deriveLoadVerdict([], live)).toBe('unknown');
    expect(deriveLoadVerdict([ok({ memPressureNative: 'critical' })], live)).toBe('unknown');
    expect(deriveLoadVerdict([ok(), ok()], live)).toBe('ok');
    expect(deriveLoadVerdict(three({}), live)).toBe('ok');
  });

  it('impaired: lag p99 > 1000 ms, OR native critical, OR available memory < 5% — any one is enough', () => {
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 1001 }), live)).toBe('impaired');
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 1000 }), live)).not.toBe('impaired');
    expect(deriveLoadVerdict(three({ memPressureNative: 'critical' }), live)).toBe('impaired');
    expect(deriveLoadVerdict(three({ memAvailablePct: 4.9 }), live)).toBe('impaired');
    expect(deriveLoadVerdict(three({ memAvailablePct: 5 }), live)).not.toBe('impaired');
  });

  it('a known critical signal yields impaired even when other signals are missing', () => {
    expect(deriveLoadVerdict(three({ memPressureNative: 'critical', cpuIdlePct: null, loadPerCore: null }), live)).toBe('impaired');
  });

  it('saturated: sessions ≥ max − 1, or two pair signals; one pair signal is elevated', () => {
    expect(deriveLoadVerdict(three({ sessionsActive: 9, sessionsMax: 10 }), live)).toBe('saturated');
    expect(deriveLoadVerdict(three({ sessionsActive: 8, sessionsMax: 10 }), live)).toBe('ok');
    expect(deriveLoadVerdict(three({ cpuIdlePct: 9, loadPerCore: 1.6 }), live)).toBe('saturated');
    expect(deriveLoadVerdict(three({ cpuIdlePct: 9 }), live)).toBe('elevated');
    expect(deriveLoadVerdict(three({ loadPerCore: 1.5 }), live)).toBe('ok');
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 301, memPressureNative: 'warn' }), live)).toBe('saturated');
    expect(deriveLoadVerdict(three({ memAvailablePct: 14.9 }), live)).toBe('elevated');
  });

  it('a row needs 2 of the last 3 samples (a single flicker does not count)', () => {
    const flicker = [ok(), ok({ cpuIdlePct: 2, loadPerCore: 3 }), ok()];
    expect(deriveLoadVerdict(flicker, live)).toBe('ok');
    const twoOfThree = [ok({ cpuIdlePct: 2, loadPerCore: 3 }), ok(), ok({ cpuIdlePct: 2, loadPerCore: 3 })];
    expect(deriveLoadVerdict(twoOfThree, live)).toBe('saturated');
  });

  it('boot/wake grace suppresses impaired/saturated caused ONLY by lag, not by memory', () => {
    const grace = { inGrace: true };
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 5000 }), grace)).toBe('elevated');
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 400, cpuIdlePct: 5 }), grace)).toBe('elevated');
    expect(deriveLoadVerdict(three({ eventLoopLagP99Ms: 400, cpuIdlePct: 5 }), live)).toBe('saturated');
    expect(deriveLoadVerdict(three({ memPressureNative: 'critical' }), grace)).toBe('impaired');
  });

  it('unknown applies only when no row matched AND a CPU or memory signal is missing — never ok by default', () => {
    expect(deriveLoadVerdict(three({ cpuIdlePct: null, loadPerCore: null }), live)).toBe('unknown');
    expect(deriveLoadVerdict(three({ memAvailablePct: null, memPressureNative: null }), live)).toBe('unknown');
    expect(deriveLoadVerdict(three({ cpuIdlePct: null }), live)).toBe('ok'); // loadPerCore still present
  });
});

describe('clampLoadReport (receive clamp)', () => {
  const good = {
    bootId: 'b1', seq: 3, sampleAgeMs: 100, platform: 'darwin', cores: 8, totalMemBytes: 1e10,
    loadPerCore: 0.5, cpuIdlePct: 60, memAvailablePct: 40, memPressureNative: 'normal',
    eventLoopLagP99Ms: 12, sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false,
    testRunnerSaturated: null, verdict: 'ok', uptimeS: 500,
  };
  it('passes a clean report through intact', () => {
    expect(clampLoadReport(good)).toEqual(good);
  });
  it('rejects a block with no identity; turns malformed fields into null (never a substitute)', () => {
    expect(clampLoadReport({ ...good, bootId: '' })).toBeNull();
    expect(clampLoadReport({ ...good, sampleAgeMs: -1 })).toBeNull();
    expect(clampLoadReport('nope')).toBeNull();
    const dirty = clampLoadReport({ ...good, cpuIdlePct: 140, memPressureNative: 'melting', verdict: 'fine', platform: 'amiga', loadPerCore: 'high' });
    expect(dirty).toMatchObject({ cpuIdlePct: null, memPressureNative: null, verdict: 'unknown', platform: 'other', loadPerCore: null });
  });
});

describe('freshness (B1): fresh transport never renews stale load evidence', () => {
  const r = clampLoadReport({ bootId: 'b', seq: 0, sampleAgeMs: 10_000, verdict: 'ok' })!;
  it('age = sampleAge + time since receipt; past 60 s it is not fresh', () => {
    expect(loadReportAgeMs(r, 1000, 21_000)).toBe(30_000);
    expect(isLoadReportFresh(r, 1000, 1000 + LOAD_REPORT_MAX_AGE_MS - 10_000)).toBe(true);
    expect(isLoadReportFresh(r, 1000, 1000 + LOAD_REPORT_MAX_AGE_MS - 10_000 + 1)).toBe(false);
  });
});

describe('native pressure parsers', () => {
  it('darwin sysctl level 1/2/4 → normal/warn/critical; else null', () => {
    expect(parseDarwinPressureLevel('1\n')).toBe('normal');
    expect(parseDarwinPressureLevel('kern.memorystatus_vm_pressure_level: 2')).toBe('warn');
    expect(parseDarwinPressureLevel('4')).toBe('critical');
    expect(parseDarwinPressureLevel('')).toBeNull();
    expect(parseDarwinPressureLevel('3')).toBeNull();
  });
  it('linux /proc/pressure/memory: full avg10 ≥ 10 critical, some ≥ 10 warn, else normal; empty null', () => {
    expect(parseLinuxPressureFile('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBe('normal');
    expect(parseLinuxPressureFile('some avg10=12.50 avg60=1 avg300=0 total=1\nfull avg10=2.00 avg60=0 avg300=0 total=1\n')).toBe('warn');
    expect(parseLinuxPressureFile('some avg10=40 avg60=1 avg300=0 total=1\nfull avg10=15 avg60=0 avg300=0 total=1\n')).toBe('critical');
    expect(parseLinuxPressureFile('')).toBeNull();
  });
});

describe('MachineLoadSampler', () => {
  function makeSampler(over: Partial<ConstructorParameters<typeof MachineLoadSampler>[0]> = {}) {
    let mono = 0;
    let tick = 0;
    const cpus = () => {
      tick += 100;
      // 4 cores; idle grows 60 per 100 total → 60% idle.
      return [0, 1, 2, 3].map(() => ({ times: { user: tick * 0.3, nice: 0, sys: tick * 0.1, idle: tick * 0.6, irq: 0 } }));
    };
    const s = new MachineLoadSampler({
      platform: 'darwin',
      cpus,
      loadavg: () => [2, 2, 2],
      totalmem: () => 64e9,
      readMemAvailablePct: async () => 55,
      readNativePressure: async () => 'normal',
      eventLoopLagP99Ms: () => 15,
      sessions: () => ({ active: 3, max: 10 }),
      spawnCapSaturated: () => false,
      testRunnerSaturated: () => false,
      now: () => 1_000_000,
      monoNow: () => mono,
      bootId: 'boot-1',
      ...over,
    });
    return { s, advance: (ms: number) => { mono += ms; } };
  }

  it('read() is null before the first sample; the first sample has no CPU idle (needs a delta)', async () => {
    const { s } = makeSampler();
    expect(s.read()).toBeNull();
    await s.sampleOnce();
    const r = s.read()!;
    expect(r).toMatchObject({ bootId: 'boot-1', seq: 0, cores: 4, loadPerCore: 0.5, cpuIdlePct: null, memAvailablePct: 55, memPressureNative: 'normal', eventLoopLagP99Ms: 15, sessionsActive: 3, sessionsMax: 10, platform: 'darwin' });
    await s.sampleOnce();
    expect(s.read()!.cpuIdlePct).toBeCloseTo(60, 5);
    expect(s.read()!.seq).toBe(1);
  });

  it('sampleAgeMs grows with the monotonic clock without re-sampling; the verdict is the table output', async () => {
    const { s, advance } = makeSampler();
    await s.sampleOnce();
    advance(12_000);
    const r = s.read()!;
    expect(r.sampleAgeMs).toBe(12_000);
    expect(r.uptimeS).toBe(12);
    expect(r.seq).toBe(0);
    expect(r.verdict).toBe('unknown'); // one sample never decides (B2)
  });

  it('a failed signal read is reported as MISSING (null), never a substituted value', async () => {
    const { s } = makeSampler({
      readMemAvailablePct: async () => { throw new Error('vm_stat exploded'); },
      readNativePressure: async () => { throw new Error('no sysctl'); },
      eventLoopLagP99Ms: () => { throw new Error('gauge gone'); },
    });
    await s.sampleOnce();
    const r = s.read()!;
    expect(r.memAvailablePct).toBeNull();
    expect(r.memPressureNative).toBeNull();
    expect(r.eventLoopLagP99Ms).toBeNull();
    expect(r.verdict).toBe('unknown'); // memory missing → never ok
  });

  it('noteWake re-arms the grace so lag alone cannot read impaired right after a wake', async () => {
    const { s, advance } = makeSampler({ eventLoopLagP99Ms: () => 5000 });
    advance(10 * 60_000); // well past boot grace
    s.noteWake();
    for (let i = 0; i < 3; i++) await s.sampleOnce();
    expect(s.verdict()).toBe('elevated');
    advance(3 * 60_000); // grace over
    for (let i = 0; i < 3; i++) await s.sampleOnce();
    expect(s.verdict()).toBe('impaired');
  });
});
