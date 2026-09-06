import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EchoWindowLedgerStore, type EvidenceAuthority, type LedgerDocument, type Obligation } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';

const BASE = Date.parse('2026-09-05T20:00:00.000Z');
const NOW = new Date(BASE + 3 * 60 * 60_000).toISOString();
const REPORT_DUTY_DUE = new Date(Date.parse(NOW) - 2 * 60_000).toISOString();

function duty(id: string, status: Obligation['status'] = 'open-unexecuted', authority: EvidenceAuthority = 'deterministic-replay'): Obligation {
  return {
    id, agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', sourceSpans: [], statement: id,
    phase: id.includes('.close.') ? 'close' : 'continuous', coreDuty: true, waiverPolicy: 'non-waivable', responsibleRole: 'echo',
    deadline: { dueAt: NOW, graceMs: 15 * 60_000 }, predicate: { requiredAuthority: authority },
    evidencePolicy: { requiredAuthority: authority },
    executorBinding: { kind: 'deterministic', executorId: `executor:${id}`, owner: 'server', registryCoordinates: `obligation:${id}`, enabled: true, dryRun: false },
    failureAction: 'fail-close', status, evidence: [], lastEvaluatedAt: null,
  };
}

describe('W32 cadence receipts feed lifecycle close proofs', () => {
  const token = 'w32-cadence-proof';
  let project: TempProject;
  let server: AgentServer;
  let livenessDryRun = true;
  let cadenceDryRun = true;
  const history: any[] = [];

  beforeAll(async () => {
    project = createTempProject();
    const laneIds = [
      'w32.continuous.missing-predicate-at-risk', 'w32.continuous.bounded-recovery', 'w32.continuous.registration-not-liveness',
      'w32.close.three-advancing-intervals', 'w32.close.induced-executor-loss', 'w32.close.resume-once-or-fail-loudly',
      'w32.close.all-reports-delivered', 'w32.close.zero-false-active', 'w32.close.no-separate-soak', 'w32.close.immediate-on-pass',
    ];
    const sourcePath = path.join(project.dir, 'w32-proof-source.md');
    const sourceBytes = '# W32 deterministic proof source\n'; fs.writeFileSync(sourcePath, sourceBytes);
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const reportDutyId = `cadence.report.3h@${REPORT_DUTY_DUE}`;
    const reportText = 'W32 synthesis summary: Progress includes three advancing durable receipt intervals and one exact recovery. Blockers: none observed. Next: preflight closure immediately with no separate soak. W32 synthesis receipt: report-1';
    const reportRow = { messageId: 9001, topicId: 36966, text: reportText, fromUser: false, timestamp: NOW, sessionName: 'echo-observer', provenance: 'automation', authorship: 'agent-outbound', forwarded: false };
    const observerRow = { messageId: 9002, topicId: 43003, text: JSON.stringify({ obligationId: 'w32.close.independent-loss-verification', verdict: 'pass', sourceHashes: [sourceHash], visibleTopicId: 43003, independentlyVerified: true }), fromUser: false, timestamp: NOW, sessionName: 'observer-2-session', provenance: 'agent', authorship: 'agent-outbound', forwarded: false };
    history.push(reportRow, observerRow);
    fs.writeFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(reportRow)}\n${JSON.stringify(observerRow)}\n`);
    const independent = duty('w32.close.independent-loss-verification', 'satisfied', 'live-requeried-message');
    independent.responsibleRole = 'observer-2'; independent.executorBinding.owner = 'session:observer-2-session';
    independent.evidence.push({ authority: 'live-requeried-message', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', obligationId: independent.id, sourceHashes: [], producer: 'session:observer-2-session', timestamp: NOW, nonce: 'observer-proof', canonicalPayloadHash: createHash('sha256').update(observerRow.text).digest('hex'), verifierPassed: true, verifiedPayload: observerRow.text, nativeCoordinates: { topicId: 43003, messageId: 9002 } });
    const reportDuty = duty(reportDutyId, 'open-unexecuted', 'live-requeried-message'); reportDuty.phase = 'cadence'; reportDuty.predicate.recurring = true; reportDuty.deadline.dueAt = REPORT_DUTY_DUE;
    const obligations = [...laneIds.map(id => duty(id)), independent, reportDuty];
    const sourceSpan = { source: sourcePath, hash: sourceHash, byteStart: 0, byteEnd: Buffer.byteLength(sourceBytes), lineStart: 1, lineEnd: 1 };
    for (const obligation of obligations) { obligation.sourceSpans = [sourceSpan]; for (const evidence of obligation.evidence) evidence.sourceHashes = [sourceHash]; }
    const ids = obligations.map(item => item.id);
    const ledger: LedgerDocument = {
      version: 1, lifecycleRunId: '00000000-0000-4000-8000-000000000032', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', state: 'active_mid_satisfied',
      sourceHashes: { [sourcePath]: sourceHash }, catalogProfile: 'w32-approved-a204c07d', windowStartedAt: new Date(BASE).toISOString(), windowCeilingAt: new Date(BASE + 24 * 60 * 60_000).toISOString(),
      compiledObligationIds: ids, obligations, usedNonces: [], nativeEvaluations: [], waivers: [],
    };
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    const predicates = {
      'executor-bound-running': { ok: true, observed: 'executor-2:running' }, 'heartbeat-fresh': { ok: true, observed: NOW },
      'delivery-reachable': { ok: true, observed: 'reachable' }, 'durable-work-advanced': { ok: true, observed: `receipt-3:3:${NOW}` },
      'lifecycle-admitted-unexpired': { ok: true, observed: 'lifecycle-w32:active_mid_satisfied:unexpired' },
    };
    const liveness: any = {
      windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: '00000000-0000-4000-8000-000000000032', executorId: 'executor-2', status: 'active',
      registeredAt: new Date(BASE - 1_000).toISOString(), activatedAt: new Date(BASE).toISOString(), predicates,
      audit: { headDigest: 'audit-head', entries: [{ sequence: 1, kind: 'sample', at: new Date(BASE).toISOString(), status: 'active', predicates, previousDigest: null, entryDigest: 'sample-1' }] },
      transitions: [
        { receiptId: 'activation', at: new Date(BASE).toISOString(), from: 'preparing', to: 'active', reason: 'all-five-predicates-green', predicateDigest: 'green' },
        { receiptId: 'loss', at: new Date(BASE + 31 * 60_000).toISOString(), from: 'active', to: 'at-risk', reason: 'predicate-missing:executor-bound-running', predicateDigest: 'red' },
        { receiptId: 'recovered', at: new Date(BASE + 32 * 60_000).toISOString(), from: 'at-risk', to: 'active', reason: 'recovery-verified', predicateDigest: 'green', recoveryAttemptId: 'attempt-1' },
      ],
      recoveryAttempt: { attemptId: 'attempt-1', number: 1, requestedAt: new Date(BASE + 31 * 60_000).toISOString(), deadlineAt: new Date(BASE + 46 * 60_000).toISOString(), completedAt: new Date(BASE + 32 * 60_000).toISOString(), missingPredicates: ['executor-bound-running'], outcome: 'succeeded', requestedTaskRef: 'autonomous:run-w32:2', resumedTaskRef: 'autonomous:run-w32:2' },
    };
    const intervals = [1, 2, 3].map(number => ({ number, dueAt: new Date(BASE + number * 30 * 60_000).toISOString(), evaluatedAt: new Date(BASE + number * 30 * 60_000).toISOString(), outcome: 'passed', workReceiptId: `receipt-${number}`, workSequence: number, workObservedAt: new Date(BASE + number * 30 * 60_000 - 1_000).toISOString() }));
    const cadence: any = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: '00000000-0000-4000-8000-000000000032', executorId: 'executor-2', status: 'running', startedAt: new Date(BASE).toISOString(), nextReceiptDueAt: new Date(BASE + 2 * 60 * 60_000).toISOString(), nextReportDueAt: new Date(BASE + 6 * 60 * 60_000).toISOString(), lastReceiptedSequence: 3, intervals, checkpoints: [], reports: [{ reportId: 'report-1', dueAt: NOW, attemptedAt: NOW, status: 'delivered', messageId: 9001, deliveredAt: NOW }] };
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, requestTimeoutMs: 5000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 }, scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    const sessions = createMockSessionManager();
    sessions._sessions.push({ id: 'observer-2', name: 'observer-2', status: 'running', tmuxSession: 'observer-2-session', startedAt: new Date(BASE).toISOString(), claudeSessionId: 'observer-2-epoch' } as never);
    server = new AgentServer({ config, sessionManager: sessions as never, state: project.state,
      commitmentTracker: { getAll: () => [{ id: 'executor:w32.close.independent-loss-verification', externalKey: 'w32.close.independent-loss-verification', beaconEnabled: true, createdAt: new Date(BASE).toISOString(), boundBy: 'session:observer-2-session', sessionEpoch: 'observer-2-epoch', status: 'pending', topicId: 43003, lastHeartbeatAt: NOW, nextUpdateDueAt: NOW }], getActive: () => [] } as never,
      telegram: { getTopicHistory: (topicId: number) => history.filter(item => item.topicId === topicId), getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }), sendToTopic: async () => ({ messageId: 9999 }) } as never,
      windowLifecycleNow: () => NOW,
      windowRunLivenessAuthority: { status: () => ({ enabled: true, dryRun: livenessDryRun, config: {}, state: liveness }), tick: async () => liveness } as never,
      windowRunCadenceExecutor: { status: () => ({ enabled: true, dryRun: cadenceDryRun, config: { receiptIntervalMs: 30 * 60_000, reportIntervalMs: 3 * 60 * 60_000, checkpointLeadMs: 5 * 60_000, receiptGraceMs: 5 * 60_000 }, state: cadence }), tick: async () => cadence } as never,
    });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });

  it('mints every Lane B deterministic receipt from liveness/cadence authorities', async () => {
    const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo');
    const independent = await auth(request(server.getApp()).post('/window-lifecycle/evidence')).send({ agentId: 'echo', scope: 'echo-window-lifecycle', obligationId: 'w32.close.independent-loss-verification', topicId: 43003, messageId: 9002, authority: 'live-requeried-message' });
    expect(independent.status, JSON.stringify(independent.body)).toBe(201);
    await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' });
    let ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    expect(ledger.obligations.filter((item: any) => /^w32\.(?:continuous|close)\./.test(item.id) && item.id !== 'w32.close.independent-loss-verification').every((item: any) => item.evidence.length === 0)).toBe(true);

    livenessDryRun = false; cadenceDryRun = false;
    for (let index = 0; index < 4; index++) await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' });
    ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    const laneB = ledger.obligations.filter((item: any) => /^w32\.(?:continuous|close)\./.test(item.id) && item.id !== 'w32.close.independent-loss-verification');
    expect(laneB.every((item: any) => item.status === 'satisfied' && item.evidence.some((row: any) => row.producer === 'server:window-deterministic-replay')), JSON.stringify(ledger.obligations.map((item: any) => ({ id: item.id, status: item.status, evidence: item.evidence.map((row: any) => row.producer) })))).toBe(true);
    expect(ledger.obligations.find((item: any) => item.id === `cadence.report.3h@${REPORT_DUTY_DUE}`)).toMatchObject({ status: 'satisfied', evidence: [{ producer: 'server:window-run-cadence-executor', nativeCoordinates: { topicId: 36966, messageId: 9001 } }] });

    history.splice(history.findIndex(item => item.messageId === 9001), 1);
    for (let index = 0; index < 3; index++) await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' });
    ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    expect(ledger.obligations.find((item: any) => item.id === `cadence.report.3h@${REPORT_DUTY_DUE}`).status).toBe('unknown');
    expect(ledger.obligations.find((item: any) => item.id === 'w32.close.all-reports-delivered').status).toBe('unknown');

    history.push({ messageId: 9001, topicId: 36966, text: 'W32 synthesis summary: Progress includes three advancing durable receipt intervals and one exact recovery. Blockers: none observed. Next: preflight closure immediately with no separate soak. W32 synthesis receipt: report-1', fromUser: false, timestamp: NOW, sessionName: 'echo-observer', provenance: 'automation', authorship: 'agent-outbound', forwarded: false });
    for (let index = 0; index < 3; index++) await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' });
    ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    expect(ledger.obligations.find((item: any) => item.id === `cadence.report.3h@${REPORT_DUTY_DUE}`).status).toBe('satisfied');
    expect(ledger.obligations.find((item: any) => item.id === 'w32.close.all-reports-delivered').status).toBe('satisfied');
  });
});
