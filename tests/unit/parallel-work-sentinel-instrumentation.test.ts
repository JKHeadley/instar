/**
 * ParallelWorkSentinel runtime instrumentation (CMT-810, Defect 2): the sentinel
 * must be VERIFIABLE — a completed tick is recorded (lastTickAt / tickCount), a
 * thrown tick is recorded and re-thrown, guardStatus() follows the GuardRegistry
 * contract, and the manifest declares the runtime it now actually registers.
 */
import { describe, it, expect } from 'vitest';
import { ParallelWorkSentinel } from '../../src/monitoring/ParallelWorkSentinel.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { deriveGuardRow } from '../../src/monitoring/guardPostureView.js';

const act = (topicId: number, tags: string[], updatedAt: number) => ({ topicId, focus: 'f', tags, updatedAt, running: true });

describe('ParallelWorkSentinel instrumentation', () => {
  it('starts un-ticked: lastTickAt 0 / tickCount 0 (registration is not life)', () => {
    const s = new ParallelWorkSentinel({ getActivities: () => [] });
    expect(s.guardStatus()).toEqual({ enabled: true, lastTickAt: 0 });
    expect(s.stats()).toMatchObject({ enabled: true, tickCount: 0, lastTickAt: 0, nudgesTotal: 0, lastError: null });
    expect(s.stats().constructedAt).toBeGreaterThan(0);
  });

  it('records a completed tick: lastTickAt = the tick clock, counts activities + nudges', () => {
    const now = 1_700_000_000_000;
    const s = new ParallelWorkSentinel({ getActivities: () => [act(1, ['mac-studio', 'kernel-leak'], now), act(2, ['mac-studio', 'kernel-leak'], now)] });
    const fired = s.tick(now);
    expect(fired).toHaveLength(1);
    expect(s.guardStatus()).toEqual({ enabled: true, lastTickAt: now });
    expect(s.stats()).toMatchObject({ tickCount: 1, lastTickActivities: 2, lastTickNudges: 1, nudgesTotal: 1, trackedPairs: 1 });
    s.tick(now + 1000);
    expect(s.stats()).toMatchObject({ tickCount: 2, lastTickAt: now + 1000, lastTickNudges: 0, nudgesTotal: 1 });
  });

  it('a throwing tick is recorded (lastError/lastErrorAt) and re-thrown; lastTickAt does not advance', () => {
    const s = new ParallelWorkSentinel({ getActivities: () => { throw new Error('index exploded'); } });
    expect(() => s.tick(42)).toThrow('index exploded');
    expect(s.stats()).toMatchObject({ lastTickAt: 0, tickCount: 0, lastErrorAt: 42, lastError: 'index exploded' });
  });

  it('guardStatus() satisfies the GuardRegistry getter contract and grades through the posture view', () => {
    const s = new ParallelWorkSentinel({ getActivities: () => [] });
    const reg = new GuardRegistry();
    reg.register('monitoring.parallelWorkSentinel.enabled', () => s.guardStatus());
    const manifest = GUARD_MANIFEST.find((m) => m.key === 'monitoring.parallelWorkSentinel.enabled')!;
    const now = Date.now();
    const base = { key: manifest.key, manifest, configEnabled: true, defaultEnabled: false, configDryRun: undefined, bootSnapshotAvailable: false, bootValue: undefined, now };
    // Registered but never ticked → on-stale (never painted green on registration alone).
    const before = deriveGuardRow({ ...base, runtime: reg.read(manifest.key) });
    expect(before.effective).toBe('on-stale');
    s.tick(now);
    const after = deriveGuardRow({ ...base, runtime: reg.read(manifest.key) });
    expect(after.effective).toBe('on-confirmed');
    expect(after.runtime?.lastTickAt).toBe(now);
  });

  it('manifest: expectRuntime is TRUE (a registration callsite exists) with the 15-min default cadence', () => {
    const entry = GUARD_MANIFEST.find((m) => m.key === 'monitoring.parallelWorkSentinel.enabled')!;
    expect(entry.expectRuntime).toBe(true);
    expect(entry.expectedTickMs).toBe(15 * 60_000);
    expect(entry.component).toBe('ParallelWorkSentinel');
  });
});
