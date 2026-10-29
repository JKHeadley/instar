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

function tracker(stateDir: string, extra: boolean | { operatorWait?: { enabled?: boolean; maxAgeDays?: number; dryRun?: boolean } } = false): CommitmentTracker {
  const dryRun = typeof extra === 'boolean' ? extra : false;
  return new CommitmentTracker({
    stateDir,
    liveConfig: new LiveConfig(stateDir),
    autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun },
    ...(typeof extra === 'object' ? extra : {}),
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

  it('expires an agent-owned old pending commitment with an honest outcome-unknown note (CMT-1118)', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'merge old PR', agentResponse: 'will do it' });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const report = t.sweepAutoExpiry(now);

    expect(report).toMatchObject({ eligible: 1, expired: 1, dryRun: false, capped: false });
    expect(t.get(c.id)).toMatchObject({
      status: 'expired',
      resolution: 'auto-expired after 30 days with no recorded activity; outcome unknown (not confirmed completed). Re-open it if it still matters.',
      resolvedAt: now.toISOString(),
    });
  });

  it('the agent branch never touches user-owned rows; the operator-wait branch owns them (attention-lifecycle-close-on-cause §3.5)', async () => {
    const t = tracker(stateDir);
    const c = t.record({
      type: 'one-time-action',
      userRequest: 'user owes input',
      agentResponse: 'waiting',
      owner: 'user',
    });
    await ageCommitment(t, c.id, daysBefore(now, 30));

    const report = t.sweepAutoExpiry(now);

    // Not "presumed completed": the agent rule's eligible count stays 0 …
    expect(report.eligible).toBe(0);
    // … the bounded operator-wait rule is what closes it, with its own wording.
    expect(report.operatorWait).toMatchObject({ enabled: true, eligible: 1, expired: 1 });
    expect(t.get(c.id)?.status).toBe('expired');
    expect(t.get(c.id)?.resolution).toMatch(/^expired: waited 30 days for you/);
  });

  it('with the operator-wait rule off, user-owned old commitments are left pending as before', async () => {
    const t = tracker(stateDir, { operatorWait: { enabled: false } });
    const c = t.record({ type: 'one-time-action', userRequest: 'user owes input', agentResponse: 'waiting', owner: 'user' });
    await ageCommitment(t, c.id, daysBefore(now, 30));
    const report = t.sweepAutoExpiry(now);
    expect(report.eligible).toBe(0);
    expect(report.operatorWait.eligible).toBe(0);
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
  // ── CMT-1118: blockedOn, opt-out reason, probe activity, replicas, review ledger ──

  function readLedger(): any[] {
    const p = path.join(stateDir, 'logs', 'commitments-auto-expiry.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('never ages out an agent row blocked on an external dependency', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'wait on vendor', agentResponse: 'will check', blockedOn: 'external' });
    await ageCommitment(t, c.id, daysBefore(now, 30));
    const report = t.sweepAutoExpiry(now);
    expect(report.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('with operator-wait off, an agent row blocked on the user is left pending — not swept by the agent rule', async () => {
    const t = tracker(stateDir, { operatorWait: { enabled: false } });
    const c = t.record({ type: 'one-time-action', userRequest: 'needs approval', agentResponse: 'asked', blockedOn: 'user-input' });
    await ageCommitment(t, c.id, daysBefore(now, 30));
    const report = t.sweepAutoExpiry(now);
    expect(report.eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('cites the followThroughOptOutReason instead of claiming completion', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'answered in turn', agentResponse: 'done', followThroughOptOutReason: 'answered in the same reply' });
    await ageCommitment(t, c.id, daysBefore(now, 30));
    const report = t.sweepAutoExpiry(now);
    expect(report.dispositions[0]).toMatchObject({ id: c.id, class: 'opted-out' });
    expect(t.get(c.id)?.resolution).toBe('auto-expired after 30 days: created with no follow-through needed ("answered in the same reply")');
  });

  it('measures age from the latest dependency probe, so an actively-checked row is not aged out', async () => {
    const t = tracker(stateDir);
    const c = t.record({ type: 'one-time-action', userRequest: 'watch CI', agentResponse: 'will watch' });
    await t.mutate(c.id, (x) => ({ ...x, createdAt: daysBefore(now, 30), lastProbe: { at: daysBefore(now, 3), checked: 'ci', readinessSignal: 'pending' } }));
    expect(t.sweepAutoExpiry(now).eligible).toBe(0);
    await t.mutate(c.id, (x) => ({ ...x, lastProbe: { at: daysBefore(now, 25), checked: 'ci', readinessSignal: 'pending' } }));
    expect(t.sweepAutoExpiry(now).eligible).toBe(1);
  });

  it("leaves another machine's commitment to its origin machine", async () => {
    const t = new CommitmentTracker({
      stateDir,
      liveConfig: new LiveConfig(stateDir),
      originMachineId: 'm_self',
      autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun: false },
    });
    const c = t.record({ type: 'one-time-action', userRequest: 'peer row', agentResponse: 'will do' });
    await t.mutate(c.id, (x) => ({ ...x, createdAt: daysBefore(now, 30), originMachineId: 'm_peer' }));
    expect(t.sweepAutoExpiry(now).eligible).toBe(0);
    expect(t.get(c.id)?.status).toBe('pending');
  });

  it('dry-run writes the would-expire ids to the review ledger, then a short row while the set is unchanged', async () => {
    const t = tracker(stateDir, true);
    const a = t.record({ type: 'one-time-action', userRequest: 'old a', agentResponse: 'will do' });
    const b = t.record({ type: 'one-time-action', userRequest: 'old b', agentResponse: 'will do', followThroughOptOutReason: 'no follow-up' });
    await ageCommitment(t, a.id, daysBefore(now, 30));
    await ageCommitment(t, b.id, daysBefore(now, 40));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    t.sweepAutoExpiry(now);
    t.sweepAutoExpiry(now);

    const rows = readLedger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ dryRun: true, eligible: 2, expired: 0 });
    expect(rows[0].items.map((i: any) => [i.id, i.class, i.ageDays]).sort()).toEqual([[a.id, 'no-activity', 30], [b.id, 'opted-out', 40]].sort());
    expect(rows[1]).toMatchObject({ unchanged: true, setHash: rows[0].setHash, eligible: 2 });
    expect(rows[1].items).toBeUndefined();
    expect(rows[0].items.every((i: any) => i.applied === false)).toBe(true);
    expect(t.get(a.id)?.status).toBe('pending');
  });

  it('writes one empty row when the eligible set drains, then nothing', async () => {
    const t = tracker(stateDir, true);
    const a = t.record({ type: 'one-time-action', userRequest: 'old a', agentResponse: 'will do' });
    await ageCommitment(t, a.id, daysBefore(now, 30));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    t.sweepAutoExpiry(now);
    t.withdraw(a.id, 'done by hand');
    t.sweepAutoExpiry(now);
    t.sweepAutoExpiry(now);
    const rows = readLedger();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ eligible: 0, items: [] });
  });

  it('marks operator-wait items applied when that branch is live while the agent branch is dry-run', async () => {
    const t = tracker(stateDir, true); // agent dry-run; operator-wait defaults live
    const u = t.record({ type: 'one-time-action', userRequest: 'user owes input', agentResponse: 'waiting', owner: 'user' });
    const a = t.record({ type: 'one-time-action', userRequest: 'old a', agentResponse: 'will do' });
    await ageCommitment(t, u.id, daysBefore(now, 30));
    await ageCommitment(t, a.id, daysBefore(now, 30));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    t.sweepAutoExpiry(now);
    const [row] = readLedger();
    expect(row).toMatchObject({ dryRun: true, operatorWaitDryRun: false, expired: 1 });
    const byId = Object.fromEntries(row.items.map((i: any) => [i.id, i]));
    expect(byId[u.id]).toMatchObject({ class: 'operator-wait', applied: true });
    expect(byId[a.id]).toMatchObject({ class: 'no-activity', applied: false });
  });
});
