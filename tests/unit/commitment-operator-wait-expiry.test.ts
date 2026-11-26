/**
 * Tier-1 unit tests — attention-lifecycle-close-on-cause §3.5: a commitment
 * waiting on the operator expires after a bounded wait (default 14 days) with
 * a per-row reason, judged before the agent branch, with its own dryRun.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker, type CommitmentTrackerConfig } from '../../src/monitoring/CommitmentTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-opwait-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'commitment-operator-wait-expiry test cleanup' }); });

function tracker(over: Partial<CommitmentTrackerConfig> = {}): CommitmentTracker {
  return new CommitmentTracker({ stateDir: tmp, autoExpiry: { enabled: true, dryRun: true }, ...over } as CommitmentTrackerConfig);
}

function backdate(ct: CommitmentTracker, id: string, days: number): void {
  const c = ct.get(id)!;
  (c as { createdAt: string }).createdAt = new Date(Date.now() - days * DAY).toISOString();
}

describe('operator-wait expiry', () => {
  it('a user-owned pending commitment waited 15 days → expired with a plain reason; 13 days → kept', () => {
    const ct = tracker();
    const a = ct.record({ type: 'one-time-action', topicId: 1, userRequest: 'approve the deploy?', agentResponse: 'waiting for your yes', owner: 'user', blockedOn: 'user-authorization', actionClass: 'deploy', followThroughOptOutReason: 'test' } as never);
    const b = ct.record({ type: 'one-time-action', topicId: 1, userRequest: 'which colour?', agentResponse: 'waiting', owner: 'user', blockedOn: 'user-input', followThroughOptOutReason: 'test' } as never);
    backdate(ct, a.id, 15);
    backdate(ct, b.id, 13);
    const report = ct.sweepAutoExpiry();
    expect(report.operatorWait).toMatchObject({ enabled: true, dryRun: false, maxAgeDays: 14, eligible: 1, expired: 1 });
    expect(ct.get(a.id)?.status).toBe('expired');
    expect(ct.get(a.id)?.resolution).toMatch(/expired: waited 15 days for your authorization/);
    expect(ct.get(b.id)?.status).toBe('pending');
    expect(report.dispositions.find((d) => d.id === a.id)).toMatchObject({ branch: 'operator-wait', applied: true });
  });

  it('is judged before the agent branch: an agent-owned row blocked on user-input gets the operator-wait wording, not "presumed completed"', () => {
    const ct = tracker({ autoExpiry: { enabled: true, dryRun: false, maxAgeDays: 21 } });
    const a = ct.record({ type: 'one-time-action', topicId: 1, userRequest: 'need your token', agentResponse: 'waiting', owner: 'agent', blockedOn: 'user-input', followThroughOptOutReason: 'test' } as never);
    backdate(ct, a.id, 30);
    ct.sweepAutoExpiry();
    expect(ct.get(a.id)?.resolution).toMatch(/waited 30 days for your answer/);
  });

  it('respects its own dryRun, a future hard deadline, a replica from another machine, and enabled:false', () => {
    const dry = tracker({ operatorWait: { dryRun: true }, originMachineId: 'm_self' });
    const a = dry.record({ type: 'one-time-action', topicId: 1, userRequest: 'q', agentResponse: 'w', owner: 'user', blockedOn: 'user-input', followThroughOptOutReason: 't' } as never);
    backdate(dry, a.id, 20);
    const r = dry.sweepAutoExpiry();
    expect(r.operatorWait).toMatchObject({ dryRun: true, eligible: 1, expired: 0 });
    expect(dry.get(a.id)?.status).toBe('pending');

    const live = tracker({ originMachineId: 'm_self' });
    const b = live.record({ type: 'one-time-action', topicId: 1, userRequest: 'q', agentResponse: 'w', owner: 'user', blockedOn: 'user-input', hardDeadlineAt: new Date(Date.now() + 5 * DAY).toISOString(), followThroughOptOutReason: 't' } as never);
    backdate(live, b.id, 20);
    const c = live.record({ type: 'one-time-action', topicId: 1, userRequest: 'q', agentResponse: 'w', owner: 'user', blockedOn: 'user-input', followThroughOptOutReason: 't' } as never);
    backdate(live, c.id, 20);
    (live.get(c.id) as { originMachineId?: string }).originMachineId = 'm_other';
    expect(live.sweepAutoExpiry().operatorWait.eligible).toBe(0);

    const off = tracker({ operatorWait: { enabled: false } });
    const d = off.record({ type: 'one-time-action', topicId: 1, userRequest: 'q', agentResponse: 'w', owner: 'user', blockedOn: 'user-input', followThroughOptOutReason: 't' } as never);
    backdate(off, d.id, 20);
    expect(off.sweepAutoExpiry().operatorWait).toMatchObject({ enabled: false, eligible: 0 });
  });

  it('an agent-owned, unblocked row is untouched by the operator-wait branch', () => {
    const ct = tracker();
    const a = ct.record({ type: 'one-time-action', topicId: 1, userRequest: 'q', agentResponse: 'w', beaconEnabled: true, nextUpdateDueAt: new Date(Date.now() + DAY).toISOString() } as never);
    backdate(ct, a.id, 20);
    expect(ct.sweepAutoExpiry().operatorWait.eligible).toBe(0);
  });
});
