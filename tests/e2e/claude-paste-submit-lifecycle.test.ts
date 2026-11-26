import { expect, it, vi } from 'vitest';
import { claudePasteFixture } from '../helpers/claudePasteSubmit.js';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import type { InstarConfig } from '../../src/core/types.js';

it('recovers one dropped Enter and leaves the answered turn alone through the end of verification', async () => {
  const f = claudePasteFixture({ dropFirstEnter: true });
  let server: AgentServer | undefined;
  try {
    const config = { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir,
      port: 0, authToken: 'fixture', developmentAgent: false,
      sessions: { claudePath: '/usr/bin/false', maxSessions: 1, defaultMaxDurationMinutes: 5, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, state: f.project.state, sessionManager: f.manager,
      initiativeTracker: new InitiativeTracker(f.project.stateDir), pasteManager: f.pasteManager });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const res = await request(server.getApp()).post('/pastes').set('Authorization', 'Bearer fixture').set('X-Instar-AgentId', 'fixture')
      .send({ content: 'private fixture', targetSession: f.session.name });
    expect(res.status).toBe(201);
    expect(f.submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.submitted).toEqual([f.pasteManager.buildNotification(f.pasteManager.getMeta(res.body.pasteId)!)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.keys).toEqual(['Enter', 'Enter']);
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'SessionManager.verifyInjection' }));
  } finally { vi.useRealTimers(); await server?.stop(); f.cleanup(); }
});
