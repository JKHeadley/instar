/**
 * context-budget-layered-summaries §9.1 — integration tier through the REAL
 * AgentServer: when the session-start hook cannot read which lifecycle event
 * fired on a Claude Code session, it posts SessionStartSourceUnknown to
 * /hooks/events and the server records a degradation (never a silent
 * "startup"). An ordinary SessionStart event does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const TOKEN = 'ss-source-it-token';

describe('POST /hooks/events SessionStartSourceUnknown — real AgentServer', () => {
  let root: string;
  let server: AgentServer;

  beforeEach(async () => {
    DegradationReporter.resetForTesting();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'ss-it' }));
    const config = {
      projectName: 'ss-it', projectDir: root, stateDir, port: 0, authToken: TOKEN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const state = new StateManager(stateDir);
    const sessionManager = {
      listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null, getSessionById: () => undefined, setClaudeSessionId: () => undefined,
    };
    server = new AgentServer({
      config, sessionManager: sessionManager as never, state,
      hookEventReceiver: new HookEventReceiver({ stateDir, resolveCurrentInstarSessionId: () => null, isLiveInstarSession: () => false }),
      subagentTracker: new SubagentTracker({ stateDir }),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/session-start-source-unknown-route.test.ts' });
  });

  it('records a compaction-recovery-source degradation and returns 204', async () => {
    const res = await request(server.getApp()).post('/hooks/events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ event: 'SessionStartSourceUnknown', sessionId: 'inst-1' });
    expect(res.status).toBe(204);
    const events = DegradationReporter.getInstance().getEvents().filter(e => e.feature === 'compaction-recovery-source');
    expect(events).toHaveLength(1);
  });

  it('reports at most once per process per hour, with a constant reason', async () => {
    for (const sid of ['inst-1', 'inst-2', 'inst-3']) {
      const r = await request(server.getApp()).post('/hooks/events')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ event: 'SessionStartSourceUnknown', sessionId: sid });
      expect(r.status).toBe(204);
    }
    const events = DegradationReporter.getInstance().getEvents().filter(e => e.feature === 'compaction-recovery-source');
    expect(events).toHaveLength(1);
    expect(events[0].reason).not.toContain('inst-');
  });

  it('does not record a degradation for an ordinary SessionStart event', async () => {
    await request(server.getApp()).post('/hooks/events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ event: 'SessionStart', session_id: 'cs-1' });
    expect(DegradationReporter.getInstance().getEvents().filter(e => e.feature === 'compaction-recovery-source')).toHaveLength(0);
  });

  it('requires the bearer token', async () => {
    const res = await request(server.getApp()).post('/hooks/events').send({ event: 'SessionStartSourceUnknown' });
    expect(res.status).toBe(401);
  });
});
