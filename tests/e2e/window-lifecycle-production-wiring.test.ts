import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { minimumWindowDutyFixture } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';
import { validAdmissionPackage, writeAdmissionStore } from '../helpers/betweenWindowAdmissionFixture.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage, verifyMessage } from '../../src/core/agentSignatureProvenance.js';

const BASE = '2026-08-28T18:00:00.000Z';
const MID = '2026-08-29T06:00:00.000Z';
const CLOSE = '2026-08-29T18:00:00.000Z';
const PLAN_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const PLAN_VERSION = '2026-08-28T17:00:00.000Z';
const IDENTITY = generateIdentityKeyPair();
const PUBLIC_KEY = IDENTITY.publicKey;
const FINGERPRINT = PUBLIC_KEY.toString('hex').slice(0, 32);

describe('Window lifecycle production wiring', () => {
  const token = 'window-lifecycle-e2e';
  let project: TempProject;
  let server: AgentServer;
  let clock = BASE;
  let currentWindowId = 'w28';
  let nextMessageId = 80_000;
  let telegramProfileId: string | null = 'justin-telegram';
  const history: any[] = [];
  const commitments: any[] = [];
  const workerRecords: any[] = [];
  const sentMessages: Array<{ topicId: number; text: string }> = [];

  beforeAll(async () => {
    project = createTempProject();
    fs.mkdirSync(path.join(project.dir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(project.stateDir, 'window-lifecycle'), { recursive: true });
    const admissionStore = writeAdmissionStore(project.stateDir);
    fs.appendFileSync(admissionStore, '\n');
    const source = `# Window duties\nCanonical plan ${PLAN_ID}\nNamed Lane A and Lane B.\nSignature fingerprint ${FINGERPRINT}\n${minimumWindowDutyFixture()}\n`;
    fs.writeFileSync(path.join(project.dir, '.instar', 'TENETS.md'), source);
    fs.mkdirSync(path.join(project.stateDir, 'w28'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'w28', 'WINDOW-28-CHARTER.md'), source);
    fs.mkdirSync(path.join(project.stateDir, 'synthetic-w28'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'synthetic-w28', 'WINDOW-synthetic-w28-CHARTER.md'), source);
    fs.writeFileSync(path.join(project.stateDir, 'identity.json'), JSON.stringify({ publicKey: PUBLIC_KEY.toString('base64'), privateKey: IDENTITY.privateKey.toString('base64'), privateKeyEncryption: 'none' }));
    for (const [index, lane, machine] of [[1, 'A', 'studio'], [2, 'B', 'laptop']] as const) { const transcriptPath = path.join(project.stateDir, `codey-${index}.jsonl`); fs.writeFileSync(transcriptPath, JSON.stringify({ work: `implemented lane ${lane}` })); workerRecords.push({ agentId: `codey-${index}`, agentType: `worker-codey lane-${lane} machine-${machine}`, sessionId: `worker-session-${index}`, startedAt: BASE, stoppedAt: BASE, transcriptPath, lastMessage: `lane ${lane} landed` }); }
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token,
      requestTimeoutMs: 5000, version: '1.3.1209',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    const sessions = createMockSessionManager();
    (sessions as any).clearInjectionTracker = () => {};
    sessions._sessions.push({ id: 'live', name: 'echo-worker', status: 'running', tmuxSession: 'live', startedAt: BASE, claudeSessionId: 'live-session' } as any);
    fs.mkdirSync(path.join(project.stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'autonomous', 'active-36966.json'), JSON.stringify({ topic: 36966, windowId: 'w28', status: 'running' }));
        const telegram = { getTopicHistory: (topicId: number) => history.filter(row => row.topicId === topicId), sendToTopic: async (topicId: number, text: string) => { sentMessages.push({ topicId, text }); const messageId = nextMessageId++; history.push({ messageId, topicId, text, fromUser: false, timestamp: clock, sessionName: 'echo-session', authorship: 'agent-outbound', forwarded: false } as any); return { messageId }; } };
    const watchdogObservation = (observedAt: string) => { const rows = sessions.listRunningSessions().map((session: any) => ({ name: session.tmuxSession, outputObserved: true, escalationActive: false, decisionEvaluated: true, decisionEvaluatedAt: observedAt })); const authorityEpoch = 'w28-test-epoch'; const authorityProof = crypto.createHash('sha256').update(JSON.stringify({ observedAt, authorityEpoch, rows })).digest('hex'); return { observedAt, authorityEpoch, pollRevision: 1, authorityProof, sessions: rows }; };
    const viewer = { get: (id: string) => id === PLAN_ID ? { id, createdAt: PLAN_VERSION, updatedAt: PLAN_VERSION, title: 'Window plan', markdown: `# Plan\nNode-ID: current-work\nCharter-ID: ${currentWindowId}\nLeaf-to-root: current-work > ${currentWindowId} > root` } : null };
    server = new AgentServer({
      config, sessionManager: sessions as any, state: project.state, telegram: telegram as any, viewer: viewer as any,
      commitmentTracker: { getAll: () => commitments, getActive: () => commitments.filter(c => c.status === 'pending') } as any,
      subagentTracker: { listSessions: () => ['orchestrator'], getSessionRecords: () => workerRecords } as any,
      listPoolMachines: () => [{ machineId: 'studio' }, { machineId: 'laptop' }],
      playwrightRegistry: () => ({ resolve: (service: string) => service === 'telegram' && telegramProfileId ? { profile: { id: telegramProfileId }, dirExists: true } : { profile: null } }) as any,
      watchdog: { isEnabled: () => true, inspectSessionsForStall: watchdogObservation, verifyStallInspection: (observation: any) => observation.authorityEpoch === 'w28-test-epoch' && observation.authorityProof === crypto.createHash('sha256').update(JSON.stringify({ observedAt: observation.observedAt, authorityEpoch: observation.authorityEpoch, rows: observation.sessions })).digest('hex') } as any,
      windowLifecycleNow: () => clock,
    });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);
  const body = { agentId: 'echo', scope: 'echo-window-lifecycle' };

  function syncCommitments(obligations: any[]): void {
    for (const obligation of obligations) {
      let commitment = commitments.find(item => item.externalKey === obligation.id);
      if (!commitment) {
        commitment = { id: `CMT-${commitments.length + 1}`, externalKey: obligation.id, beaconEnabled: true, createdAt: BASE, topicId: 36966, boundBy: `session:${obligation.responsibleRole}-session`, sessionEpoch: 'live-session', beaconSuppressed: false, beaconPaused: false };
        commitments.push(commitment);
      }
      const completionRequired = (obligation.predicate.recurring === true || obligation.id.includes('@'))
        && Date.parse(obligation.deadline.dueAt) <= Date.parse(clock);
      Object.assign(commitment, {
        status: completionRequired ? 'delivered' : 'pending', resolvedAt: completionRequired ? obligation.deadline.dueAt : undefined,
        deliveryMessageId: completionRequired ? `delivery-${commitment.id}` : undefined,
        lastHeartbeatAt: clock, nextUpdateDueAt: obligation.deadline.dueAt, checkInAt: obligation.eligibleAt,
      });
    }
  }

  function proofText(obligation: any): string {
    if (/reaffirmation/.test(obligation.id)) return fs.readFileSync(obligation.sourceSpans[0].source, 'utf8');
    if (/^cadence\.report\.3h@/.test(obligation.id)) return 'Window synthesis summary: progress landed across the active lifecycle duties and evidence authorities. Blockers: none currently observed. Next: continue the named lanes, inspect cadence health, and surface any new risk to the operator.';
    const artifactPath = path.join(project.stateDir, 'window-lifecycle', 'saved-artifact.md');
    if (!fs.existsSync(artifactPath)) fs.writeFileSync(artifactPath, '# Saved before words\n');
    return JSON.stringify({
      obligationId: obligation.id, verdict: 'pass', sourceHashes: obligation.sourceSpans.map((span: any) => span.hash),
      ...(obligation.predicate.expected ?? {}), planNodeId: 'current-work', charterIncluded: true, leafToRoot: ['current-work', currentWindowId, 'root'], planVersionAtOutcome: PLAN_VERSION,
      visibleTopicId: /80-20|scope-drift/.test(obligation.id) ? 36966 : 43003,
      signatureVerified: true, principalRiskCleared: true, counts: [{ value: 1, items: ['derived-item'] }],
      artifactPath, artifactHash: crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'),
      reviewed: true, debt: { owner: 'echo', status: 'open' }, expiryVerified: true, consumerObserved: true, postLivePassed: true,
    });
  }

  async function addManualEvidence(obligation: any): Promise<void> {
    let text = proofText(obligation);
    const signedOperatorPath = /^continuous\.telegram\.(?:send-path-classified|signature-verified|act-as-principal-guard)$/.test(obligation.id);
    const topicId = /^cadence\.report\.3h@/.test(obligation.id) ? 36966 : obligation.responsibleRole.startsWith('observer-') ? 43003 : 36966;
    if (signedOperatorPath) { const unsigned = { messageId: nextMessageId++, topicId, text, fromUser: false, timestamp: clock, sessionName: `${obligation.responsibleRole}-session`, provenance: 'agent', authorship: 'agent-outbound', forwarded: false }; history.push(unsigned); fs.appendFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(unsigned)}\n`); await auth(request(server.getApp()).post('/window-lifecycle/evidence')).send({ ...body, obligationId: obligation.id, topicId, messageId: unsigned.messageId, authority: obligation.evidencePolicy.requiredAuthority }).expect(409); }
    if (/^cadence\.report\.3h@/.test(obligation.id)) { const nonSynthesis = { messageId: nextMessageId++, topicId, text: 'This is a long generic message that contains enough characters to defeat a length-only check but has no required report structure at all.', fromUser: false, timestamp: clock, sessionName: `${obligation.responsibleRole}-session`, provenance: 'agent', authorship: 'agent-outbound', forwarded: false }; history.push(nonSynthesis); fs.appendFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(nonSynthesis)}\n`); await auth(request(server.getApp()).post('/window-lifecycle/evidence')).send({ ...body, obligationId: obligation.id, topicId, messageId: nonSynthesis.messageId, authority: obligation.evidencePolicy.requiredAuthority }).expect(409); }
    if (/plan-(?:input|position|outcome)/.test(obligation.id)) { for (const invalid of [{ planNodeId: 'wrong-node', charterIncluded: true, leafToRoot: ['wrong-node', 'root'] }, { planNodeId: 'current-work', charterIncluded: false, leafToRoot: ['current-work', 'w28', 'root'] }, { planNodeId: 'Plan', charterIncluded: true, leafToRoot: ['Plan', 'root'] }, { planNodeId: '#', charterIncluded: true, leafToRoot: ['#', 'root'] }]) { const bad = { messageId: nextMessageId++, topicId, text: JSON.stringify({ obligationId: obligation.id, verdict: 'pass', sourceHashes: obligation.sourceSpans.map((span: any) => span.hash), ...(obligation.predicate.expected ?? {}), ...invalid }), fromUser: false, timestamp: clock, sessionName: `${obligation.responsibleRole}-session`, provenance: 'agent', authorship: 'agent-outbound', forwarded: false }; history.push(bad); fs.appendFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(bad)}\n`); await auth(request(server.getApp()).post('/window-lifecycle/evidence')).send({ ...body, obligationId: obligation.id, topicId, messageId: bad.messageId, authority: obligation.evidencePolicy.requiredAuthority }).expect(409); } }
    if (signedOperatorPath) text = signMessage({ agentId: 'echo', topicId, body: text, privateKey: IDENTITY.privateKey, timestamp: Math.floor(Date.parse(clock) / 1000), nonce: `w28${nextMessageId}` }).text;
    const row = { messageId: nextMessageId++, topicId, text, fromUser: false, timestamp: clock, sessionName: `${obligation.responsibleRole}-session`, provenance: 'agent', authorship: 'agent-outbound', forwarded: false };
    history.push(row);
    fs.appendFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(row)}\n`);
    const added = await auth(request(server.getApp()).post('/window-lifecycle/evidence')).send({ ...body, obligationId: obligation.id, topicId, messageId: row.messageId, authority: obligation.evidencePolicy.requiredAuthority });
    expect(added.status, `${obligation.id}: ${JSON.stringify(added.body)}`).toBe(201);
  }

  async function satisfyEligible(phases: string[]): Promise<any> {
    let ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    syncCommitments(ledger.obligations);
    await auth(request(server.getApp()).post('/window-lifecycle/tick')).send(body);
    ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
    syncCommitments(ledger.obligations);
    const manual = ledger.obligations.filter((obligation: any) => phases.includes(obligation.phase)
      && !['runtime-registry-proof', 'deterministic-replay', 'native-local-store-presence'].includes(obligation.evidencePolicy.requiredAuthority)
      && obligation.status !== 'satisfied');
    for (const obligation of manual) await addManualEvidence(obligation);
    await auth(request(server.getApp()).post('/window-lifecycle/tick')).send(body);
    await auth(request(server.getApp()).post('/window-lifecycle/tick')).send(body);
    return (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
  }

  async function advanceCadenceTo(target: string): Promise<void> {
    while (Date.parse(clock) < Date.parse(target)) {
      clock = new Date(Math.min(Date.parse(clock) + 30 * 60_000, Date.parse(target))).toISOString();
      let ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
      syncCommitments(ledger.obligations);
      await auth(request(server.getApp()).post('/window-lifecycle/tick')).send(body);
      ledger = (await auth(request(server.getApp()).get('/window-lifecycle')).expect(200)).body.ledger;
      const dueReports = ledger.obligations.filter((obligation: any) => /^cadence\.report\.3h@/.test(obligation.id) && Date.parse(obligation.deadline.dueAt) <= Date.parse(clock) && !obligation.evidence.some((evidence: any) => evidence.verifierPassed));
      for (const report of dueReports) await addManualEvidence(report);
      await auth(request(server.getApp()).post('/window-lifecycle/tick')).send(body);
    }
  }

  it('traverses real admission, mid/cadence, close, post-live, and closure through AgentServer', async () => {
    const app = server.getApp();
    await auth(request(app).post('/window-lifecycle/compile')).send({ agentId: 'codey', scope: 'echo-window-lifecycle', windowId: 'w28' }).expect(403);
    const created = await auth(request(app).post('/window-lifecycle/compile')).send({ ...body, windowId: 'w28' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.compiledObligationIds.length).toBeGreaterThan(40);
    const dryRunSend = await auth(request(app).post('/telegram/reply/36966')).send({ text: 'Dry-run must observe without blocking this unresolved ledger.' }); expect(dryRunSend.status, JSON.stringify(dryRunSend.body)).toBe(200); expect(fs.readFileSync(path.join(project.stateDir, 'window-lifecycle', 'shadow-would-block.jsonl'), 'utf8')).toContain('telegram-send');
    await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(409);
    await auth(request(app).post('/telegram/reply/36966')).send({ text: 'script-style relay attempt remains non-blocking during shadow.' }).expect(200);
    syncCommitments(created.body.obligations);
    const native = await auth(request(app).post('/window-lifecycle/native-admission')).send({ ...body, windowId: 'w28', package: validAdmissionPackage(), nonce: 'production-native-0001' });
    expect(native.status, JSON.stringify(native.body)).toBe(200);
    const skippedId = 'start.cadence-commitment'; const skippedIndex = commitments.findIndex(item => item.externalKey === skippedId); const [skippedCommitment] = commitments.splice(skippedIndex, 1); const skipped = await auth(request(app).post('/window-lifecycle/evaluate')).send(body); expect(skipped.status).toBe(409); expect(skipped.body.issues.some((issue: string) => issue === `${skippedId}:predicate-unsatisfied`)).toBe(true); expect(skipped.body.issues.some((issue: string) => issue.startsWith(`${skippedId}:executor-`))).toBe(true); commitments.push(skippedCommitment); const reset = await auth(request(app).post('/window-lifecycle/compile')).send({ ...body, windowId: 'w28' }); syncCommitments(reset.body.obligations); await auth(request(app).post('/telegram/reply/36966')).send({ text: 'Real-run adjudicated shadow refusal.' }).expect(200); await auth(request(app).post('/window-lifecycle/native-admission')).send({ ...body, windowId: 'w28', package: validAdmissionPackage(), nonce: 'production-native-0002' }).expect(200);
    await satisfyEligible(['pre-start', 'start']);
    const admitted = await auth(request(app).post('/window-lifecycle/evaluate')).send(body);
    expect(admitted.status, JSON.stringify({ issues: admitted.body.issues, unresolvedStart: admitted.body.obligations?.filter((o: any) => ['pre-start', 'start'].includes(o.phase) && o.status !== 'satisfied').map((o: any) => ({ id: o.id, statement: o.statement, authority: o.evidencePolicy.requiredAuthority, evidence: o.evidence })) })).toBe(200);
    expect(admitted.body.state).toBe('active_start');

    await advanceCadenceTo(MID);
    await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_due' }).expect(200);
    let ledger = await satisfyEligible(['continuous', 'cadence', 'mid']);
    // Enforcement-path attacks run only after the genuine shadow lifecycle graduates below.
    if (ledger.state === 'active_mid_blocked') await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_due' }).expect(200);
    await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_satisfied' }).expect(200);

    await advanceCadenceTo(CLOSE);
    await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'close_due' }).expect(200);
    ledger = await satisfyEligible(['continuous', 'cadence', 'mid', 'close']);
    if (ledger.state === 'close_blocked') await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'close_due' }).expect(200);
    ledger = (await auth(request(app).get('/window-lifecycle')).expect(200)).body.ledger;
    await auth(request(app).post('/window-lifecycle/tick')).send(body);
    ledger = (await auth(request(app).get('/window-lifecycle')).expect(200)).body.ledger;
    const delivered = await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'delivered_pending_post_live' });
    expect(delivered.status, JSON.stringify({ body: delivered.body, unresolved: ledger.obligations.filter((o: any) => o.phase !== 'post-live' && o.status !== 'satisfied').map((o: any) => ({ id: o.id, phase: o.phase, status: o.status, evidence: o.evidence.length })) })).toBe(200);
    await satisfyEligible(['post-live']);
    const closed = await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'closed_clean' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.state).toBe('closed_clean');
    const status = await auth(request(app).get('/window-lifecycle')).expect(200);
    expect(status.body.closure.state).toBe('closed_clean');
    expect(status.body.ledger.obligations.every((obligation: any) => obligation.status === 'satisfied')).toBe(true);
    const shadowAuditPath = path.join(project.stateDir, 'window-lifecycle', 'shadow-would-block.jsonl'); const cleanAudit = fs.readFileSync(shadowAuditPath, 'utf8'); const auditRows = cleanAudit.trim().split('\n'); fs.writeFileSync(shadowAuditPath, `${auditRows.slice(0, -1).join('\n')}${auditRows.length > 1 ? '\n' : ''}`); await auth(request(app).post('/window-lifecycle/enforcement/record-shadow')).send(body).expect(409); fs.writeFileSync(shadowAuditPath, cleanAudit); fs.appendFileSync(shadowAuditPath, `${JSON.stringify({ lifecycleRunId: status.body.ledger.lifecycleRunId, action: 'injected-misclassification', observedBlock: true, expectedBlock: false })}\n`); await auth(request(app).post('/window-lifecycle/enforcement/record-shadow')).send(body).expect(409); fs.writeFileSync(shadowAuditPath, cleanAudit); const shadowRecorded = await auth(request(app).post('/window-lifecycle/enforcement/record-shadow')).send(body); expect(shadowRecorded.status, JSON.stringify(shadowRecorded.body)).toBe(201); const syntheticReportPath = path.join(project.stateDir, 'window-lifecycle', 'graduation-synthetic.json'); const realReportPath = path.join(project.stateDir, 'window-lifecycle', 'graduation-real-window-shadow.json'); expect(fs.existsSync(realReportPath)).toBe(true); expect(fs.existsSync(syntheticReportPath)).toBe(false); await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(409);

    // A genuinely separate synthetic run must traverse the same production
    // lifecycle. One completed real run is deliberately insufficient.
    currentWindowId = 'synthetic-w28'; clock = BASE; commitments.splice(0); fs.writeFileSync(path.join(project.stateDir, 'autonomous', 'active-36966.json'), JSON.stringify({ topic: 36966, windowId: currentWindowId, status: 'running' }));
    const syntheticCreated = await auth(request(app).post('/window-lifecycle/compile')).send({ ...body, windowId: currentWindowId }).expect(201); syncCommitments(syntheticCreated.body.obligations); await auth(request(app).post('/window-lifecycle/native-admission')).send({ ...body, windowId: currentWindowId, package: validAdmissionPackage(), nonce: 'synthetic-native-0001' }).expect(200); await satisfyEligible(['pre-start', 'start']); await auth(request(app).post('/window-lifecycle/evaluate')).send(body).expect(200); await advanceCadenceTo(MID); await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_due' }).expect(200); let syntheticLedger = await satisfyEligible(['continuous', 'cadence', 'mid']); if (syntheticLedger.state === 'active_mid_blocked') await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_due' }).expect(200); await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'active_mid_satisfied' }).expect(200); await advanceCadenceTo(CLOSE); await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'close_due' }).expect(200); syntheticLedger = await satisfyEligible(['continuous', 'cadence', 'mid', 'close']); if (syntheticLedger.state === 'close_blocked') await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'close_due' }).expect(200); await auth(request(app).post('/window-lifecycle/tick')).send(body); await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'delivered_pending_post_live' }).expect(200); await satisfyEligible(['post-live']); await auth(request(app).post('/window-lifecycle/transition')).send({ ...body, target: 'closed_clean' }).expect(200); await auth(request(app).post('/window-lifecycle/enforcement/record-shadow')).send(body).expect(201); expect(fs.existsSync(syntheticReportPath)).toBe(true); const reports = [JSON.parse(fs.readFileSync(syntheticReportPath, 'utf8')), JSON.parse(fs.readFileSync(realReportPath, 'utf8'))]; expect(new Set(reports.map(report => report.lifecycleRunId)).size).toBe(2); expect(new Set(reports.map(report => report.ledgerDigest)).size).toBe(2); expect(new Set(reports.map(report => report.auditDigest)).size).toBe(2); await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(200);
    const statePath = path.join(project.stateDir, 'window-lifecycle', 'enforcement-state.json'); fs.writeFileSync(statePath, JSON.stringify({ mode: 'enforced' })); expect((await auth(request(app).get('/window-lifecycle/enforcement')).expect(200)).body).toMatchObject({ mode: 'dry-run', fault: 'invalid-or-missing-enforcement-state' }); await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(200); const originalRealReport = fs.readFileSync(realReportPath, 'utf8'); const altered = JSON.parse(originalRealReport); altered.falseBlocks = 1; fs.writeFileSync(realReportPath, JSON.stringify(altered)); expect((await auth(request(app).get('/window-lifecycle/enforcement')).expect(200)).body.mode).toBe('dry-run'); fs.writeFileSync(realReportPath, originalRealReport); await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(200); const heldRealReportPath = `${realReportPath}.held`; fs.renameSync(realReportPath, heldRealReportPath); expect((await auth(request(app).get('/window-lifecycle/enforcement')).expect(200)).body.mode).toBe('dry-run'); fs.renameSync(heldRealReportPath, realReportPath); await auth(request(app).post('/window-lifecycle/enforcement/graduate')).send(body).expect(200);
    const enforcedLedger = (await auth(request(app).get('/window-lifecycle')).expect(200)).body.ledger; enforcedLedger.state = 'active_start'; fs.writeFileSync(path.join(project.stateDir, 'window-lifecycle', 'ledger.json'), `${JSON.stringify(enforcedLedger, null, 2)}\n`);
    telegramProfileId = null; const missingProfile = await auth(request(app).post('/telegram/reply/36966')).send({ text: 'missing profile' }); expect(missingProfile.status).toBeGreaterThanOrEqual(400); telegramProfileId = 'wrong-telegram'; const wrongProfile = await auth(request(app).post('/telegram/reply/36966')).send({ text: 'wrong profile' }); expect(wrongProfile.status).toBeGreaterThanOrEqual(400); telegramProfileId = 'justin-telegram';
    const identityPath = path.join(project.stateDir, 'identity.json'); const canonicalIdentity = fs.readFileSync(identityPath, 'utf8'); const wrongIdentity = generateIdentityKeyPair(); fs.writeFileSync(identityPath, JSON.stringify({ publicKey: PUBLIC_KEY.toString('base64'), privateKey: wrongIdentity.privateKey.toString('base64'), privateKeyEncryption: 'none' })); await auth(request(app).post('/telegram/reply/36966')).send({ text: 'wrong Echo signing key' }).expect(409); fs.writeFileSync(identityPath, canonicalIdentity);
    const principalLedger = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'window-lifecycle', 'ledger.json'), 'utf8')); const principalDuty = principalLedger.obligations.find((item: any) => item.id === 'continuous.telegram.act-as-principal-guard'); principalDuty.status = 'failed'; fs.writeFileSync(path.join(project.stateDir, 'window-lifecycle', 'ledger.json'), `${JSON.stringify(principalLedger, null, 2)}\n`); const principalBlocked = await auth(request(app).post('/telegram/reply/36966')).send({ text: 'valid signing machinery cannot bypass an absent principal guard' }); expect(principalBlocked.status).toBe(409); principalDuty.status = 'satisfied'; fs.writeFileSync(path.join(project.stateDir, 'window-lifecycle', 'ledger.json'), `${JSON.stringify(principalLedger, null, 2)}\n`);
    const guardedSend = await auth(request(app).post('/telegram/reply/36966')).send({ text: 'Unsigned caller bytes must be signed by the send-time guard.' }); expect(guardedSend.status).toBe(200); expect(verifyMessage({ raw: sentMessages.at(-1)!.text, expectedTopicId: 36966, resolvePublicKey: agentId => agentId === 'echo' ? PUBLIC_KEY : null, nowSeconds: Math.floor(Date.parse(clock) / 1000) }).classification).toBe('agent-verified'); project.state.set('agent-updates-topic', 43003); await auth(request(app).post('/telegram/post-update')).send({ text: 'Production update door remains live and is signed.' }).expect(200);
    const ledgerPath = path.join(project.stateDir, 'window-lifecycle', 'ledger.json'); const remediationLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); const correctionDuty = remediationLedger.obligations.find((item: any) => item.id === 'continuous.high-level-observer'); correctionDuty.status = 'failed'; correctionDuty.evidence = []; fs.writeFileSync(ledgerPath, `${JSON.stringify(remediationLedger, null, 2)}\n`); await auth(request(app).post('/window-lifecycle/tick')).send({ ...body, actuateRemediations: true }); const episodes = fs.readFileSync(path.join(project.stateDir, 'window-lifecycle', 'remediations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); const episode = [...episodes].reverse().find(item => item.obligationId === correctionDuty.id && item.disposition === 'awaiting-authoritative-evidence'); const remediationId = episode.remediationId; clock = new Date(Date.parse(clock) + 1000).toISOString();
    await auth(request(app).post(`/window-lifecycle/remediation/${correctionDuty.id}/resolve`)).send({ agentId: 'codey', scope: 'echo-window-lifecycle', remediationId, topicId: 36966, messageId: 1 }).expect(403); await auth(request(app).post(`/window-lifecycle/remediation/${correctionDuty.id}/resolve`)).send({ ...body, remediationId: crypto.randomUUID(), topicId: 36966, messageId: 1 }).expect(409); await auth(request(app).post('/telegram/reply/36966')).send({ text: 'correction keyword only', remediationId }).expect(409);
    const correctionText = 'Window synthesis summary: progress correction landed with the accurate window status. Blockers: none after reviewing the evidence. Next: continue the named lanes and report any new risk.'; const correctionSend = await auth(request(app).post('/telegram/reply/36966')).send({ text: correctionText, remediationId }); expect(correctionSend.status, JSON.stringify(correctionSend.body)).toBe(200); const correctionRow = history.at(-1)!; const correctionResolution = await auth(request(app).post(`/window-lifecycle/remediation/${correctionDuty.id}/resolve`)).send({ ...body, remediationId, topicId: 36966, messageId: correctionRow.messageId }); expect(correctionResolution.status, JSON.stringify(correctionResolution.body)).toBe(200); await auth(request(app).post(`/window-lifecycle/remediation/${correctionDuty.id}/resolve`)).send({ ...body, remediationId, topicId: 36966, messageId: correctionRow.messageId }).expect(409); history.splice(history.indexOf(correctionRow), 1); await auth(request(app).post('/telegram/reply/36966')).send({ text: 'Evidence vanished.' }).expect(409); history.push(correctionRow);
    await auth(request(app).post('/window-lifecycle/enforcement/off')).send({ ...body, reason: 'mode-test' }).expect(200); const offLedger = status.body.ledger; offLedger.state = 'active_start'; offLedger.obligations.find((item: any) => item.id === 'continuous.telegram.act-as-principal-guard').status = 'failed'; fs.writeFileSync(path.join(project.stateDir, 'window-lifecycle', 'ledger.json'), `${JSON.stringify(offLedger, null, 2)}\n`); await auth(request(app).post('/telegram/reply/36966')).send({ text: 'Off mode does not block production doors.' }).expect(200);
    fs.writeFileSync(path.join(project.stateDir, 'window-lifecycle', 'enforcement-state.json'), JSON.stringify({ mode: 'dry-run', startedAt: BASE, expiresAt: BASE })); const dark = await auth(request(app).get('/window-lifecycle/enforcement')).expect(200); expect(dark.body).toMatchObject({ mode: 'off', fault: 'dark-window-expired-without-graduation' });
  }, 900_000);
});
