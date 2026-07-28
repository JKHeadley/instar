// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup, not a production path.
/**
 * Feature-alive check (spec §11 / Testing Integrity Phase-1): the
 * /health.multiMachine.syncStatus surface returns VALID fields (never null/
 * throws) even on a single-machine install. Exercises the real
 * MultiMachineCoordinator.getSyncStatus() — the observability the health route
 * serves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SEAMLESSNESS_PROTOCOL_VERSION } from '../../src/core/seamlessnessConfig.js';

let dir: string;
let coord: MultiMachineCoordinator;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mm-syncstatus-'));
});
afterEach(() => {
  coord?.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('MultiMachineCoordinator.getSyncStatus — feature-alive surface', () => {
  it('returns valid, non-null fields on a single-machine install (no identity)', () => {
    coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir });
    coord.start(); // no identity → single machine, always awake

    const s = coord.getSyncStatus();
    // Every field present and well-typed (not null where the contract says so).
    expect(typeof s.enabled).toBe('boolean');
    expect(s.enabled).toBe(false); // single machine = multi-machine disabled
    expect(['awake', 'standby']).toContain(s.role);
    expect(s.role).toBe('awake');
    expect(typeof s.leaseEpoch).toBe('number');
    expect(typeof s.holdsLease).toBe('boolean');
    expect(s.holdsLease).toBe(true); // single machine trivially "holds"
    expect(['clear', 'contested', 'self-suspended']).toContain(s.splitBrainState);
    expect(s.splitBrainState).toBe('clear');
    expect(s.protocolVersion).toBe(SEAMLESSNESS_PROTOCOL_VERSION);
    // machine-coherence-guard §5b — awakeMachineCount is now number | null with a
    // source tag. A single-machine install has no lease coordinator, so it takes the
    // registry-role basis and returns a plain number (never null here).
    expect(typeof s.awakeMachineCount).toBe('number');
    expect(s.awakeMachineCountSource).toBe('registry-roles');
  });

  it('getSyncStatus never throws even if the registry is unreadable', () => {
    coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir });
    coord.start();
    // Should not throw regardless of registry state.
    expect(() => coord.getSyncStatus()).not.toThrow();
  });
});
