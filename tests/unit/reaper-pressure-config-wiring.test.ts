/**
 * WIRING INTEGRITY (reaper-pressure-signals, round-2 finding D5): the spec NAMES
 * `monitoring.sessionReaper.cpuSignal: 'load'` as the rollback lever, and the
 * Decision-Completeness tag "cheap/reversible" rests on that lever being connected. The
 * integration and e2e suites stub `pressure: () => computePressure(FIXED_VECTOR, …)`, so
 * they would ALL still pass with the config plumbing deleted — the lever would silently do
 * nothing. These tests close that: they drive config → the real sampler → computePressure.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sampleHostPressure, DEFAULT_HOST_PRESSURE_THRESHOLDS } from '../../src/monitoring/HostPressureSampler.js';
import type { InstarConfig } from '../../src/core/types.js';

/** Exactly how server.ts builds the thresholds object from config. */
function thresholdsFromConfig(cfg: NonNullable<NonNullable<InstarConfig['monitoring']>['sessionReaper']>) {
  return {
    cpuModerateLoadPerCore: cfg.cpuModerateLoadPerCore ?? 1.0,
    cpuCriticalLoadPerCore: cfg.cpuCriticalLoadPerCore ?? 1.5,
    cpuSignal: cfg.cpuSignal,
    cpuModerateBusyPct: cfg.cpuModerateBusyPct,
    cpuCriticalBusyPct: cfg.cpuCriticalBusyPct,
  };
}

describe('reaper pressure: config reaches the classifier', () => {
  it("cpuSignal from config decides which signal grades cpuTier (the named rollback lever)", () => {
    // 'load' with a floor of 0 must grade critical from the load average alone; 'busy' with
    // an unreachable busy floor must not. If cpuSignal stopped being threaded through, both
    // would return the same tier and this fails.
    const asLoad = sampleHostPressure(thresholdsFromConfig({
      cpuSignal: 'load', cpuModerateLoadPerCore: 0, cpuCriticalLoadPerCore: 0,
    } as never));
    const asBusy = sampleHostPressure(thresholdsFromConfig({
      cpuSignal: 'busy', cpuModerateBusyPct: 100.1, cpuCriticalBusyPct: 100.2,
    } as never));
    expect(asLoad.inputs?.cpuSignal).toBe('load');
    expect(asLoad.inputs?.cpuTier).toBe('critical');
    expect(asBusy.inputs?.cpuSignal).toBe('busy');
    expect(asBusy.inputs?.cpuTier).toBe('normal');
  });

  it('busy thresholds from config are honored (not the shipped defaults)', () => {
    const strict = sampleHostPressure(thresholdsFromConfig({
      cpuSignal: 'busy', cpuModerateBusyPct: 0, cpuCriticalBusyPct: 0,
    } as never));
    // every measurable busy% >= 0, so a zero floor must grade critical; a null sample (no
    // window yet) is the one honest exception and grades normal.
    expect(strict.inputs?.cpuBusyPct === null ? 'normal' : strict.inputs?.cpuTier).toBe(
      strict.inputs?.cpuBusyPct === null ? 'normal' : 'critical',
    );
  });

  it('an ABSENT config block yields the shipped defaults, never undefined-erased ones', () => {
    const r = sampleHostPressure(thresholdsFromConfig({} as never));
    expect(r.inputs?.cpuSignal).toBe('busy'); // default signal survives `cpuSignal: undefined`
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuModerateLoadPerCore).toBeGreaterThan(0);
  });

  it("server.ts really passes cpuSignal + both busy thresholds at EVERY sampleHostPressure callsite", () => {
    // The lever is only as real as its plumbing. This reads the source so deleting a line
    // from one callsite (the exact regression D5 describes) fails here.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const callsites = [...src.matchAll(/_?sampleHostPressure\(\{([\s\S]{0,600}?)\}\)/g)].map((m) => m[1]);
    expect(callsites.length).toBeGreaterThanOrEqual(2);
    for (const body of callsites) {
      expect(body).toContain('cpuSignal');
      expect(body).toContain('cpuModerateBusyPct');
      expect(body).toContain('cpuCriticalBusyPct');
    }
  });
});
