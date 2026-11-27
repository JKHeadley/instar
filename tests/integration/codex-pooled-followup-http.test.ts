import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';
import { codexFollowupFixture } from '../helpers/codexFollowupFixture.js';

it('HTTP Telegram ingress retains the second owner message in the real durable FIFO', async () => {
  const f = codexFollowupFixture();
  ProcessIntegrity.reset();
  ProcessIntegrity.initialize('1.3.1989', null);
  try {
    const { manager, paste } = f.boot();
    vi.spyOn(manager, 'isSessionAlive').mockReturnValue(true);
    fs.writeFileSync(path.join(f.project.stateDir, 'topic-session-registry.json'), JSON.stringify({
      topicToSession: { '42': 'pooled-session' }, topicToName: { '42': 'Fixture' },
    }));
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir, port: 0, authToken: 'fixture' },
      sessionManager: manager, state: f.project.state, telegram: null, scheduler: null,
      currentInboundByTopic: new Map(), startTime: new Date(),
    } as unknown as RouteContext));
    for (const messageId of [101, 102]) {
      const response = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer fixture')
        .set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(f.project.stateDir))
        .send({ topicId: 42, text: `Owner follow-up ${messageId}`, fromUserId: 123, messageId });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.error).toBeUndefined();
    }
    const status = await request(app).get('/sessions/inbound-delivery-status').set('Authorization', 'Bearer fixture');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, logicalRows: 2, deliveriesByState: { dispatched: 1, prepared: 1 }, blindReplay: false });
    expect(paste).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    f.cleanup();
    ProcessIntegrity.reset();
  }
});
