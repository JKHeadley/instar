import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import fs from 'node:fs';
import path from 'node:path';
import { TruncationDetector } from '../../src/paste/TruncationDetector.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';
import { notificationRefusalFixture } from '../helpers/notificationRefusalFixture.js';

it('does not mark or broadcast a paste as notified when the real helper refuses its input', async () => {
  const f = notificationRefusalFixture();
  const broadcastEvent = vi.fn();
  try {
    const app = express();
    app.use(express.json());
    app.use(authMiddleware('fixture'));
    app.use(createRoutes({
      config: { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir, port: 0, authToken: 'fixture' },
      state: f.project.state, sessionManager: f.manager, pasteManager: f.pasteManager,
      wsManager: { broadcastEvent }, startTime: new Date(),
    } as unknown as RouteContext));
    const refused = await request(app).post('/pastes').set('Authorization', 'Bearer fixture')
      .send({ content: 'refused fixture paste', targetSession: 'fixture-session' });
    expect(refused.status).toBe(500);
    expect(refused.body.ok).toBe(false);
    expect(f.pasteManager.list()).toHaveLength(1);
    expect(f.pasteManager.list()[0].status).toBe('written');
    expect(broadcastEvent).not.toHaveBeenCalled();
    f.decision.accepted = true;
    const accepted = await request(app).post('/pastes').set('Authorization', 'Bearer fixture')
      .send({ content: 'accepted fixture paste', targetSession: 'fixture-session' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('notified');
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(f.inject).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); f.cleanup(); }
});

it('contains refusal of a delayed advisory after accepting the owner message', async () => {
  const f = notificationRefusalFixture();
  ProcessIntegrity.reset();
  ProcessIntegrity.initialize('1.3.1989', null);
  const pending: Array<() => void> = [];
  const originalTimeout = globalThis.setTimeout;
  try {
    vi.spyOn(TruncationDetector.prototype, 'detect').mockReturnValue({ truncationSuspected: true, reason: 'fixture' });
    vi.spyOn(f.manager, 'isSessionAlive').mockReturnValue(true);
    vi.spyOn(f.manager, 'injectTelegramMessage').mockReturnValue(true);
    fs.writeFileSync(path.join(f.project.stateDir, 'topic-session-registry.json'), JSON.stringify({
      topicToSession: { '42': 'fixture-session' }, topicToName: { '42': 'Fixture' },
    }));
    const app = express();
    app.use(express.json());
    app.use(authMiddleware('fixture'));
    app.use(createRoutes({
      config: { projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir, port: 0, authToken: 'fixture' },
      state: f.project.state, sessionManager: f.manager, telegram: null, currentInboundByTopic: new Map(), startTime: new Date(),
    } as unknown as RouteContext));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 1000) {
        pending.push(() => fn(...args));
        return originalTimeout(() => undefined, 0);
      }
      return originalTimeout(fn, delay, ...args);
    }) as typeof setTimeout);
    const response = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer fixture')
      .set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(f.project.stateDir))
      .send({ topicId: 42, text: 'fixture owner message', fromUserId: 123, messageId: 1234 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, forwarded: true });
    expect(pending).toHaveLength(1);
    expect(() => pending[0]()).not.toThrow();
    expect(f.inject).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); f.cleanup(); ProcessIntegrity.reset(); }
});
