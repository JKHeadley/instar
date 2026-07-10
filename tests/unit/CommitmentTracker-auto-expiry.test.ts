import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-auto-expiry-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return {
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/CommitmentTracker-auto-expiry.test.ts',
    }),
  };
}

function tracker(stateDir: string, dryRun = false): CommitmentTracker {
  return new CommitmentTracker({
    stateDir,
    liveConfig: new LiveConfig(stateDir),
    autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun },
  });
}

function daysBefore(base: Date, days: number): string {
  return new Date(base.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function ageCommitment(t: CommitmentTracker, id: string, createdAt: string): Promise<void> {
  await t.mutate(id, c => ({ ...c, createdAt }));
}

function isStoreWrite(p: unknown): boolean {
  return typeof p === 'string' && /commitments\.json\.\d+\.tmp$/.test(p);
}

describe('CommitmentTracker auto-expiry sweep', () => {
  let stateDir: string;
  let cleanup: () => void;
  const now = new Date('2026-07-10T12:00:00.000Z');

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('expires an agent-owned old pending commitment with the rollout resolution note', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'merge old PR', agentResponse: 'will do it' });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const report = t.sweepAutoExpiry(now);

    expect(report).toMatchObject({ eligible: 1, expired: 1, dryRun: false, capped: false });
    expect(t.get(c.id)).toMatchObject({
      status: 'expired',
      resolution: 'auto-expired: aged out >21d, presumed completed-but-unclosed',
      resolvedAt: now.toISOString(),
    });
  });

  it('never expires user-owned old commitments', async () => {
    const t = tracker(stateDir);
    const c = t.record({
      type: 'one-time-action',
      userRequest: 'user owes input',
      agentResponse: 'waiting',
      owner: 'user',
    });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const report = t.sweepAutoExpiry(now);

    expect(report.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('does not expire young agent-owned commitments', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'fresh follow-up', agentResponse: 'will do it' });
    await ageCommitment(t, c.id, daysBefore(now, 5));

    const report = t.sweepAutoExpiry(now);

    expect(report.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('does not expire old agent commitments with an unmet future hard deadline', async () => {
    const t = tracker(stateDir);
    const c = t.record({
      type: 'one-time-action',
      userRequest: 'wait for scheduled cutover',
      agentResponse: 'will do it by the deadline',
      hardDeadlineAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const report = t.sweepAutoExpiry(now);

    expect(report.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('dry-runs by logging eligibility without mutating', async () => {
    const t = tracker(stateDir, true);
    const c = t.record({ type: 'one-time-action', userRequest: 'old dry-run', agentResponse: 'will do it' });
    await ageCommitment(t, c.id, daysBefore(now, 30));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = t.sweepAutoExpiry(now);

    expect(report).toMatchObject({ dryRun: true, eligible: 1, expired: 0 });
    expect(t.get(c.id)?.status).toBe('pending');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('eligible=1 expired=0 dryRun=true');
  });

  it('is idempotent: the second non-dry-run sweep over the same state changes nothing', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'old once', agentResponse: 'will do it' });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const first = t.sweepAutoExpiry(now);
    const second = t.sweepAutoExpiry(now);

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
    expect(second.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('expired');
  });

  it('coalesces auto-expiry store persistence to one write per sweep', async () => {
    const t = tracker(stateDir);
    for (let i = 0; i < 12; i++) {
      const c = t.record({ type: 'one-time-action', userRequest: `old ${i}`, agentResponse: 'will do it' });
      await ageCommitment(t, c.id, daysBefore(now, 30));
    }

    const realWrite = fs.writeFileSync.bind(fs);
    let storeWrites = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (isStoreWrite(p)) storeWrites++;
      return (realWrite as any)(p, ...rest);
    }) as typeof fs.writeFileSync);

    t.sweepAutoExpiry(now);

    spy.mockRestore();
    expect(storeWrites).toBe(1);
  });

  it('backfills commitment auto-expiry defaults without overwriting operator choices', () => {
    const config: Record<string, unknown> = {
      commitments: { autoExpiry: { dryRun: false, maxAgeDays: 45 } },
    };
    const { patched, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));

    expect(patched).toBe(true);
    expect((config.commitments as any).autoExpiry).toMatchObject({
      enabled: true,
      maxAgeDays: 45,
      sweepIntervalMs: 21_600_000,
      dryRun: false,
    });
    expect(changes).toContain('commitments.autoExpiry.enabled (added)');
    expect(changes).toContain('commitments.autoExpiry.sweepIntervalMs (added)');
  });
});
