import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySelfHealEpisodeStore, SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealSpec } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'SelfHealGate.test cleanup' }); });

type Ctx = { severity: 'recoverable' | 'unknown'; healthy?: boolean; fence?: string };
function spec(remediation: SelfHealSpec<Ctx>['remediation']): SelfHealSpec<Ctx> {
  return {
    id: 'test-heal', controllerResource: 'hardware-bound', episodeAuthority: 'process-local', classId: 'test',
    severity: (ctx) => ctx.severity, dedupeKey: () => 'same-break', eligible: (ctx) => ({ eligible: true, fence: ctx.fence ?? 'f1' }), remediation,
    restartVerified: (ctx) => ctx.healthy === true, maxAttempts: 3, maxWallClockMs: 10_000, backoffMs: () => 0,
    notificationLatencyCeilingMs: 1_000, flap: { maxRecoveries: 3, windowMs: 10_000 },
    remediationActions: { operation: 'test', idempotencyGuard: 'idempotent', compensation: 'none' },
  };
}
function deps(store = new InMemorySelfHealEpisodeStore(), over: Record<string, unknown> = {}) {
  let token = 0;
  return {
    store,
    value: {
      admit: vi.fn(async () => ({ outcome: 'allow' as const, token: { id: `t${++token}` } as AdmissionToken, reason: 'admitted' as const })),
      consumeToken: vi.fn(() => ({ proceed: true, valid: true })), notify: vi.fn(), audit: vi.fn(), episodeStore: store, bootId: 'boot-1', ...over,
    },
  };
}

describe('SelfHealGate', () => {
  it('immediately notices unknown severity and never remediates', async () => {
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const)); const d = deps();
    const result = await new SelfHealGate(spec(remediation), d.value).attempt({ severity: 'unknown' });
    expect(result.outcome).toBe('invalid-severity'); expect(remediation).not.toHaveBeenCalled(); expect(d.value.notify).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a notice whose durable enqueue rejects', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('attention store unavailable'));
    const d = deps(new InMemorySelfHealEpisodeStore(), { notify });
    const gate = new SelfHealGate(spec(() => ({ outcome: 'healed', evidence: 'repaired' })), d.value);
    await gate.attempt({ severity: 'unknown' });
    await gate.attempt({ severity: 'unknown' });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('revalidates the ownership fence inside the atomic attempt claim', async () => {
    let checks = 0;
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const guardedSpec = spec(remediation);
    guardedSpec.eligible = () => ({ eligible: true, fence: ++checks >= 4 ? 'f2' : 'f1' });
    const d = deps();
    const result = await new SelfHealGate(guardedSpec, d.value).attempt({ severity: 'recoverable' });
    expect(result).toMatchObject({ outcome: 'governed', reason: 'fence-stale-or-revision-conflict' });
    expect(remediation).not.toHaveBeenCalled();
  });

  it('never emits raw store exception text in state-failure audit metadata', async () => {
    const store = new InMemorySelfHealEpisodeStore();
    vi.spyOn(store, 'load').mockImplementation(() => { throw new Error('/private/secret/path: database corrupt'); });
    const d = deps(store);
    const result = await new SelfHealGate(spec(() => ({ outcome: 'healed', evidence: 'repaired' })), d.value).attempt({ severity: 'recoverable' });
    expect(result).toMatchObject({ outcome: 'state-failure', reason: 'store-operation-failed' });
    expect(JSON.stringify(d.value.audit.mock.calls)).not.toContain('/private/secret/path');
  });

  it('counts remediation invocations independently and exhausts at maxAttempts', async () => {
    const remediation = vi.fn(() => ({ outcome: 'not-healed', evidence: 'verification-failed' } as const)); const d = deps(); const gate = new SelfHealGate(spec(remediation), d.value);
    await gate.attempt({ severity: 'recoverable' }); await gate.attempt({ severity: 'recoverable' }); await gate.attempt({ severity: 'recoverable' });
    const exhausted = await gate.attempt({ severity: 'recoverable' });
    expect(remediation).toHaveBeenCalledTimes(3); expect(exhausted.outcome).toBe('exhausted'); expect(d.value.notify).toHaveBeenCalledTimes(1);
  });

  it('honors governor proceed rather than token validity in observe posture', async () => {
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const d = deps(new InMemorySelfHealEpisodeStore(), { consumeToken: vi.fn(() => ({ proceed: true, valid: false, reason: 'token expired' })) });
    const result = await new SelfHealGate(spec(remediation), d.value).attempt({ severity: 'recoverable' });
    expect(result).toMatchObject({ outcome: 'healed', tokenValid: false }); expect(remediation).toHaveBeenCalledTimes(1);
  });

  it('requires a different boot to verify a pending restart and retries a failed request', async () => {
    const store = new InMemorySelfHealEpisodeStore(); const restart = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const d1 = deps(store, { bootId: 'boot-1', requestRestart: restart });
    const gate1 = new SelfHealGate(spec(() => ({ outcome: 'pending-restart', evidence: 'repaired' })), d1.value);
    expect((await gate1.attempt({ severity: 'recoverable' })).reason).toBe('restart-request-failed');
    expect((await gate1.attempt({ severity: 'recoverable', healthy: true })).reason).toBe('restart-requested');
    expect((await gate1.attempt({ severity: 'recoverable', healthy: true })).reason).toBe('restart-awaiting-new-boot');
    const d2 = deps(store, { bootId: 'boot-2', requestRestart: restart });
    expect(await new SelfHealGate(spec(() => ({ outcome: 'not-healed', evidence: 'verification-failed' })), d2.value).attempt({ severity: 'recoverable', healthy: true })).toMatchObject({ outcome: 'healed', reason: 'restart-verified' });
  });

  it('persists CAS revisions across two SQLite store instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-store-')); dirs.push(dir); const db = path.join(dir, 'episodes.db');
    const a = new SqliteSelfHealEpisodeStore(db); const b = new SqliteSelfHealEpisodeStore(db);
    const row = { schemaVersion: 1 as const, key: 'k', revision: 0, status: 'active' as const, startedAt: 1, attempts: 0, nextEligibleAt: 0,
      latch: { schemaVersion: 1 as const, failingSince: null, failures: 0, signaledFor: null }, notices: {}, recoveries: [], restart: null, updatedAt: 1 };
    expect(a.create(row)?.revision).toBe(0);
    expect(a.mutate('k', 0, (r) => ({ ...r, revision: 1, attempts: 1 }))?.attempts).toBe(1);
    expect(b.mutate('k', 0, (r) => ({ ...r, revision: 1, attempts: 1 }))).toBeNull();
    a.close(); b.close();
  });
});
