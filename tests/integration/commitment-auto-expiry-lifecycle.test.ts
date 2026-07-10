import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('CommitmentTracker auto-expiry lifecycle', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/commitment-auto-expiry-lifecycle.test.ts',
      });
    }
    dir = null;
  });

  it('persists expired commitments and reloads them as inactive terminal records', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-auto-expiry-int-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const now = new Date('2026-07-10T12:00:00.000Z');
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const first = new CommitmentTracker({
      stateDir: dir,
      liveConfig: new LiveConfig(dir),
      autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun: false },
    });
    const c = first.record({
      type: 'one-time-action',
      userRequest: 'merge when green',
      agentResponse: 'I will merge it when CI is green',
    });
    await first.mutate(c.id, cur => ({ ...cur, createdAt: old }));

    const report = first.sweepAutoExpiry(now);
    expect(report.expired).toBe(1);

    const second = new CommitmentTracker({
      stateDir: dir,
      liveConfig: new LiveConfig(dir),
      autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun: false },
    });
    expect(second.get(c.id)?.status).toBe('expired');
    expect(second.getActive().map(active => active.id)).not.toContain(c.id);
    expect(second.sweepAutoExpiry(now).expired).toBe(0);
  });
});
