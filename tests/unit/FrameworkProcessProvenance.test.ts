import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameworkProcessProvenanceVerifier } from '../../src/monitoring/FrameworkProcessProvenance.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tempState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-framework-provenance-'));
}

describe('FrameworkProcessProvenanceVerifier', () => {
  it('confirms only matching path, vnode, start time, and direct framework parent', async () => {
    const dir = tempState();
    try {
      const verifier = new FrameworkProcessProvenanceVerifier(dir, {
        now: () => 10_000,
        snapshot: () => ({ realpath: '/trusted/host', device: 7, inode: 9 }),
        probe: async () => ({ procPath: '/trusted/host', lsofPath: '/trusted/host', device: 7, inode: 9, startTime: 2_000 }),
      });
      await expect(verifier.classify({
        pid: 42, parentPid: 10, frameworkRootPid: 10,
        sessionIncarnation: 'inc-1', sessionStartedAt: 1_000,
      })).resolves.toMatchObject({ protected: true, confirmed: true, reason: 'codex-code-mode-host' });
      await expect(verifier.classify({
        pid: 43, parentPid: 99, frameworkRootPid: 10,
        sessionIncarnation: 'inc-1', sessionStartedAt: 1_000,
      })).resolves.toMatchObject({ protected: true, confirmed: false, reason: 'ownership-unknown' });
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });

  it('keeps probe failures protective and backs off instead of probing each poll', async () => {
    const dir = tempState();
    let probes = 0;
    try {
      const verifier = new FrameworkProcessProvenanceVerifier(dir, {
        now: () => 10_000,
        snapshot: () => ({ realpath: '/trusted/host', device: 7, inode: 9 }),
        probe: async () => { probes += 1; throw new Error('timeout'); },
      });
      const observation = {
        pid: 42, parentPid: 10, frameworkRootPid: 10,
        sessionIncarnation: 'inc-1', sessionStartedAt: 1_000,
      };
      expect(await verifier.classify(observation)).toMatchObject({ protected: true, confirmed: false, reason: 'ownership-unknown' });
      expect(await verifier.classify(observation)).toMatchObject({ protected: true, confirmed: false, reason: 'ownership-unknown' });
      expect(probes).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });
});
