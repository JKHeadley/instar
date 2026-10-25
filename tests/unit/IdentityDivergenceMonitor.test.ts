import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectIdentityDivergences, IdentityDivergenceMonitor } from '../../src/core/IdentityDivergenceMonitor.js';
import type { IdentityProjection } from '../../src/core/IdentityStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'IdentityDivergenceMonitor.test:cleanup',
}); });

function projection(over: Partial<IdentityProjection> = {}): IdentityProjection {
  return {
    machineId: 'target', keyEpoch: 2, signingFingerprint: 'sign-a',
    recoveryEpoch: 1, recoveryFingerprint: 'recover-a', registryStatus: 'active', ...over,
  };
}

describe('IdentityDivergenceMonitor', () => {
  it('detects equal-epoch signing and recovery divergence but treats epoch lag as convergence', () => {
    expect(detectIdentityDivergences([
      { sourceMachineId: 'a', projections: [projection()] },
      { sourceMachineId: 'b', projections: [projection({ signingFingerprint: 'sign-b', recoveryFingerprint: 'recover-b' })] },
      { sourceMachineId: 'c', projections: [projection({ keyEpoch: 1, signingFingerprint: 'old' })] },
    ])).toEqual([
      expect.objectContaining({ kind: 'recovery', epoch: 1, fingerprints: ['recover-a', 'recover-b'] }),
      expect.objectContaining({ kind: 'signing', epoch: 2, fingerprints: ['sign-a', 'sign-b'] }),
    ]);
  });

  it('raises once per durable episode, clears, and raises again on recurrence', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-divergence-'));
    roots.push(stateDir);
    let views = [
      { sourceMachineId: 'a', projections: [projection()] },
      { sourceMachineId: 'b', projections: [projection({ signingFingerprint: 'sign-b' })] },
    ];
    const raise = vi.fn();
    const monitor = new IdentityDivergenceMonitor({ stateDir, readViews: async () => views, raise });
    await monitor.tick();
    await monitor.tick();
    expect(raise).toHaveBeenCalledTimes(1);
    views = [{ sourceMachineId: 'a', projections: [projection()] }];
    expect(await monitor.tick()).toEqual([]);
    views = [
      { sourceMachineId: 'a', projections: [projection()] },
      { sourceMachineId: 'b', projections: [projection({ signingFingerprint: 'sign-b' })] },
    ];
    await monitor.tick();
    expect(raise).toHaveBeenCalledTimes(2);
  });
});
