/**
 * Unit tests for machineResourceProfile (docs/specs/resource-aware-placement.md §1).
 * Both sides of every boundary: size floor, override, unknown size, fresh vs stale
 * load, headroom line, pending heavy work, and the signal-only command classifier.
 */
import { describe, it, expect } from 'vitest';
import {
  profileOf, freshLoadPerCore, placementLoad, heavyHeadroom, heavyFit, effectivePending,
  inferWorkWeight, PendingHeavyWork, HEAVY_WORK_FLOOR, LOAD_REFERENCE_CORES, PENDING_HEAVY_TTL_MS,
} from '../../src/core/machineResourceProfile.js';
import type { MachineCapacity } from '../../src/core/types.js';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-07T03:00:00.000Z');

function row(over: Partial<MachineCapacity> & { cores?: number | null; memGiB?: number | null; lpc?: number | null; reportAgeMs?: number } = {}): MachineCapacity {
  const { cores = 16, memGiB = 64, lpc, reportAgeMs = 10_000, ...rest } = over;
  return {
    machineId: 'm_x',
    online: true,
    clockSkewStatus: 'ok',
    routerReceivedAt: new Date(NOW - 5_000).toISOString(),
    loadReport: {
      bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin',
      cores, totalMemBytes: memGiB === null ? null : memGiB * GIB,
      loadPerCore: lpc ?? null, cpuIdlePct: 50, memAvailablePct: 50, memPressureNative: 'normal',
      eventLoopLagP99Ms: 5, sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false,
      testRunnerSaturated: false, verdict: 'ok', uptimeS: 1000,
    },
    loadReportAgeMs: reportAgeMs,
    loadVerdict: 'ok',
    ...rest,
  } as MachineCapacity;
}

describe('profileOf — size floor and override', () => {
  it('a 16-core / 64 GB machine is heavy-capable (meets-floor)', () => {
    const p = profileOf(row());
    expect(p).toMatchObject({ heavyCapable: true, reason: 'meets-floor', cores: 16, memGiB: 64, source: 'load-report' });
  });
  it('the 10-core / 16 GB Mini is not (below-floor)', () => {
    expect(profileOf(row({ cores: 10, memGiB: 16 }))).toMatchObject({ heavyCapable: false, reason: 'below-floor' });
  });
  it('boundary: exactly 12 cores and 32 GiB qualifies; 11 cores or 31 GiB does not', () => {
    expect(profileOf(row({ cores: HEAVY_WORK_FLOOR.minCores, memGiB: HEAVY_WORK_FLOOR.minMemGiB })).heavyCapable).toBe(true);
    expect(profileOf(row({ cores: 11, memGiB: 64 })).heavyCapable).toBe(false);
    expect(profileOf(row({ cores: 16, memGiB: 31 })).heavyCapable).toBe(false);
  });
  it('registry hardware wins over the load report when both exist', () => {
    const p = profileOf(row({ cores: 4, memGiB: 8, hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'M4 Max', cpuCores: 16, totalMemBytes: 64 * GIB, hostname: 'h' } as MachineCapacity['hardware'] }));
    expect(p).toMatchObject({ source: 'hardware', cores: 16, heavyCapable: true });
  });
  it('unknown size is never heavy-capable', () => {
    expect(profileOf(row({ cores: null, memGiB: null }))).toMatchObject({ heavyCapable: false, reason: 'size-unknown', source: 'unknown' });
    expect(profileOf({ machineId: 'm', online: true, clockSkewStatus: 'ok' } as MachineCapacity).reason).toBe('size-unknown');
  });
  it('a stale report still describes size (size is static)', () => {
    expect(profileOf(row({ reportAgeMs: 10 * 60_000 })).heavyCapable).toBe(true);
  });
  it('override allow lifts the floor; override deny removes a big machine', () => {
    const mini = row({ cores: 10, memGiB: 16 });
    mini.loadReport!.heavyWork = 'allow';
    expect(profileOf(mini)).toMatchObject({ heavyCapable: true, reason: 'override-allow', override: 'allow' });
    const studio = row();
    studio.loadReport!.heavyWork = 'deny';
    expect(profileOf(studio)).toMatchObject({ heavyCapable: false, reason: 'override-deny' });
  });
});

describe('fresh per-core load — never from stale evidence', () => {
  it('uses a fresh report loadPerCore', () => {
    expect(freshLoadPerCore(row({ lpc: 0.7 }), NOW)).toBeCloseTo(0.7);
  });
  it('falls back to loadAvg/cores only with a fresh receipt', () => {
    expect(freshLoadPerCore(row({ reportAgeMs: 120_000, loadAvg: 8 }), NOW)).toBeCloseTo(0.5);
    expect(freshLoadPerCore(row({ reportAgeMs: 120_000, loadAvg: 8, routerReceivedAt: new Date(NOW - 120_000).toISOString() }), NOW)).toBeNull();
  });
  it('rejects a negative or non-finite load average (never reads as idle)', () => {
    expect(freshLoadPerCore(row({ reportAgeMs: 120_000, loadAvg: -3 }), NOW)).toBeNull();
    expect(freshLoadPerCore(row({ reportAgeMs: 120_000, loadAvg: Number.NaN }), NOW)).toBeNull();
  });
  it('an offline row has no fresh load', () => {
    expect(freshLoadPerCore(row({ reportAgeMs: 120_000, loadAvg: 2, online: false }), NOW)).toBeNull();
  });
});

describe('placementLoad — per-core at an 8-core reference scale', () => {
  it('per-core × 8: a 16-core machine at load 16 scores like an 8-core machine at load 8', () => {
    expect(placementLoad(row({ lpc: 1.0 }), 0, NOW)).toBeCloseTo(LOAD_REFERENCE_CORES);
  });
  it('without cores, a fresh raw load average is used as-is (today\'s value)', () => {
    const r = row({ cores: null, memGiB: null, reportAgeMs: 120_000, loadAvg: 5 });
    expect(placementLoad(r, 0, NOW)).toBe(5);
  });
  it('unmeasured → null', () => {
    expect(placementLoad(row({ reportAgeMs: 120_000 }), 0, NOW)).toBeNull();
  });
  it('pending heavy work adds per-core load', () => {
    expect(placementLoad(row({ lpc: 0.5 }), 1, NOW)).toBeCloseTo(8);
  });
});

describe('heavyHeadroom / heavyFit', () => {
  it('headroom at or below 1.0 per core; busy above it', () => {
    expect(heavyHeadroom(row({ lpc: 1.0 }), 0, NOW)).toBe('headroom');
    expect(heavyHeadroom(row({ lpc: 1.01 }), 0, NOW)).toBe('busy');
  });
  it('a fresh saturated or impaired verdict is busy whatever the number', () => {
    expect(heavyHeadroom(row({ lpc: 0.1, loadVerdict: 'saturated' }), 0, NOW)).toBe('busy');
    expect(heavyHeadroom(row({ lpc: 0.1, loadVerdict: 'impaired' }), 0, NOW)).toBe('busy');
  });
  it('no fresh load → load-unknown, and heavyFit refuses it', () => {
    const r = row({ reportAgeMs: 120_000 });
    expect(heavyHeadroom(r, 0, NOW)).toBe('load-unknown');
    expect(heavyFit(r, 0, NOW)).toMatchObject({ eligible: false, reason: 'load-unknown' });
  });
  it('pending items push a machine over the line', () => {
    expect(heavyFit(row({ lpc: 0.6 }), 0, NOW).eligible).toBe(true);
    expect(heavyFit(row({ lpc: 0.6 }), 1, NOW)).toMatchObject({ eligible: false, reason: 'machine-busy' });
  });
  it('a small idle machine is refused as too small; override allow admits it', () => {
    const mini = row({ cores: 10, memGiB: 16, lpc: 0.1 });
    expect(heavyFit(mini, 0, NOW)).toMatchObject({ eligible: false, reason: 'machine-too-small' });
    mini.loadReport!.heavyWork = 'allow';
    expect(heavyFit(mini, 0, NOW)).toMatchObject({ eligible: true, reason: 'fits' });
  });
  it('override allow does not admit a busy machine', () => {
    const mini = row({ cores: 10, memGiB: 16, lpc: 1.6 });
    mini.loadReport!.heavyWork = 'allow';
    expect(heavyFit(mini, 0, NOW)).toMatchObject({ eligible: false, reason: 'machine-busy' });
  });
});

describe('effectivePending', () => {
  it('takes the larger of the decider reservation and the fresh advertised count', () => {
    const r = row();
    r.loadReport!.heavyPending = 2;
    expect(effectivePending(r, 1)).toBe(2);
    expect(effectivePending(r, 3)).toBe(3);
  });
  it('ignores the advertised count from a stale report', () => {
    const r = row({ reportAgeMs: 120_000 });
    r.loadReport!.heavyPending = 5;
    expect(effectivePending(r, 0)).toBe(0);
  });
});

describe('PendingHeavyWork', () => {
  it('counts per machine, releases on a definite failure, and expires', () => {
    let t = 0;
    const p = new PendingHeavyWork(() => t);
    const a = p.record('m_a');
    p.record('m_a');
    p.record('m_b');
    expect(p.count('m_a')).toBe(2);
    p.release(a);
    expect(p.count('m_a')).toBe(1);
    t = PENDING_HEAVY_TTL_MS + 1;
    expect(p.count('m_a')).toBe(0);
    expect(p.count('m_b')).toBe(0);
  });
  it('is bounded', () => {
    const p = new PendingHeavyWork(() => 0, 3);
    for (let i = 0; i < 10; i++) p.record('m_a');
    expect(p.count('m_a')).toBe(3);
  });
});

describe('inferWorkWeight — signal only', () => {
  it.each([
    ['xcodebuild -scheme Instar build', 'xcodebuild'],
    ['xcrun simctl boot "iPhone 17"', 'simctl'],
    ['npm test', 'package test run'],
    ['pnpm run test:all', 'package test run'],
    ['npx vitest run', 'vitest (whole suite)'],
    ['npm run build', 'package build'],
    ['tsc -b', 'tsc --build'],
    ['cargo build --release', 'cargo build'],
    ['./gradlew assembleDebug', 'gradle'],
  ])('heavy: %s', (cmd, label) => {
    expect(inferWorkWeight(cmd)).toEqual({ weight: 'heavy', matched: label });
  });
  it.each([
    'npx vitest run tests/unit/machine-resource-profile.test.ts',
    'git status',
    'curl -s http://localhost:4042/health',
    'ls -la',
  ])('not heavy: %s', (cmd) => {
    expect(inferWorkWeight(cmd)).toEqual({ weight: 'standard', matched: null });
  });
  it('returns only the label, never the input, and handles non-strings', () => {
    const r = inferWorkWeight('SECRET=abc npm test');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(inferWorkWeight(undefined as unknown as string)).toEqual({ weight: 'standard', matched: null });
  });
});
