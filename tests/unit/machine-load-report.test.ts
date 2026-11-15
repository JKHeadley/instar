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
import {
  isMemoryPressured,
  memoryPressureReason,
  parseDarwinSwapUsage,
  parseDarwinSwapouts,
  parseLinuxSwapUsed,
  parseLinuxSwapouts,
  swapPressure,
  LOAD_THRESHOLDS,
} from '../../src/core/machineLoadReport.js';
import { peerMemoryReason } from '../../src/core/machineResourceProfile.js';
import type { MachineCapacity } from '../../src/core/types.js';

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
      // Deterministic: never the test machine's real swap (a swapping CI host would flip verdicts).
      readSwap: async () => null,
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

describe('clampLoadReport — admission fields (P2)', () => {
  const base = { bootId: 'b1', seq: 1, sampleAgeMs: 0 };
  it('absent on the wire → absent after the clamp (a peer on older code is never read as refusing)', () => {
    const r = clampLoadReport(base)!;
    expect('acceptingWork' in r).toBe(false);
    expect('admissionEnforced' in r).toBe(false);
  });
  it('present → boolean/null, and admissionEnforced is true ONLY for literal true', () => {
    expect(clampLoadReport({ ...base, acceptingWork: false, admissionEnforced: true })).toMatchObject({ acceptingWork: false, admissionEnforced: true });
    expect(clampLoadReport({ ...base, acceptingWork: 'no', admissionEnforced: 'yes' })).toMatchObject({ acceptingWork: null, admissionEnforced: false });
  });
});

// ── Machine memory care (docs/specs/machine-memory-care.md §1): swap counts ────

describe('swap parsers', () => {
  it('macOS vm.swapusage and vm_stat Swapouts', () => {
    expect(parseDarwinSwapUsage('total = 18432.00M  used = 17408.00M  free = 1024.00M  (encrypted)')).toBe(17408 * 1024 ** 2);
    expect(parseDarwinSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toBe(0);
    expect(parseDarwinSwapUsage('total = 2.00G  used = 1.50G  free = 0.50G')).toBe(1.5 * 1024 ** 3);
    expect(parseDarwinSwapUsage('nonsense')).toBeNull();
    expect(parseDarwinSwapouts('Pages free: 1.\nSwapins:                    1234.\nSwapouts:                  5678.\n')).toBe(5678);
    expect(parseDarwinSwapouts('Pages free: 1.')).toBeNull();
  });
  it('Linux /proc/meminfo swap and /proc/vmstat pswpout', () => {
    expect(parseLinuxSwapUsed('MemTotal: 100 kB\nSwapTotal:     8388604 kB\nSwapFree:      4194302 kB\n')).toBe(4194302 * 1024);
    expect(parseLinuxSwapUsed('MemTotal: 100 kB\n')).toBeNull();
    expect(parseLinuxSwapouts('pswpin 10\npswpout 42\n')).toBe(42);
    expect(parseLinuxSwapouts('nr_free_pages 1\n')).toBeNull();
  });
});

describe('swap in the verdict', () => {
  it('the M5 of 2026-11-14 (swap a third of memory, still paging out) is impaired even with "free" memory looking fine', () => {
    expect(deriveLoadVerdict(three({ memAvailablePct: 50, swapUsedPctOfRam: 35, swapActive: true }), live)).toBe('impaired');
    expect(isMemoryPressured(three({ memAvailablePct: 50, swapUsedPctOfRam: 35, swapActive: true }))).toBe(true);
  });
  it('swap above 10% of memory with live evidence is a memory signal (elevated alone, saturated with CPU)', () => {
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 12, swapActive: true }), live)).toBe('elevated');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 12, memAvailablePct: 14 }), live)).toBe('elevated');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 12, swapActive: true, cpuIdlePct: 5 }), live)).toBe('saturated');
  });
  it('swap left over from earlier on a machine that is not paging is not pressure — even at the ~25% "available" a healthy Mac reads', () => {
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 40, swapActive: false, memAvailablePct: 60 }), live)).toBe('ok');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 40, swapActive: false, memAvailablePct: 25 }), live)).toBe('ok');
    expect(isMemoryPressured(three({ swapUsedPctOfRam: 40, swapActive: false, memAvailablePct: 25 }))).toBe(false);
  });
  it('impaired by swap needs a quarter of memory in swap AND sustained paging', () => {
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 30, swapActive: false, memAvailablePct: 14 }), live)).toBe('elevated');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 24, swapActive: true }), live)).toBe('elevated');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 25, swapActive: true }), live)).toBe('impaired');
  });
  it('below the threshold, or unknown swap, changes nothing (older peers read as before)', () => {
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: 9.9, swapActive: true }), live)).toBe('ok');
    expect(deriveLoadVerdict(three({ swapUsedPctOfRam: null, swapActive: null }), live)).toBe('ok');
    expect(deriveLoadVerdict(three({}), live)).toBe('ok');
    expect(swapPressure({ swapUsedPctOfRam: LOAD_THRESHOLDS.elevatedSwapPctOfRam, swapActive: true, memAvailablePct: 60, memPressureNative: 'normal' }, LOAD_THRESHOLDS.elevatedSwapPctOfRam)).toBe(true);
  });
  it('memory-pressured needs 2 of the last 3 samples and only the memory row (CPU never counts)', () => {
    expect(isMemoryPressured([ok({ swapUsedPctOfRam: 30, swapActive: true })])).toBe(false);
    expect(isMemoryPressured([ok(), ok({ memAvailablePct: 10 }), ok({ memAvailablePct: 10 })])).toBe(true);
    expect(isMemoryPressured([ok({ memAvailablePct: 10 }), ok(), ok()])).toBe(false);
    expect(isMemoryPressured(three({ cpuIdlePct: 1, loadPerCore: 9 }))).toBe(false);
  });
});

describe('memoryPressureReason (plain words for the notice)', () => {
  const base = { memAvailablePct: 50, memPressureNative: 'normal' as const, totalMemBytes: 48 * 1024 ** 3 };
  it('names the swap, its share of memory and whether it is still paging', () => {
    expect(memoryPressureReason({ ...base, swapUsedBytes: 17 * 1024 ** 3, swapActive: true })).toBe('17.0 GB of swap in use (35% of its memory), still paging out');
    expect(memoryPressureReason({ ...base, memAvailablePct: 4, swapUsedBytes: 0, swapActive: false })).toBe('only 4% of memory available');
    expect(memoryPressureReason({ ...base, memPressureNative: 'critical', swapUsedBytes: null })).toBe('the operating system reports critical memory pressure');
    expect(memoryPressureReason({ ...base, swapUsedBytes: 20 * 1024 ** 3, swapActive: false })).toBeNull();
    expect(memoryPressureReason(null)).toBeNull();
  });
});

describe('the report carries swap and memoryPressured', () => {
  it('the sampler reads swap, marks paging from a sustained swap-out RATE, and flags memory pressure by quorum', async () => {
    let outs = 100;
    let now = 1_000_000;
    const s = new MachineLoadSampler({
      platform: 'darwin', cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }], loadavg: () => [0.1, 0.1, 0.1],
      totalmem: () => 48 * 1024 ** 3, readMemAvailablePct: async () => 50, readNativePressure: async () => 'normal',
      // 120 MB per sample; now() advances 15 s per call (about 30 s per sample) ≈ 4 MB/s, well above 1 MB/s.
      readSwap: async () => ({ usedBytes: 17 * 1024 ** 3, swapoutBytes: (outs += 120 * 1024 ** 2) }),
      now: () => (now += 15_000), monoNow: () => 10 * 60_000, bootId: 'b',
    });
    await s.sampleOnce();
    expect(s.read()).toMatchObject({ swapUsedBytes: 17 * 1024 ** 3, swapActive: null, memoryPressured: false });
    expect(s.memoryPressure()).toBeNull();
    await s.sampleOnce();
    await s.sampleOnce();
    expect(s.read()).toMatchObject({ swapActive: true, memoryPressured: true, verdict: 'impaired' });
    expect(s.memoryPressure()).toContain('17.0 GB of swap');
  });
  it('an unreadable swap reader reports swap as missing, never zero', async () => {
    const s = new MachineLoadSampler({ platform: 'darwin', readSwap: async () => { throw new Error('no sysctl'); }, readMemAvailablePct: async () => 50, readNativePressure: async () => 'normal', bootId: 'b' });
    await s.sampleOnce();
    expect(s.read()).toMatchObject({ swapUsedBytes: null, swapActive: null });
  });
  it('the receive clamp keeps valid swap fields, nulls bad ones, and leaves an older report byte-identical', () => {
    const good = { bootId: 'b1', seq: 1, sampleAgeMs: 1, platform: 'darwin', cores: 8, totalMemBytes: 1e10, loadPerCore: 0.5, cpuIdlePct: 60, memAvailablePct: 40, memPressureNative: 'normal', eventLoopLagP99Ms: 12, sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: null, verdict: 'ok', uptimeS: 5 };
    expect(clampLoadReport(good)).toEqual(good);
    expect(clampLoadReport({ ...good, swapUsedBytes: 5e9, swapActive: true, memoryPressured: true })).toMatchObject({ swapUsedBytes: 5e9, swapActive: true, memoryPressured: true });
    expect(clampLoadReport({ ...good, swapUsedBytes: -1, swapActive: 'yes', memoryPressured: 'yes' })).toMatchObject({ swapUsedBytes: null, swapActive: null, memoryPressured: false });
  });
});

describe('peerMemoryReason (the coordinator\'s view of a peer)', () => {
  const cap = (over: Partial<MachineCapacity>, report: Record<string, unknown> | null): MachineCapacity => ({
    machineId: 'm5', online: true, loadReportAgeMs: 5_000,
    ...(report ? { loadReport: { bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: 18, totalMemBytes: 48 * 1024 ** 3, loadPerCore: 0.2, cpuIdlePct: 80, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 5, sessionsActive: 0, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'elevated', uptimeS: 100, ...report } } : {}),
    ...over,
  } as unknown as MachineCapacity);
  it('a fresh report flagged memoryPressured takes the peer out, with the reason', () => {
    expect(peerMemoryReason(cap({}, { memoryPressured: true, swapUsedBytes: 12 * 1024 ** 3, swapActive: true }))).toBe('12.0 GB of swap in use (25% of its memory), still paging out');
  });
  it('not flagged, stale, absent, or from older code: no memory reason (the existing fit decides)', () => {
    expect(peerMemoryReason(cap({}, { memoryPressured: false }))).toBeNull();
    expect(peerMemoryReason(cap({ loadReportAgeMs: LOAD_REPORT_MAX_AGE_MS + 1 }, { memoryPressured: true }))).toBeNull();
    expect(peerMemoryReason(cap({}, null))).toBeNull();
    expect(peerMemoryReason(cap({}, {}))).toBeNull();
  });
});

describe('swap-out rate', () => {
  it('a trickle below 1 MB/s is not "paging"; a counter reset is unknown, never active', async () => {
    let bytes = 0;
    let now = 0;
    const step: number[] = [100 * 1024, 100 * 1024, -1];
    let i = 0;
    const s = new MachineLoadSampler({
      platform: 'darwin', readMemAvailablePct: async () => 50, readNativePressure: async () => 'normal', totalmem: () => 48 * 1024 ** 3,
      readSwap: async () => { const d = i === 0 ? 0 : step[i - 1]; i++; bytes = d < 0 ? 0 : bytes + d; return { usedBytes: 12 * 1024 ** 3, swapoutBytes: bytes }; },
      now: () => (now += 15_000), bootId: 'b',
    });
    await s.sampleOnce();
    await s.sampleOnce();
    expect(s.read()!.swapActive).toBe(false);
    await s.sampleOnce();
    expect(s.read()!.swapActive).toBe(false);
    await s.sampleOnce(); // counter went backwards (restart of the counter): unknown
    expect(s.read()!.swapActive).toBeNull();
  });
});
