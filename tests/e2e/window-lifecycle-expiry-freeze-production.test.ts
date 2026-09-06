import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { EchoWindowLedgerStore, compileWindowSources, createLedger } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';

describe('W32 expiry freeze production path', () => {
  it('revokes every active projection at the ceiling and stays frozen after tick, registration, and restart', async () => {
    const project = createTempProject();
    const token = 'w32-expiry-production';
    const startMs = Date.parse('2026-09-05T20:00:00.000Z');
    let nowMs = startMs;
    const transcript = path.join(project.stateDir, 'w32-expiry-session.jsonl');
    const artifact = path.join(project.dir, 'expiry-receipt.txt');
    fs.writeFileSync(transcript, '{"type":"session-event"}\n');
    fs.writeFileSync(artifact, 'durable pre-expiry receipt\n');
    fs.utimesSync(transcript, new Date(nowMs), new Date(nowMs));

    const tenetsPath = path.join(project.dir, '.instar', 'TENETS.md');
    const charterPath = path.join(project.stateDir, 'w32', 'WINDOW-32-CHARTER.md');
    fs.mkdirSync(path.dirname(tenetsPath), { recursive: true });
    fs.mkdirSync(path.dirname(charterPath), { recursive: true });
    fs.copyFileSync(path.resolve('tests/fixtures/window-32-tenets.md'), tenetsPath);
    fs.copyFileSync(path.resolve('tests/fixtures/window-32-approved-charter.md'), charterPath);
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath, charterPath, now: new Date(startMs).toISOString() });
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled });
    ledger.state = 'active_start';
    ledger.admission = { admitted: true, evaluatedAt: new Date(startMs).toISOString(), snapshotDigest: 'a'.repeat(64) };
    new EchoWindowLedgerStore(project.stateDir).save(ledger);

    const sessions = createMockSessionManager();
    sessions._sessions.push({ id: 'instar-expiry-session', name: 'echo', status: 'running', tmuxSession: 'echo-topic-36966', startedAt: new Date(startMs).toISOString(), claudeSessionId: 'provider-expiry-session', framework: 'claude-code', cwd: project.dir } as any);
    sessions._aliveSet.add('echo-topic-36966');
    const runs = new AutonomousRunStore(project.stateDir);
    const registered = runs.register({
      topicId: '36966', condition: 'test expiry freeze', workDir: project.dir, startedAt: new Date(startMs).toISOString(),
      endAt: ledger.windowCeilingAt, sessionId: 'instar-expiry-session', scopeAccretion: { enabled: true, breakerK: 3 },
      baseRoots: [], maxDurationMs: 24 * 60 * 60_000, initialStatus: 'preparing',
    }, startMs);
    if (!registered.ok) throw new Error('autonomous fixture registration failed');
    fs.mkdirSync(path.join(project.stateDir, 'autonomous'), { recursive: true });
    const localPath = path.join(project.stateDir, 'autonomous', '36966.local.md');
    const markerPath = path.join(project.stateDir, 'autonomous', 'active-36966.json');
    fs.writeFileSync(localPath, `---\nactive: false\nsession_id: "echo-topic-36966"\nstatus: preparing\nrun_id: "${registered.runId}"\n---\n- [ ] Preserve the expiry receipt\n`);
    fs.writeFileSync(markerPath, `${JSON.stringify({ topic: 36966, active: false, status: 'preparing' }, null, 2)}\n`);

    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, developmentAgent: true,
      requestTimeoutMs: 5_000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [],
      monitoring: { windowRunLiveness: { enabled: true, dryRun: false, heartbeatMaxAgeMs: 60_000, workEvidenceMaxAgeMs: 30 * 60_000, recoveryCeilingMs: 15 * 60_000 } }, updates: {},
    };
    const sentMessages: string[] = [];
    const telegram = {
      getSessionForTopic: (topicId: number) => topicId === 36966 ? 'echo-topic-36966' : null,
      getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }),
      getTopicHistory: () => [],
      sendToTopic: async (_topicId: number, text: string) => { sentMessages.push(text); return { messageId: 1 }; },
    };
    const makeServer = () => new AgentServer({
      config, sessionManager: sessions as never, state: project.state, telegram: telegram as never,
      windowLifecycleNow: () => new Date(nowMs).toISOString(), windowRunLivenessTranscriptPath: () => transcript,
    });

    let server = makeServer();
    try {
      await server.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);
      const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: registered.runId, lifecycleRunId: ledger.lifecycleRunId, executorId: 'echo-topic-36966' };
      const registration = await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding);
      expect(registration.status, JSON.stringify(registration.body)).toBe(201);
      await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: path.basename(artifact) }).expect(201);
      const active = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
      expect(active.body.status).toBe('active');
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ active: true, status: 'running' });

      nowMs = Date.parse(ledger.windowCeilingAt!);
      fs.utimesSync(transcript, new Date(nowMs), new Date(nowMs));
      const expired = await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' }).expect(409);
      expect(expired.body).toMatchObject({ ledger: { state: 'closed_failed', recurrenceFrozenAt: ledger.windowCeilingAt }, issues: ['window-ceiling-expired'] });
      expect(expired.body.ledger.obligations.filter((duty: any) => duty.id.includes('@')).every((duty: any) => Date.parse(duty.deadline.dueAt) <= nowMs)).toBe(true);
      const frozen = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
      expect(frozen.body.state).toMatchObject({ status: 'failed', finalSnapshot: { reason: 'window-ceiling-expired' }, legacyProjection: { status: 'failed' } });
      expect(runs.getByPair('36966', registered.runId)?.status).toBe('failed');
      expect(fs.readFileSync(localPath, 'utf8')).toContain('active: false');
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ active: false, status: 'failed' });
      await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
      const failureNotices = sentMessages.filter(message => message.includes('window-ceiling-expired'));
      expect(failureNotices).toHaveLength(1);
      expect(failureNotices[0]).toMatch(/^Window w32 failed: window-ceiling-expired\. Active has been revoked\.\n\[window-run-liveness-notice:[a-f0-9]{24}\]$/);
      const frozenSnapshot = frozen.body.state.finalSnapshot;
      const frozenIds = expired.body.ledger.compiledObligationIds;

      await auth(request(server.getApp()).post('/window-lifecycle/tick')).send({ agentId: 'echo', scope: 'echo-window-lifecycle' }).expect(409);
      await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding).expect(409);
      await server.stop();
      server = makeServer();
      await server.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterRestart = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
      expect(afterRestart.body.state.finalSnapshot).toEqual(frozenSnapshot);
      expect(new EchoWindowLedgerStore(project.stateDir).load('echo', 'echo-window-lifecycle')!.compiledObligationIds).toEqual(frozenIds);
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).active).toBe(false);
      expect(sentMessages.filter(message => message.includes('window-ceiling-expired'))).toEqual(failureNotices);
    } finally {
      await server.stop();
      project.cleanup();
    }
  });
});
