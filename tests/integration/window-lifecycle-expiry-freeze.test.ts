import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EchoWindowLedgerStore,
  compileWindowSources,
  createLedger,
} from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';

const START = '2026-09-05T20:00:00.000Z';
const CEILING = '2026-09-06T20:00:00.000Z';

function config(project: TempProject): InstarConfig {
  return {
    projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: 'w32-expiry-freeze',
    requestTimeoutMs: 5_000, version: '1.3.1223', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  };
}

function writeEnforcementOff(project: TempProject): void {
  const file = path.join(project.stateDir, 'window-lifecycle', 'enforcement-state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mode: 'off', startedAt: START, expiresAt: '2026-09-20T20:00:00.000Z' })}\n`);
}

function writeW32Ledger(project: TempProject) {
  writeEnforcementOff(project);
  const tenetsPath = path.join(project.dir, '.instar', 'TENETS.md');
  const charterPath = path.join(project.stateDir, 'w32', 'WINDOW-32-CHARTER.md');
  fs.mkdirSync(path.dirname(tenetsPath), { recursive: true });
  fs.mkdirSync(path.dirname(charterPath), { recursive: true });
  fs.copyFileSync(path.resolve('tests/fixtures/window-32-tenets.md'), tenetsPath);
  fs.copyFileSync(path.resolve('tests/fixtures/window-32-approved-charter.md'), charterPath);
  const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath, charterPath, now: START });
  const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled });
  ledger.state = 'active_start';
  ledger.admission = { admitted: true, evaluatedAt: START, snapshotDigest: 'a'.repeat(64) };
  new EchoWindowLedgerStore(project.stateDir).save(ledger);
  return ledger;
}

describe('W32 lifecycle expiry freeze integration', () => {
  const cleanups: Array<() => void> = [];
  const servers: AgentServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.stop()));
    cleanups.splice(0).forEach(cleanup => cleanup());
  });

  it('freezes only after every other close fact passes, then mints the freeze receipt and closes without a soak', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    writeEnforcementOff(project);
    const sourceHash = 'b'.repeat(64);
    const freezeDuty: any = {
      id: 'w32.close.expiry-freeze', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32',
      sourceSpans: [{ source: '/fixture/WINDOW-32-CHARTER.md', hash: sourceHash, byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 }],
      statement: 'Freeze recurrence and revoke active.', phase: 'close', coreDuty: true, waiverPolicy: 'non-waivable', responsibleRole: 'echo',
      deadline: { dueAt: CEILING, graceMs: 0 }, predicate: { recurring: false, requiredAuthority: 'deterministic-replay' },
      evidencePolicy: { requiredAuthority: 'deterministic-replay' }, executorBinding: { kind: 'unassigned', executorId: '', owner: '', registryCoordinates: '', enabled: false, dryRun: true },
      failureAction: 'fail-close', status: 'pending', evidence: [], lastEvaluatedAt: null,
    };
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [freezeDuty], catalogProfile: 'w32-approved-a204c07d', compiledAt: START, charterCeilingAt: CEILING } });
    ledger.state = 'close_due'; ledger.recurrenceFrozenAt = '2026-09-05T22:00:00.000Z';
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', output: { admitted: true } } as any);
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    let freezeMutations = 0;
    const predicates = { 'executor-bound-running': { ok: true, observed: 'running' } };
    let liveness: any = { windowId: 'w32', lifecycleRunId: ledger.lifecycleRunId, autonomousRunId: 'run-w32', status: 'active', predicates };
    const authority = {
      status: () => ({ enabled: true, dryRun: false, config: {}, state: liveness }), tick: async () => liveness,
      freeze: (reason: string, status: 'closed' | 'failed' = 'closed') => {
        if (!liveness.finalSnapshot) {
          freezeMutations++;
          liveness = { ...liveness, status, legacyProjection: { status, at: START, receipt: 'projection:closed' }, finalSnapshot: { frozenAt: START, reason, statusBeforeFreeze: 'active', predicateDigest: crypto.createHash('sha256').update(JSON.stringify(predicates)).digest('hex'), exitProof: {} } };
        }
        return liveness;
      },
    };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => START, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    const auth = (call: request.Test) => call.set('Authorization', 'Bearer w32-expiry-freeze');
    const closed = await auth(request(server.getApp()).post('/window-lifecycle/transition')).send({ agentId: 'echo', scope: 'echo-window-lifecycle', target: 'delivered_pending_post_live' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.state).toBe('closed_clean');
    expect(closed.body.obligations[0]).toMatchObject({ id: 'w32.close.expiry-freeze', status: 'satisfied', evidence: [{ authority: 'deterministic-replay', producer: 'server:window-run-liveness-authority' }] });
    expect(JSON.parse(closed.body.obligations[0].evidence[0].verifiedPayload)).toMatchObject({ zeroPostCeilingDuties: true, livenessStatus: 'closed', recurrenceFrozenAt: ledger.recurrenceFrozenAt });
    expect(freezeMutations).toBe(1);
  });

  it('does not freeze final-close liveness while any non-freeze duty remains unresolved', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    const ledger = writeW32Ledger(project);
    ledger.state = 'close_due'; ledger.recurrenceFrozenAt = '2026-09-05T22:00:00.000Z';
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    let freezeCalls = 0;
    const authority = {
      status: () => ({ enabled: true, dryRun: false, config: {}, state: { windowId: 'w32', lifecycleRunId: ledger.lifecycleRunId, status: 'active' } }), tick: async () => null,
      freeze: () => { freezeCalls++; throw new Error('must not freeze before preflight'); },
    };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => START, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    const refused = await request(server.getApp()).post('/window-lifecycle/transition').set('Authorization', 'Bearer w32-expiry-freeze').send({ agentId: 'echo', scope: 'echo-window-lifecycle', target: 'delivered_pending_post_live' }).expect(409);
    expect(refused.body.error).toContain('w32-final-close-preflight-refused');
    expect(freezeCalls).toBe(0);
    expect(new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!.state).toBe('close_due');
  });

  it('refuses clean close when the matching liveness authority already has a failed final snapshot', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    writeEnforcementOff(project);
    const freezeDuty: any = {
      id: 'w32.close.expiry-freeze', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32',
      sourceSpans: [{ source: '/fixture/WINDOW-32-CHARTER.md', hash: 'b'.repeat(64), byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 }],
      statement: 'Freeze recurrence and revoke active.', phase: 'close', coreDuty: true, waiverPolicy: 'non-waivable', responsibleRole: 'echo',
      deadline: { dueAt: CEILING, graceMs: 0 }, predicate: { recurring: false, requiredAuthority: 'deterministic-replay' },
      evidencePolicy: { requiredAuthority: 'deterministic-replay' }, executorBinding: { kind: 'unassigned', executorId: '', owner: '', registryCoordinates: '', enabled: false, dryRun: true },
      failureAction: 'fail-close', status: 'pending', evidence: [], lastEvaluatedAt: null,
    };
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [freezeDuty], catalogProfile: 'w32-approved-a204c07d', compiledAt: START, charterCeilingAt: CEILING } });
    ledger.state = 'close_due'; ledger.recurrenceFrozenAt = '2026-09-05T22:00:00.000Z';
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', output: { admitted: true } } as any);
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    const failed = {
      windowId: 'w32', lifecycleRunId: ledger.lifecycleRunId, autonomousRunId: 'run-w32', status: 'failed', predicates: {},
      legacyProjection: { status: 'failed', at: START, receipt: 'projection:failed' },
      finalSnapshot: { frozenAt: START, reason: 'liveness-failed', statusBeforeFreeze: 'active', predicateDigest: crypto.createHash('sha256').update('{}').digest('hex'), exitProof: {} },
    };
    const authority = { status: () => ({ enabled: true, dryRun: false, config: {}, state: failed }), tick: async () => failed, freeze: () => failed };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => START, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    const refused = await request(server.getApp()).post('/window-lifecycle/transition').set('Authorization', 'Bearer w32-expiry-freeze').send({ agentId: 'echo', scope: 'echo-window-lifecycle', target: 'delivered_pending_post_live' }).expect(409);
    expect(refused.body.error).toBe('w32-enforcing-liveness-authority-required');
    expect(new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!.state).toBe('close_due');
  });

  it('does not compose legacy ordinary close or terminal sync with W32 run-liveness freeze', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    writeEnforcementOff(project);
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w31', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [], catalogProfile: 'legacy-w28-w31', compiledAt: START, charterCeilingAt: CEILING } });
    ledger.state = 'delivered_pending_post_live';
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w31', output: { admitted: true } } as any);
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    let freezeCalls = 0;
    const authority = {
      status: () => ({ enabled: true, dryRun: false, config: {}, state: { windowId: 'w31', lifecycleRunId: ledger.lifecycleRunId, status: 'active' } }),
      tick: async () => null,
      freeze: () => { freezeCalls++; throw new Error('legacy terminal state must not freeze W32 liveness'); },
    };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => START, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    const closed = await request(server.getApp()).post('/window-lifecycle/transition').set('Authorization', 'Bearer w32-expiry-freeze').send({ agentId: 'echo', scope: 'echo-window-lifecycle', target: 'closed_clean' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(freezeCalls).toBe(0);
    expect(new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!.state).toBe('closed_clean');
    await server.stop(); servers.splice(servers.indexOf(server), 1);
    const restarted = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => START, windowRunLivenessAuthority: authority as never });
    servers.push(restarted); await restarted.start();
    expect(freezeCalls).toBe(0);
  });

  it('expires exact enforcing W32 before ledger persistence and remains terminal across ticks and restart', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    const original = writeW32Ledger(project);
    const freezes: Array<{ reason: string; status: string }> = [];
    let liveness: any = {
      windowId: 'w32', lifecycleRunId: original.lifecycleRunId, autonomousRunId: 'run-w32', status: 'active',
      predicates: {}, transitions: [], executorBindingReceipts: [], audit: { entries: [], headDigest: null },
    };
    const authority = {
      status: () => ({ enabled: true, dryRun: false, config: { heartbeatMaxAgeMs: 60_000, workEvidenceMaxAgeMs: 60_000, recoveryCeilingMs: 60_000 }, state: liveness }),
      tick: async () => liveness,
      freeze: (reason: string, status: 'closed' | 'failed' = 'closed') => {
        if (!liveness.finalSnapshot) {
          freezes.push({ reason, status });
          liveness = {
            ...liveness, status, legacyProjection: { status, at: CEILING, receipt: `projection:${status}` },
            finalSnapshot: { frozenAt: CEILING, reason, statusBeforeFreeze: liveness.status, predicateDigest: 'a'.repeat(64), exitProof: {} },
          };
        }
        return liveness;
      },
    };
    const first = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => CEILING, windowRunLivenessAuthority: authority as never });
    servers.push(first); await first.start();

    const store = new EchoWindowLedgerStore(project.stateDir);
    const expired = store.load('echo', 'echo-window-lifecycle')!;
    expect(expired.state).toBe('closed_failed');
    expect(expired.recurrenceFrozenAt).toBe(expired.windowCeilingAt);
    expect(expired.obligations.filter(duty => duty.id.includes('@')).every(duty => Date.parse(duty.deadline.dueAt) <= Date.parse(expired.windowCeilingAt!))).toBe(true);
    expect(freezes).toEqual([{ reason: 'window-ceiling-expired', status: 'failed' }]);

    const auth = (call: request.Test) => call.set('Authorization', 'Bearer w32-expiry-freeze');
    const repeated = await auth(request(first.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' }).expect(409);
    expect(repeated.body.ledger.compiledObligationIds).toEqual(expired.compiledObligationIds);
    expect(freezes).toHaveLength(1);

    await first.stop(); servers.splice(servers.indexOf(first), 1);
    const restarted = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => '2026-09-07T20:00:00.000Z', windowRunLivenessAuthority: authority as never });
    servers.push(restarted); await restarted.start();
    expect(store.load('echo', 'echo-window-lifecycle')).toEqual(expired);
    expect(freezes).toHaveLength(1);
    expect(liveness.finalSnapshot.reason).toBe('window-ceiling-expired');
  });

  it('leaves the ledger nonterminal when active-projection revocation throws', async () => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    const ledger = writeW32Ledger(project);
    const authority = {
      status: () => ({ enabled: true, dryRun: false, config: {}, state: { windowId: 'w32', lifecycleRunId: ledger.lifecycleRunId, status: 'active' } }),
      tick: async () => null,
      freeze: () => { throw new Error('projection-revocation-failed'); },
    };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => CEILING, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    const after = new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!;
    expect(after.state).toBe('active_start');
    expect(after.recurrenceFrozenAt).toBeUndefined();
  });

  it.each([
    ['legacy profile', 'legacy-w28-w31', false],
    ['dry-run W32', 'w32-approved-a204c07d', true],
  ] as const)('does not terminally mutate %s at the W32 ceiling boundary', async (_label, catalogProfile, dryRun) => {
    const project = createTempProject(); cleanups.push(project.cleanup);
    const ledger = writeW32Ledger(project);
    ledger.catalogProfile = catalogProfile;
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    let freezeCalls = 0;
    const authority = {
      status: () => ({ enabled: true, dryRun, config: {}, state: { windowId: 'w32', lifecycleRunId: ledger.lifecycleRunId, status: 'active' } }),
      tick: async () => null,
      freeze: () => { freezeCalls++; throw new Error('must not freeze'); },
    };
    const server = new AgentServer({ config: config(project), sessionManager: createMockSessionManager() as never, state: project.state, windowLifecycleNow: () => CEILING, windowRunLivenessAuthority: authority as never });
    servers.push(server); await server.start();
    expect(new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!.state).not.toBe('closed_failed');
    expect(freezeCalls).toBe(0);
  });
});
