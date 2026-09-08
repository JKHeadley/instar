import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { createLedger, EchoWindowLedgerStore } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { writeLease as writeTelegramPollOwnerLease } from '../../src/lifeline/TelegramPollOwnerLease.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { createMockSessionManager, createTempProject, type MockSessionManager, type TempProject } from '../helpers/setup.js';

describe('window run liveness production wiring', () => {
  const token = 'w32-liveness-e2e';
  const telegramBotToken = 'w32-lifeline-owned-poller';
  // Anchored to the real clock: the run store archives a run 24h after its
  // endAt against real Date.now(), so a fixed calendar base silently expires
  // (this file went red on 2026-09-07T20:00Z with a 2026-09-05 base).
  const baseMs = Math.floor(Date.now() / 1000) * 1000;
  let nowMs = baseMs;
  let project: TempProject;
  let server: AgentServer;
  let sessions: MockSessionManager;
  let transcript: string;
  let configHome: string;
  let artifact: string;
  const checkpointInputs: string[] = [];
  const outboundRows: any[] = [];
  let ownerMachineId = 'mini';
  const ownershipKeys: string[] = [];
  let binding: { windowId: string; topicId: number; autonomousRunId: string; lifecycleRunId: string; executorId: string };

  beforeAll(async () => {
    project = createTempProject();
    // Production Echo's observer is a subscription-pool-routed claude-code
    // session: its transcript lives under its LIVE CLAUDE_CONFIG_DIR, not
    // ~/.claude. No transcript override here — the server must resolve the
    // real path from the session's config home or the heartbeat is missing.
    configHome = path.join(project.stateDir, 'claude-followme-pool-a');
    transcript = path.join(configHome, 'projects', project.dir.replace(/[\/.]/g, '-'), 'provider-session-1.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    artifact = path.join(project.dir, 'artifact.txt');
    fs.writeFileSync(transcript, '{"type":"session-event"}\n');
    fs.writeFileSync(artifact, 'first durable result\n');
    const identity = generateIdentityKeyPair();
    fs.writeFileSync(path.join(project.stateDir, 'identity.json'), JSON.stringify({ publicKey: identity.publicKey.toString('base64'), privateKey: identity.privateKey.toString('base64') }));
    fs.utimesSync(transcript, new Date(nowMs), new Date(nowMs));
    fs.mkdirSync(path.join(project.stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'autonomous', 'active-36966.json'), JSON.stringify({ topic: 36966, active: false, status: 'preparing' }));

    sessions = createMockSessionManager();
    sessions.sendInput = (tmuxSession: string, input: string) => { checkpointInputs.push(`${tmuxSession}:${input}`); return sessions._aliveSet.has(tmuxSession); };
    sessions._sessions.push({ id: 'instar-session-1', name: 'echo', status: 'running', tmuxSession: 'echo-topic-36966', startedAt: new Date(nowMs).toISOString(), claudeSessionId: 'provider-session-1', framework: 'claude-code', cwd: project.dir } as any);
    sessions._aliveSet.add('echo-topic-36966');
    (sessions as any).configHomeForSession = (tmuxSession: string) => tmuxSession === 'echo-topic-36966' ? configHome : undefined;

    const runs = new AutonomousRunStore(project.stateDir);
    const registered = runs.register({
      topicId: '36966', condition: 'complete W32', workDir: project.dir, startedAt: new Date(nowMs).toISOString(),
      endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString(), sessionId: 'instar-session-1',
      scopeAccretion: { enabled: true, breakerK: 3 }, baseRoots: [], maxDurationMs: 24 * 60 * 60_000, initialStatus: 'preparing',
    }, nowMs);
    if (!registered.ok) throw new Error('fixture autonomous registration failed');
    fs.writeFileSync(path.join(project.stateDir, 'autonomous', '36966.local.md'), `---\nactive: false\nsession_id: "echo-topic-36966"\nstatus: preparing\nrun_id: "${registered.runId}"\nreport_topic: "36966"\n---\n\n# Durable autonomous task body\n- [ ] Build model\n- [ ] Add tests\n- [ ] Verify recovery\n- [ ] Freeze receipts\nDo not replace this body.\n`);

    const lifecycleStore = new EchoWindowLedgerStore(project.stateDir);
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [] } });
    ledger.state = 'active_start';
    ledger.admission = { admitted: true, evaluatedAt: new Date(nowMs).toISOString(), snapshotDigest: 'a'.repeat(64) };
    lifecycleStore.save(ledger);
    binding = { windowId: 'w32', topicId: 36966, autonomousRunId: registered.runId, lifecycleRunId: ledger.lifecycleRunId, executorId: 'echo-topic-36966' };

    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, developmentAgent: true,
      requestTimeoutMs: 5000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'telegram', enabled: true, config: { token: telegramBotToken } }],
      monitoring: { windowRunLiveness: { enabled: true, dryRun: false, heartbeatMaxAgeMs: 60_000, workEvidenceMaxAgeMs: 30 * 60_000, recoveryCeilingMs: 15 * 60_000, cadenceExecutor: { enabled: true, dryRun: false, reportIntervalMs: 26 * 60_000 } } }, updates: {},
    };
    writeTelegramPollOwnerLease(project.stateDir, telegramBotToken, process.pid, nowMs);
    const telegram = {
      getSessionForTopic: (topicId: number) => topicId === 36966 ? 'echo-topic-36966' : null,
      // Production Echo runs this adapter send-only while the separate lifeline
      // owns polling. A fresh token-matched poll lease is the live signal.
      getStatus: () => ({ started: false, fatalReason: null, lastError: null, consecutivePollErrors: 0 }),
      getTopicHistory: (topicId: number) => outboundRows.filter(row => row.topicId === topicId),
      sendToTopic: async (topicId: number, text: string, options: any) => {
        const row = { messageId: outboundRows.length + 1, topicId, text, fromUser: false, forwarded: false, provenance: options?.provenance ?? 'automation', authorship: 'agent-outbound', timestamp: new Date(nowMs).toISOString(), sessionName: binding?.executorId ?? null };
        outboundRows.push(row);
        return { messageId: row.messageId };
      },
    };
    server = new AgentServer({
      config, sessionManager: sessions as never, state: project.state, telegram: telegram as never,
      meshSelfId: 'mini',
      sessionOwnershipRegistry: {
        read: (sessionKey: string) => {
          ownershipKeys.push(sessionKey);
          return sessionKey === '36966' ? { sessionKey, ownerMachineId, ownershipEpoch: 1, status: 'active', nonce: 'owner', timestamp: nowMs, updatedAt: new Date(nowMs).toISOString() } : null;
        },
      } as never,
      windowLifecycleNow: () => new Date(nowMs).toISOString(),
      sessionRefresh: { refreshSession: async () => ({ ok: true, oldSessionName: 'echo-topic-36966', newSessionName: 'echo-topic-36966', topicId: 36966 }) } as never,
    });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo');

  it('is alive through AgentServer with a lifeline-owned poller and independently sourced five-predicate evidence', async () => {
    await request(server.getApp()).get('/window-run-liveness').expect(401);
    const preparation = await auth(request(server.getApp()).post('/autonomous/register')).send({ topicId: 777, condition: 'preparation response contract', workDir: project.dir, startedAt: new Date(nowMs).toISOString(), endAt: new Date(nowMs + 60_000).toISOString(), sessionId: 'other-session' }).expect(200);
    expect(preparation.body).toMatchObject({ initialStatus: 'preparing', preparationRequired: true });
    expect(new AutonomousRunStore(project.stateDir).getByPair('777', preparation.body.runId)?.status).toBe('preparing');
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send({ ...binding, running: true }).expect(400);
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding).expect(201);
    await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(404);
    expect((await auth(request(server.getApp()).get('/window-run-liveness/cadence')).expect(200)).body.state).toBeNull();

    const minted = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'artifact.txt' }).expect(201);
    expect(minted.body.receipt).toMatchObject({ sequence: 1, artifact: 'artifact.txt', taskRef: `autonomous:${binding.autonomousRunId}:1` });
    const markerPath = path.join(project.stateDir, 'autonomous', 'active-36966.json');
    fs.writeFileSync(markerPath, '{malformed');
    await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(409);
    const interrupted = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
    expect(interrupted.body.state).toMatchObject({ status: 'active', legacyProjection: { status: 'preparing' } });
    expect(new AutonomousRunStore(project.stateDir).getByPair('36966', binding.autonomousRunId)?.status).toBe('preparing');
    expect(fs.readFileSync(path.join(project.stateDir, 'autonomous', '36966.local.md'), 'utf8')).toContain('active: false');
    fs.writeFileSync(markerPath, JSON.stringify({ topic: 36966, active: false, status: 'preparing' }));
    const active = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(active.body.status).toBe('active');
    expect(active.body.predicates['delivery-reachable']).toMatchObject({ ok: true, observed: 'reachable' });
    ownerMachineId = 'laptop';
    await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(404);
    expect(ownershipKeys.at(-1)).toBe('36966');
    expect((await auth(request(server.getApp()).get('/window-run-liveness/cadence')).expect(200)).body.state).toBeNull();
    ownerMachineId = 'mini';
    const cadence = await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(200);
    expect(cadence.body).toMatchObject({ windowId: 'w32', autonomousRunId: binding.autonomousRunId, status: 'running' });
    const cadenceStatus = await auth(request(server.getApp()).get('/window-run-liveness/cadence')).expect(200);
    expect(cadenceStatus.body).toMatchObject({ enabled: true, dryRun: false, state: { lifecycleRunId: binding.lifecycleRunId } });
    nowMs += 25 * 60_000;
    await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(200);
    expect(checkpointInputs).toHaveLength(1);
    expect(checkpointInputs[0]).toContain(`server-bound task autonomous:${binding.autonomousRunId}:2`);
    nowMs = baseMs + 26 * 60_000;
    const reportTick = await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(200);
    expect(reportTick.body.reports).toMatchObject([{ status: 'delivered', messageId: 1, producerSignature: expect.any(String) }]);
    expect(outboundRows[0]).toMatchObject({ forwarded: false, provenance: 'automation', authorship: 'agent-outbound' });
    expect(outboundRows[0].text).toContain('W32 cadence producer signature:');
    nowMs = baseMs;
    expect(active.body.predicates['heartbeat-fresh'].observed).toBe(new Date(baseMs).toISOString());
    expect(new AutonomousRunStore(project.stateDir).getByPair('36966', binding.autonomousRunId)?.status).toBe('active');
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ active: true, status: 'running', runId: binding.autonomousRunId, sessionId: binding.executorId });
    const activeLocal = fs.readFileSync(path.join(project.stateDir, 'autonomous', '36966.local.md'), 'utf8');
    expect(activeLocal).toContain('active: true');
    expect(activeLocal).toContain('session_id: "echo-topic-36966"');
    expect(activeLocal).toContain('status: active');
    expect(activeLocal).toContain('Do not replace this body.');

    // Pane narration is never work authority; only the artifact-verification
    // boundary can mint a newer receipt.
    sessions.captureOutput = () => 'lots of new narration and spinner output';
    const unchangedState = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(unchangedState.body.lastWorkReceipt.sequence).toBe(1);
    await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'artifact.txt' }).expect(409);
    fs.writeFileSync(artifact, 'second durable result\n');
    const advanced = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'artifact.txt' }).expect(201);
    expect(advanced.body.receipt.sequence).toBe(2);
    expect(advanced.body.receipt.taskRef).toBe(`autonomous:${binding.autonomousRunId}:2`);
  });

  it('revokes active from transcript heartbeat staleness and durably records the sole dry-run recovery', async () => {
    // A future-dated lease is valid for the collision-avoidance helper's
    // fail-open startup posture, but must never count as positive liveness.
    writeTelegramPollOwnerLease(project.stateDir, telegramBotToken, process.pid, nowMs + 1);
    fs.utimesSync(transcript, new Date(baseMs - 61_000), new Date(baseMs - 61_000));
    const atRisk = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(atRisk.body.status).toBe('at-risk');
    expect(atRisk.body.predicates).toMatchObject({
      'executor-bound-running': { ok: true },
      'heartbeat-fresh': { ok: false },
      'delivery-reachable': { ok: false, observed: 'unreachable' },
    });
    expect(atRisk.body.recoveryAttempt).toMatchObject({ number: 1, outcome: 'succeeded', requestedTaskRef: `autonomous:${binding.autonomousRunId}:3`, resumedTaskRef: `autonomous:${binding.autonomousRunId}:3` });
    expect(new AutonomousRunStore(project.stateDir).getByPair('36966', binding.autonomousRunId)?.status).toBe('at-risk');
    expect(JSON.parse(fs.readFileSync(path.join(project.stateDir, 'autonomous', 'active-36966.json'), 'utf8'))).toMatchObject({ active: false, status: 'at-risk' });
    const atRiskLocal = fs.readFileSync(path.join(project.stateDir, 'autonomous', '36966.local.md'), 'utf8');
    expect(atRiskLocal).toContain('active: false');
    expect(atRiskLocal).toContain('status: at-risk');
    expect(atRiskLocal).toContain('Do not replace this body.');
    const durable = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'window-run-liveness', 'state.json'), 'utf8'));
    expect(durable.recoveryAttempt.attemptId).toBe(atRisk.body.recoveryAttempt.attemptId);
  });

  it('fails within the ceiling and keeps the canonical Stop-hook driver inactive', async () => {
    nowMs += 15 * 60_000;
    const failed = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.finalSnapshot.reason).toBe('recovery-ceiling-exceeded');
    expect(new AutonomousRunStore(project.stateDir).getByPair('36966', binding.autonomousRunId)?.status).toBe('failed');
    const local = fs.readFileSync(path.join(project.stateDir, 'autonomous', '36966.local.md'), 'utf8');
    expect(local).toContain('active: false');
    expect(local).toContain('status: failed');
    expect(local).toContain('Do not replace this body.');
  });
});

describe('window run liveness observe-only production boundary', () => {
  it('fails before synthesis delivery when the configured identity keypair is mismatched', async () => {
    const token = 'w32-keypair-mismatch';
    const baseMs = Math.floor(Date.now() / 1000) * 1000;
    const project = createTempProject();
    const privateIdentity = generateIdentityKeyPair();
    const publicIdentity = generateIdentityKeyPair();
    fs.writeFileSync(path.join(project.stateDir, 'identity.json'), JSON.stringify({
      privateKey: privateIdentity.privateKey.toString('base64'),
      publicKey: publicIdentity.publicKey.toString('base64'),
    }));
    const sessions = createMockSessionManager();
    const sent: string[] = [];
    const liveness: any = {
      version: 1, windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966',
      status: 'active', registeredAt: new Date(baseMs).toISOString(), activatedAt: new Date(baseMs).toISOString(),
      predicates: {}, transitions: [], executorBindingReceipts: [], audit: { entries: [], headDigest: null },
    };
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, developmentAgent: true,
      requestTimeoutMs: 5000, version: '1.3.1223', sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: { windowRunLiveness: { enabled: true, dryRun: false, cadenceExecutor: { enabled: true, dryRun: false, reportIntervalMs: 1 } } }, updates: {},
    };
    const server = new AgentServer({
      config, sessionManager: sessions as never, state: project.state,
      telegram: {
        getTopicHistory: () => [],
        sendToTopic: async (_topicId: number, text: string) => { sent.push(text); return { messageId: sent.length }; },
        getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }),
      } as never,
      windowLifecycleNow: () => new Date(baseMs + 1).toISOString(),
      windowRunLivenessAuthority: { status: () => ({ enabled: true, dryRun: false, config: {}, state: liveness }), tick: async () => liveness } as never,
    });
    await server.start();
    try {
      const response = await request(server.getApp()).post('/window-run-liveness/cadence/tick')
        .set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo').send({}).expect(200);
      expect(response.body).toMatchObject({ status: 'failed', reports: [{ status: 'failed', attemptCount: 0 }], failure: { notified: true } });
      expect(response.body.reports[0].error).toMatch(/^synthesis-producer-signature-error:/);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('cadence failure receipt');
      expect(sent[0]).not.toContain('W32 synthesis receipt:');
    } finally {
      await server.stop();
      project.cleanup();
    }
  });

  it('computes shadow transitions while leaving every legacy active surface byte-identical', async () => {
    const token = 'w32-dryrun-e2e';
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const project = createTempProject();
    const sessions = createMockSessionManager();
    const transcript = path.join(project.stateDir, 'dryrun-session.jsonl');
    const artifact = path.join(project.dir, 'artifact.txt');
    fs.writeFileSync(transcript, '{"type":"session-event"}\n');
    fs.writeFileSync(artifact, 'dry-run durable result\n');
    fs.utimesSync(transcript, new Date(nowMs - 61_000), new Date(nowMs - 61_000));
    sessions._sessions.push({ id: 'dryrun-session', name: 'echo', status: 'running', tmuxSession: 'echo-topic-36966', startedAt: new Date(nowMs).toISOString(), claudeSessionId: 'dryrun-provider', framework: 'claude-code', cwd: project.dir } as any);
    sessions._aliveSet.add('echo-topic-36966');
    const runs = new AutonomousRunStore(project.stateDir);
    const registered = runs.register({
      topicId: '36966', condition: 'observe W32', workDir: project.dir, startedAt: new Date(nowMs).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString(),
      sessionId: 'dryrun-session', scopeAccretion: { enabled: true, breakerK: 3 }, baseRoots: [], maxDurationMs: 24 * 60 * 60_000, initialStatus: 'active',
    }, nowMs);
    if (!registered.ok) throw new Error('dryrun registration failed');
    const runFile = fs.readdirSync(runs.storeDir).map(name => path.join(runs.storeDir, name)).find(file => path.basename(file).startsWith(`36966.${registered.runId}.`));
    if (!runFile) throw new Error('dryrun run file missing');
    const runBefore = fs.readFileSync(runFile, 'utf8');
    const autoDir = path.join(project.stateDir, 'autonomous');
    fs.mkdirSync(autoDir, { recursive: true });
    const localPath = path.join(autoDir, '36966.local.md');
    const markerPath = path.join(autoDir, 'active-36966.json');
    const localBefore = `---\nactive: true\nstatus: active\nsession_id: "echo-topic-36966"\nrun_id: "${registered.runId}"\n---\n- [ ] Observe only\n`;
    const markerBefore = `${JSON.stringify({ active: true, status: 'running', sentinel: 'unchanged' }, null, 2)}\n`;
    fs.writeFileSync(localPath, localBefore);
    fs.writeFileSync(markerPath, markerBefore);
    const ledgerStore = new EchoWindowLedgerStore(project.stateDir);
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32-dry', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [] } });
    ledger.state = 'active_start';
    ledger.admission = { admitted: true, evaluatedAt: new Date(nowMs).toISOString(), snapshotDigest: 'a'.repeat(64) };
    ledgerStore.save(ledger);
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, developmentAgent: true,
      requestTimeoutMs: 5000, version: '1.3.1223', sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: { windowRunLiveness: { enabled: true, dryRun: true, heartbeatMaxAgeMs: 60_000 } }, updates: {},
    };
    const server = new AgentServer({
      config, sessionManager: sessions as never, state: project.state,
      telegram: { getSessionForTopic: () => 'echo-topic-36966', getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }), sendToTopic: async () => ({ messageId: 1 }) } as never,
      windowLifecycleNow: () => new Date(nowMs).toISOString(), windowRunLivenessTranscriptPath: () => transcript,
    });
    await server.start();
    const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo');
    try {
      const legacy = await auth(request(server.getApp()).post('/autonomous/register')).send({ topicId: 777, condition: 'shadow registration', workDir: project.dir, startedAt: new Date(nowMs).toISOString(), endAt: new Date(nowMs + 60_000).toISOString(), sessionId: 'other' }).expect(200);
      expect(legacy.body).toMatchObject({ initialStatus: 'active', preparationRequired: false });
      const binding = { windowId: 'w32-dry', topicId: 36966, autonomousRunId: registered.runId, lifecycleRunId: ledger.lifecycleRunId, executorId: 'echo-topic-36966' };
      await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding).expect(201);
      const work = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'artifact.txt' });
      expect(work.status, JSON.stringify(work.body)).toBe(201);
      const shadow = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
      expect(shadow.body.status).toBe('at-risk');
      expect(fs.readFileSync(localPath, 'utf8')).toBe(localBefore);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(markerBefore);
      expect(fs.readFileSync(runFile, 'utf8')).toBe(runBefore);
      expect(new AutonomousRunStore(project.stateDir).getByPair('36966', registered.runId)?.status).toBe('active');
    } finally {
      await server.stop();
      project.cleanup();
    }
  });
});
