/**
 * GET /session-pool/readiness over the real route and auth (session-pool-default-on).
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { setActivePoolReadiness } from '../../src/core/poolReadiness.js';

const AUTH = 'test-bearer-token';

function app(): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
    autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null, featureMetricsLedger: null,
    resourceLedger: null, processFootprintMonitor: null, startTime: new Date(),
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes(ctx));
  return a;
}

describe('GET /session-pool/readiness (integration)', () => {
  afterEach(() => setActivePoolReadiness(null));

  it('401 without a bearer token', async () => {
    expect((await request(app()).get('/session-pool/readiness')).status).toBe(401);
  });

  it('an agent with no pool wired reads as a single machine', async () => {
    const res = await request(app()).get('/session-pool/readiness').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ machines: 1, ready: false, reason: 'single-machine' });
  });

  it('a wired agent with no peers gets the same single-machine answer, with no alarming lines', async () => {
    setActivePoolReadiness({
      peerIds: () => [], capacity: () => null, ownChannels: () => undefined, durableOwnership: () => false,
      duplicateCheck: () => null, takeover: () => ({ state: 'failing', reason: 'no git remote' }),
    });
    const res = await request(app()).get('/session-pool/readiness').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body).toEqual({ machines: 1, ready: false, reason: 'single-machine' });
  });

  it('a wired agent gets the line-by-line report, and a takeover failure is visible', async () => {
    setActivePoolReadiness({
      peerIds: () => ['m_peer'], capacity: () => null, ownChannels: () => undefined, durableOwnership: () => false,
      duplicateCheck: () => null, takeover: () => ({ state: 'failing', reason: 'no git remote' }),
    });
    const res = await request(app()).get('/session-pool/readiness').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ machines: 2, ready: false, thisMachine: { takeover: { state: 'failing' }, ownership: { state: 'failing' } } });
    expect(res.body.peers[0].lines.contact.state).toBe('unknown');
  });
});
