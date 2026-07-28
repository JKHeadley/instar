// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * autonomous-run-outlives-session — D2 wiring: a ResumeQueue disabled at runtime
 * (e.g. an un-healable foreign-host lock) must classify as `off-runtime-divergent`
 * in the guard-posture inventory, so a silently-disabled revival guard is loud on
 * GET /guards. Feeds a REAL disabled ResumeQueue's guardStatus() through the
 * actual GUARD_MANIFEST entry + deriveGuardRow (the same path the route uses).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
import { deriveGuardRow } from '../../src/monitoring/guardPostureView.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-guard-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const manifestEntry = () => {
  const e = GUARD_MANIFEST.find((m) => m.key === 'monitoring.resumeQueue.enabled');
  if (!e) throw new Error('ResumeQueue GUARD_MANIFEST entry missing');
  return e;
};

function rowFor(rq: ResumeQueue) {
  const entry = manifestEntry();
  const status = rq.guardStatus();
  return deriveGuardRow({
    key: entry.key,
    manifest: entry,
    configEnabled: true, // config says ON (the queue ships enabled)
    defaultEnabled: entry.defaultEnabled,
    configDryRun: status.dryRun,
    bootValue: true, // matches config → no disk divergence
    bootSnapshotAvailable: true,
    runtime: { kind: 'ok', status: { enabled: status.enabled, dryRun: status.dryRun, reason: status.reason } },
    now: Date.now(),
  });
}

describe('ResumeQueue guard-posture wiring (D2)', () => {
  it('has a GUARD_MANIFEST entry with component ResumeQueue + expectRuntime', () => {
    const e = manifestEntry();
    expect(e.component).toBe('ResumeQueue');
    expect(e.expectRuntime).toBe(true);
    expect(e.configPath).toBe('monitoring.resumeQueue.enabled');
  });

  it('a runtime-DISABLED queue (un-healable foreign lock) classifies off-runtime-divergent', () => {
    // Plant a live foreign-host lock so the queue disables (auto-heal off).
    const lockPath = path.join(tmpDir, 'state', 'resume-queue.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, hostname: 'a-different-machine' }));
    const rq = new ResumeQueue(
      { stateDir: tmpDir, hostname: () => 'this-host', pidAlive: () => true },
      { enabled: true, dryRun: false, autoHealStaleHostLock: false },
    );
    rq.start();
    expect(rq.guardStatus().enabled).toBe(false);
    const row = rowFor(rq);
    expect(row.effective).toBe('off-runtime-divergent');
  });

  it('a healthy enabled queue does NOT classify off-runtime-divergent', () => {
    const rq = new ResumeQueue(
      { stateDir: tmpDir, hostname: () => 'this-host' },
      { enabled: true, dryRun: false, autoHealStaleHostLock: true },
    );
    expect(rq.start()).toBe(true);
    expect(rq.guardStatus().enabled).toBe(true);
    const row = rowFor(rq);
    expect(row.effective).not.toBe('off-runtime-divergent');
  });
});
