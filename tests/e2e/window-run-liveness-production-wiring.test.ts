import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { createLedger, EchoWindowLedgerStore } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type MockSessionManager, type TempProject } from '../helpers/setup.js';

describe('window run liveness production wiring', () => {
  const token = 'w32-liveness-e2e';
  const baseMs = Date.parse('2026-09-05T20:00:00.000Z');
  let nowMs = baseMs;
  let project: TempProject;
  let server: AgentServer;
  let sessions: MockSessionManager;
  let transcript: string;
  let artifact: string;
  let binding: { windowId: string; topicId: number; autonomousRunId: string; lifecycleRunId: string; executorId: string };

  beforeAll(async () => {
    project = createTempProject();
    transcript = path.join(project.stateDir, 'bound-session.jsonl');
    artifact = path.join(project.dir, 'artifact.txt');
    fs.writeFileSync(transcript, '{"type":"session-event"}\n');
    fs.writeFileSync(artifact, 'first durable result\n');
    fs.utimesSync(transcript, new Date(nowMs), new Date(nowMs));
    fs.mkdirSync(path.join(project.stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'autonomous', 'active-36966.json'), JSON.stringify({ topic: 36966, active: false, status: 'preparing' }));

    sessions = createMockSessionManager();
    sessions._sessions.push({ id: 'instar-session-1', name: 'echo', status: 'running', tmuxSession: 'echo-topic-36966', startedAt: new Date(nowMs).toISOString(), claudeSessionId: 'provider-session-1', framework: 'claude-code', cwd: project.dir } as any);
    sessions._aliveSet.add('echo-topic-36966');

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
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [],
      monitoring: { windowRunLiveness: { enabled: true, dryRun: false, heartbeatMaxAgeMs: 60_000, workEvidenceMaxAgeMs: 30 * 60_000, recoveryCeilingMs: 15 * 60_000 } }, updates: {},
    };
    const telegram = {
      getSessionForTopic: (topicId: number) => topicId === 36966 ? 'echo-topic-36966' : null,
      getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }),
      sendToTopic: async () => ({ messageId: 1 }),
    };
    server = new AgentServer({
      config, sessionManager: sessions as never, state: project.state, telegram: telegram as never,
      windowLifecycleNow: () => new Date(nowMs).toISOString(), windowRunLivenessTranscriptPath: () => transcript,
      sessionRefresh: { refreshSession: async () => ({ ok: true, oldSessionName: 'echo-topic-36966', newSessionName: 'echo-topic-36966', topicId: 36966 }) } as never,
    });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);

  it('is alive through AgentServer and requires independently sourced five-predicate evidence', async () => {
    await request(server.getApp()).get('/window-run-liveness').expect(401);
    const preparation = await auth(request(server.getApp()).post('/autonomous/register')).send({ topicId: 777, condition: 'preparation response contract', workDir: project.dir, startedAt: new Date(nowMs).toISOString(), endAt: new Date(nowMs + 60_000).toISOString(), sessionId: 'other-session' }).expect(200);
    expect(preparation.body).toMatchObject({ initialStatus: 'preparing', preparationRequired: true });
    expect(new AutonomousRunStore(project.stateDir).getByPair('777', preparation.body.runId)?.status).toBe('preparing');
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send({ ...binding, running: true }).expect(400);
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding).expect(201);

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
    fs.utimesSync(transcript, new Date(baseMs - 61_000), new Date(baseMs - 61_000));
    const atRisk = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(atRisk.body.status).toBe('at-risk');
    expect(atRisk.body.predicates).toMatchObject({
      'executor-bound-running': { ok: true },
      'heartbeat-fresh': { ok: false },
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
  it('computes shadow transitions while leaving every legacy active surface byte-identical', async () => {
    const token = 'w32-dryrun-e2e';
    const nowMs = Date.parse('2026-09-05T20:00:00.000Z');
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
    const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);
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
