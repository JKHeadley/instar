/**
 * SessionManager.currentMemoryPressure — the macos-memory-pressure-metric SIBLING.
 *
 * THE BUG (2026-08-04): the original macos-memory-pressure-metric fix corrected
 * SessionReaper/HostPressureSampler to read REAL available memory via
 * `hostFreeMemPct` (free + inactive + purgeable on macOS via vm_stat), and its
 * shipped comment warns against `os.freemem()` BY NAME. SessionManager's own
 * `currentMemoryPressure()` was never converted — it still computed
 * `(totalmem - os.freemem()) / totalmem`.
 *
 * On macOS `os.freemem()` reports only raw free pages (~2.7% on a healthy 17GB
 * host), so that method returned 'critical' PERMANENTLY. Under
 * `subscriptionPath.mode: 'force'`, `evaluateRerouteGate()` THROWS on elevated
 * pressure — so every job spawn was refused. Measured on the live Mini before
 * this fix: 20 of 27 enabled jobs failing, `health-check` and
 * `commitment-detection` at 421 consecutive failures each, with the identical
 * error `Reroute refused (force-mode): host memory pressure is critical`.
 *
 * WHY IT STAYED INVISIBLE: tests/unit/headless-spawn-reroute.test.ts stubs
 * `currentMemoryPressure` out entirely, with the comment that the real gate
 * "made this suite fail on loaded dev machines". It was not a loaded dev
 * machine — it was this defect, encountered, rationalised, and stubbed over.
 * These tests exercise the real method so it can fail for the real reason.
 *
 * Both sides of the decision boundary are covered (Testing Integrity Standard):
 * a healthy-but-low-free host must NOT read elevated, and a genuinely exhausted
 * host must still read 'critical'. A fix that simply always returned 'low' would
 * pass the first test and fail the second.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:child_process', () => ({
  execFileSync: () => '',
  execFile: (_c: string, _a: string[], cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: '' }),
}));

import { SessionManager, type SessionManagerConfig } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { MemReadDeps } from '../../src/monitoring/hostMemoryPressure.js';

/**
 * A realistic macOS `vm_stat` for a HEALTHY host: almost no "Pages free", but
 * ample reclaimable inactive + purgeable. This is the exact shape that made
 * os.freemem() read ~critical. Mirrors the fixture in host-memory-pressure.test.ts.
 * free+inactive+purgeable = 10k+1.5M+800k = 2.31M of 5.11M pages ≈ 45% available.
 */
const VM_STAT_HEALTHY_LOW_FREE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                           2000000.
Pages inactive:                         1500000.
Pages wired down:                        500000.
Pages purgeable:                         800000.
Pages occupied by compressor:            300000.
`;

/** A genuinely exhausted host: almost nothing free OR reclaimable. */
const VM_STAT_GENUINELY_EXHAUSTED = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5000.
Pages active:                           4500000.
Pages inactive:                           20000.
Pages wired down:                        500000.
Pages purgeable:                           5000.
Pages occupied by compressor:              5000.
`;

const macDeps = (vmStat: string): MemReadDeps => ({
  platform: 'darwin',
  vmStat: () => vmStat,
  totalmem: () => 5_110_000 * 16384,
});

function makeManager(tmpDir: string, mode?: 'off' | 'auto' | 'force'): SessionManager {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 10,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    ...(mode ? { subscriptionPathMode: mode } : {}),
  };
  return new SessionManager(config, new StateManager(stateDir));
}

type PressureProbe = { currentMemoryPressure: (deps?: MemReadDeps) => string };
type GateProbe = { evaluateRerouteGate: (name: string) => { allow: boolean } };

describe('SessionManager.currentMemoryPressure — macos-memory-pressure-metric sibling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mem-sibling-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/session-manager-memory-pressure-sibling.test.ts',
    });
  });

  it('a HEALTHY macOS host with tiny free pages does NOT read as elevated', () => {
    const manager = makeManager(tmpDir);
    const tier = (manager as unknown as PressureProbe)
      .currentMemoryPressure(macDeps(VM_STAT_HEALTHY_LOW_FREE));

    // Against the pre-fix code this is 'critical' (os.freemem sees ~0.2% free).
    expect(tier).not.toBe('critical');
    expect(tier).not.toBe('high');
    expect(tier).toBe('low');
  });

  it('a GENUINELY exhausted host still reads critical (the guard keeps its teeth)', () => {
    const manager = makeManager(tmpDir);
    const tier = (manager as unknown as PressureProbe)
      .currentMemoryPressure(macDeps(VM_STAT_GENUINELY_EXHAUSTED));

    expect(tier).toBe('critical');
  });

  it('force-mode reroute gate ALLOWS a spawn on a healthy-but-low-free host', () => {
    const manager = makeManager(tmpDir, 'force');
    // Pin the pressure read to the healthy fixture, leaving the gate's own logic intact.
    (manager as unknown as PressureProbe).currentMemoryPressure = () =>
      (makeManager(tmpDir) as unknown as PressureProbe)
        .currentMemoryPressure(macDeps(VM_STAT_HEALTHY_LOW_FREE));

    // Pre-fix this threw `Reroute refused (force-mode): host memory pressure is critical`
    // — the exact error that killed 20 of 27 jobs on the live Mini.
    expect(() => (manager as unknown as GateProbe).evaluateRerouteGate('job-health-check'))
      .not.toThrow();
    expect((manager as unknown as GateProbe).evaluateRerouteGate('job-health-check').allow).toBe(true);
  });

  it('force-mode reroute gate STILL refuses when the host is genuinely exhausted', () => {
    const manager = makeManager(tmpDir, 'force');
    (manager as unknown as PressureProbe).currentMemoryPressure = () =>
      (makeManager(tmpDir) as unknown as PressureProbe)
        .currentMemoryPressure(macDeps(VM_STAT_GENUINELY_EXHAUSTED));

    expect(() => (manager as unknown as GateProbe).evaluateRerouteGate('job-health-check'))
      .toThrow(/memory pressure is critical/);
  });

  it('diagnostics percentage and tier cannot contradict each other', () => {
    // Pre-fix, getSessionDiagnostics computed usedPercent from os.freemem() while
    // taking the TIER from currentMemoryPressure() — so once the tier was fixed the
    // surface could report "97% used" beside tier 'low'. Both now read one source.
    const manager = makeManager(tmpDir);
    const diag = (manager as unknown as {
      getSessionDiagnostics: () => { memoryPressure: string; usedPercent: number };
    }).getSessionDiagnostics();

    const tierForPercent =
      diag.usedPercent >= 90 ? 'critical'
      : diag.usedPercent >= 75 ? 'high'
      : diag.usedPercent >= 60 ? 'moderate'
      : 'low';
    expect(diag.memoryPressure).toBe(tierForPercent);
  });

  it('thresholds are unchanged — only the measurement source moved', () => {
    const manager = makeManager(tmpDir);
    const probe = manager as unknown as PressureProbe;
    // hostFreeMemPct is clamped 0..100; drive the tiers directly through it.
    const at = (freePct: number) =>
      probe.currentMemoryPressure({
        platform: 'linux',
        procMeminfo: () => `MemTotal: 1000000 kB\nMemAvailable: ${Math.round(freePct * 10000)} kB\n`,
        totalmem: () => 1000000 * 1024,
      });
    expect(at(5)).toBe('critical');   // 95% used
    expect(at(20)).toBe('high');      // 80% used
    expect(at(35)).toBe('moderate');  // 65% used
    expect(at(60)).toBe('low');       // 40% used
  });
});
