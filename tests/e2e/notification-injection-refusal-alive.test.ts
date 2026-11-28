import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import type { InstarConfig } from '../../src/core/types.js';
import { notificationRefusalFixture } from '../helpers/notificationRefusalFixture.js';

it('production server preserves an unnotified paste and stays available after explicit refusal', async () => {
  const f = notificationRefusalFixture();
  let server: AgentServer | undefined;
  try {
    const config = { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir,
      port: 0, authToken: 'fixture', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, state: f.project.state, sessionManager: f.manager,
      initiativeTracker: new InitiativeTracker(f.project.stateDir), pasteManager: f.pasteManager });
    const refused = await request(server.getApp()).post('/pastes').set('Authorization', 'Bearer fixture')
      .send({ content: 'persisted fixture paste', targetSession: 'fixture-session' });
    expect(refused.status).toBe(500);
    const stored = f.pasteManager.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('written');
    expect(f.pasteManager.getMeta(stored[0].pasteId)?.status).toBe('written');
    const list = await request(server.getApp()).get('/pastes').set('Authorization', 'Bearer fixture');
    expect(list.status).toBe(200);
    f.decision.accepted = true;
    const accepted = await request(server.getApp()).post('/pastes').set('Authorization', 'Bearer fixture')
      .send({ content: 'new accepted fixture paste', targetSession: 'fixture-session' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('notified');
    expect(f.inject).toHaveBeenCalledTimes(2);
  } finally { await server?.stop(); vi.restoreAllMocks(); f.cleanup(); }
});
