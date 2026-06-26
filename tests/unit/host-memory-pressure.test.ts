/**
 * macOS memory-pressure metric fix. Spec: macos-memory-pressure-metric.
 *
 * THE BUG: os.freemem() on macOS returns only "Pages free" (~0.1%), so the
 * reaper/resume-queue read a healthy machine as memory-CRITICAL, over-reaping
 * sessions and permanently blocking revival. The fix reads REAL available memory
 * (free + inactive + purgeable on macOS via vm_stat). These tests pin that a
 * machine with tiny free pages but ample reclaimable memory reads as HEALTHY.
 */
import { describe, it, expect } from 'vitest';
import { parseVmStat, parseProcMeminfo, readSystemMemoryPressure, hostFreeMemPct } from '../../src/monitoring/hostMemoryPressure.js';

// A realistic macOS vm_stat: almost no "Pages free", but lots of reclaimable
// inactive + purgeable — the exact shape that broke os.freemem.
const VM_STAT_HEALTHY_LOW_FREE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                           2000000.
Pages inactive:                         1500000.
Pages wired down:                        500000.
Pages purgeable:                         800000.
Pages occupied by compressor:            300000.
`;

describe('parseVmStat — available = free + inactive + purgeable (not raw free pages)', () => {
  it('a machine with TINY free pages but ample reclaimable reads as HEALTHY (the bug case)', () => {
    const r = parseVmStat(VM_STAT_HEALTHY_LOW_FREE);
    // total = 10000+2000000+1500000+500000+300000 = 4,310,000
    // available = 10000+1500000+800000 = 2,310,000 → ~53.6% available
    const freePct = 100 - r.pressurePercent;
    expect(freePct).toBeGreaterThan(40); // NOT the ~0.2% os.freemem would report
    expect(r.totalGB).toBeGreaterThan(0);
    expect(r.freeGB).toBeGreaterThan(0);
  });
  it('a genuinely critical machine reads low available', () => {
    const critical = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                           4000000.
Pages inactive:                           50000.
Pages wired down:                       1000000.
Pages purgeable:                          10000.
Pages occupied by compressor:            500000.
`;
    const freePct = 100 - parseVmStat(critical).pressurePercent;
    expect(freePct).toBeLessThan(5); // genuinely critical → low available
  });
  it('empty/garbage output does not throw and yields a finite reading', () => {
    const r = parseVmStat('');
    expect(Number.isFinite(r.pressurePercent)).toBe(true);
  });
});

describe('parseProcMeminfo — uses MemAvailable (Linux)', () => {
  it('reads MemAvailable as the free figure', () => {
    const content = `MemTotal:       16000000 kB
MemFree:          200000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
Cached:          5000000 kB
`;
    const r = parseProcMeminfo(content);
    expect(100 - r.pressurePercent).toBeCloseTo(50, 0); // 8M/16M available
  });
  it('falls back to MemFree+Buffers+Cached when MemAvailable is absent', () => {
    const content = `MemTotal:       16000000 kB
MemFree:         1000000 kB
Buffers:          500000 kB
Cached:          2500000 kB
`;
    const r = parseProcMeminfo(content);
    expect(100 - r.pressurePercent).toBeCloseTo(25, 0); // (1M+0.5M+2.5M)/16M
  });
});

describe('readSystemMemoryPressure — platform-aware, never throws', () => {
  it('darwin: uses injected vm_stat', () => {
    const r = readSystemMemoryPressure({ platform: 'darwin', vmStat: () => VM_STAT_HEALTHY_LOW_FREE });
    expect(100 - r.pressurePercent).toBeGreaterThan(40);
  });
  it('linux: uses injected proc-meminfo', () => {
    const r = readSystemMemoryPressure({ platform: 'linux', procMeminfo: () => 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\n' });
    expect(100 - r.pressurePercent).toBeCloseTo(50, 0);
  });
  it('a thrown reader falls back to the RSS estimate (never throws)', () => {
    const r = readSystemMemoryPressure({
      platform: 'darwin',
      vmStat: () => { throw new Error('vm_stat missing'); },
      memoryUsage: () => ({ rss: 4 * 1024 ** 3 }),
      totalmem: () => 16 * 1024 ** 3,
    });
    expect(Number.isFinite(r.pressurePercent)).toBe(true);
    expect(r.pressurePercent).toBeCloseTo(25, 0); // 4GB rss / 16GB
  });
  it('an unknown platform uses the fallback', () => {
    const r = readSystemMemoryPressure({ platform: 'sunos', memoryUsage: () => ({ rss: 2 * 1024 ** 3 }), totalmem: () => 8 * 1024 ** 3 });
    expect(r.pressurePercent).toBeCloseTo(25, 0);
  });
});

describe('hostFreeMemPct — the corrected os.freemem replacement', () => {
  it('returns the available% (clamped 0-100)', () => {
    const pct = hostFreeMemPct({ platform: 'darwin', vmStat: () => VM_STAT_HEALTHY_LOW_FREE });
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThanOrEqual(100);
  });
  it('never returns < 0 or > 100', () => {
    const pct = hostFreeMemPct({ platform: 'linux', procMeminfo: () => 'MemTotal: 100 kB\nMemAvailable: 999999 kB\n' });
    expect(pct).toBeLessThanOrEqual(100);
    expect(pct).toBeGreaterThanOrEqual(0);
  });
});

// ── REAL captured fixtures (Scrape/Parser Fixture Realness standard — the code=t
// lesson): the parsers must be fed the REAL bytes, not only hand-written shapes. ──
import fs from 'node:fs';
import path from 'node:path';

describe('parsers against REAL captured OS output', () => {
  const fixDir = path.join(__dirname, '..', 'fixtures', 'memory');

  it('REAL macOS vm_stat: tiny raw free pages but correct available% reads HEALTHY (the live bug shape)', () => {
    const real = fs.readFileSync(path.join(fixDir, 'vm_stat-real-darwin.txt'), 'utf-8');
    const r = parseVmStat(real);
    const freePct = 100 - r.pressurePercent;
    // The real machine's RAW free pages are ~0.4% (what os.freemem saw → false critical);
    // the CORRECT available% (free+inactive+purgeable) is materially higher.
    expect(freePct).toBeGreaterThan(MEM_MODERATE_FLOOR); // not the false-critical os.freemem reading
    expect(r.totalGB).toBeGreaterThan(8);                // a real machine has real total
    expect(Number.isFinite(r.freeGB)).toBe(true);
  });

  it('REAL-shape /proc/meminfo: uses MemAvailable', () => {
    const real = fs.readFileSync(path.join(fixDir, 'proc-meminfo-real-linux.txt'), 'utf-8');
    const r = parseProcMeminfo(real);
    const freePct = 100 - r.pressurePercent;
    // MemAvailable 18345678 / MemTotal 32814904 ≈ 55.9%
    expect(freePct).toBeGreaterThan(50);
    expect(freePct).toBeLessThan(60);
  });
});

const MEM_MODERATE_FLOOR = 5; // above the 5% critical threshold — the corrected metric clears it
