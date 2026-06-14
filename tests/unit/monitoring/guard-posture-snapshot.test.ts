/**
 * Tier-1 — resolveGuardConfigSnapshot (one-disk-read resolved config) and
 * GuardRegistry (sync getters, per-guard error isolation).
 * GUARD-POSTURE-ENDPOINT-SPEC §2.1/§2.2/§6.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readGuardPostureBootSnapshot,
  resolveGuardConfigSnapshot,
} from '../../../src/monitoring/guardPosture.js';
import { GuardRegistry } from '../../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-snap-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/monitoring/guard-posture-snapshot.test.ts:cleanup',
  });
});

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(config));
}

describe('resolveGuardConfigSnapshot', () => {
  it('merges the on-disk file over defaults (file wins; absent keys default-resolve)', () => {
    writeConfig({ monitoring: { sessionReaper: { enabled: true } } });
    const snap = resolveGuardConfigSnapshot(dir);
    const monitoring = snap.resolved.monitoring as Record<string, Record<string, unknown>>;
    expect(monitoring.sessionReaper.enabled).toBe(true); // file value
    expect(monitoring.watchdog.enabled).toBe(true); // default backfilled
    expect(snap.fileAbsent).toBe(false);
    expect(snap.readError).toBeUndefined();
  });

  it('reads config.json EXACTLY ONCE per call (one-read-per-request pin)', () => {
    writeConfig({ monitoring: {} });
    const spy = vi.spyOn(fs, 'readFileSync');
    resolveGuardConfigSnapshot(dir);
    const configReads = spy.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith(path.join('.instar', 'config.json')),
    );
    expect(configReads.length).toBe(1);
  });

  it('dev-gated guard with omitted enabled resolves through the dev-agent gate', () => {
    writeConfig({ developmentAgent: true, monitoring: { growthAnalyst: {} } });
    const devSnap = resolveGuardConfigSnapshot(dir);
    const devMonitoring = devSnap.resolved.monitoring as Record<string, Record<string, unknown>>;
    expect(devMonitoring.growthAnalyst.enabled).toBe(true); // gate-resolved LIVE on dev agent

    writeConfig({ monitoring: { growthAnalyst: {} } });
    const fleetSnap = resolveGuardConfigSnapshot(dir);
    const fleetMonitoring = fleetSnap.resolved.monitoring as Record<string, Record<string, unknown>>;
    expect(fleetMonitoring.growthAnalyst.enabled).toBe(false); // DARK on fleet

    // The defaults baseline mirrors the gate (the gate IS the default), so a
    // dev agent's gate-on guard classifies as dark-default, not deviant.
    const devDefaults = devSnap.defaults.monitoring as Record<string, Record<string, unknown>>;
    expect(devDefaults.growthAnalyst.enabled).toBe(true);
  });

  it('an explicit enabled value beats the dev gate', () => {
    writeConfig({ developmentAgent: true, monitoring: { growthAnalyst: { enabled: false } } });
    const snap = resolveGuardConfigSnapshot(dir);
    const monitoring = snap.resolved.monitoring as Record<string, Record<string, unknown>>;
    expect(monitoring.growthAnalyst.enabled).toBe(false);
  });

  it('missing config.json → defaults-only snapshot, flagged fileAbsent, NOT an error', () => {
    const snap = resolveGuardConfigSnapshot(dir);
    expect(snap.fileAbsent).toBe(true);
    expect(snap.readError).toBeUndefined();
    const monitoring = snap.resolved.monitoring as Record<string, Record<string, unknown>>;
    expect(typeof monitoring.watchdog.enabled).toBe('boolean');
  });

  it('corrupt config.json → readError set (callers 5xx, never empty-truthful)', () => {
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), '{nope');
    const snap = resolveGuardConfigSnapshot(dir);
    expect(snap.readError).toBeTruthy();
  });
});

describe('readGuardPostureBootSnapshot', () => {
  it('round-trips the tripwire snapshot and returns null on absent/corrupt', () => {
    expect(readGuardPostureBootSnapshot(path.join(dir, '.instar'))).toBeNull();
    const snapPath = path.join(dir, '.instar', 'state', 'guard-posture.json');
    fs.writeFileSync(snapPath, JSON.stringify({ ts: '2026-06-12T00:00:00Z', posture: { 'scheduler.enabled': true } }));
    expect(readGuardPostureBootSnapshot(path.join(dir, '.instar'))?.posture['scheduler.enabled']).toBe(true);
    fs.writeFileSync(snapPath, '{corrupt');
    expect(readGuardPostureBootSnapshot(path.join(dir, '.instar'))).toBeNull();
  });
});

describe('GuardRegistry', () => {
  it('registers, reads, and isolates a throwing getter per guard', () => {
    const registry = new GuardRegistry();
    registry.register('a', () => ({ enabled: true, lastTickAt: 5 }));
    registry.register('b', () => { throw new Error('component exploded'); });
    expect(registry.read('a')).toEqual({ kind: 'ok', status: { enabled: true, lastTickAt: 5 } });
    expect(registry.read('b')).toEqual({ kind: 'error', message: 'component exploded' });
    expect(registry.read('c')).toEqual({ kind: 'unregistered' });
  });

  it('last registration wins (respawned component re-registers over its predecessor)', () => {
    const registry = new GuardRegistry();
    registry.register('a', () => ({ enabled: false }));
    registry.register('a', () => ({ enabled: true }));
    expect(registry.read('a')).toEqual({ kind: 'ok', status: { enabled: true } });
  });

  it('a getter returning a non-status value reads as an error, not a crash', () => {
    const registry = new GuardRegistry();
    registry.register('a', () => null as never);
    expect(registry.read('a').kind).toBe('error');
  });

  it('SYNC enforcement: an async getter is structurally unusable (errored, never awaited)', () => {
    // The runtime-enrichment contract (spec §2.2) requires synchronous
    // in-memory getters. An async getter returns a Promise, which is not a
    // status object — it reads as `errored` IMMEDIATELY (the read itself is
    // sync), so nobody can convert a getter to async and have it silently
    // work. This is the structural pin behind the <100ms criterion.
    const registry = new GuardRegistry();
    registry.register('a', (async () => ({ enabled: true })) as never);
    const read = registry.read('a');
    expect(read.kind).toBe('error');
    expect(read).not.toBeInstanceOf(Promise);
  });
});
