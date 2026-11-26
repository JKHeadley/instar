import { expect, it, vi } from 'vitest';
import { claudePasteFixture } from '../helpers/claudePasteSubmit.js';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

it('POST /pastes submits its notification once even when Claude commits the paste late', async () => {
  const f = claudePasteFixture({ commitMs: 750 });
  try {
    const app = express();
    app.use(express.json(), authMiddleware('fixture'));
    app.use(createRoutes({
      config: { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir, port: 0, authToken: 'fixture' },
      state: f.project.state, sessionManager: f.manager, pasteManager: f.pasteManager, startTime: new Date(),
    } as unknown as RouteContext));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const res = await request(app).post('/pastes').set('Authorization', 'Bearer fixture').set('X-Instar-AgentId', 'fixture')
      .send({ content: 'private fixture', targetSession: f.session.name });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('notified');
    expect(f.submitted).toEqual([f.pasteManager.buildNotification(f.pasteManager.getMeta(res.body.pasteId)!)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.keys).toEqual(['Enter']);
    expect(f.report).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); f.cleanup(); }
});
