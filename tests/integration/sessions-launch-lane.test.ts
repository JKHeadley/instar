/**
 * Integration test — GET /sessions surfaces `launchLane`
 * (june15-headless-spawn-reroute, finding O4).
 *
 * The soak's success criterion — "zero headless claude-code spawns under
 * force" — must be machine-checkable from the HTTP pipeline, not inferred
 * from reap reasons. This verifies the route serializes the field for both
 * lanes through the real router (the enrichment map spreads the session, so
 * a future whitelist refactor that drops the field fails here).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import type { Session } from '../../src/core/types.js';

const SESSIONS: Partial<Session>[] = [
  {
    id: 'lane-rr', name: 'lane-rr', status: 'running', tmuxSession: 'proj-lane-rr',
    startedAt: new Date().toISOString(), framework: 'claude-code',
    launchLane: 'rerouted-interactive', completionMode: 'pattern',
    completionPatterns: ['INSTAR_JOB_COMPLETE_cafef00d'],
  },
  {
    id: 'lane-hl', name: 'lane-hl', status: 'running', tmuxSession: 'proj-lane-hl',
    startedAt: new Date().toISOString(), framework: 'claude-code',
    launchLane: 'headless', completionMode: 'exit',
  },
];

function ctx(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as never, scheduler: {} as never },
    sessionManager: {
      listRunningSessions: () => SESSIONS,
    },
    // GET /sessions reads from state.listSessions (the durable record).
    state: { getJobState: () => null, getSession: () => null, listSessions: () => SESSIONS },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /sessions — launchLane surface (integration)', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx()));
  });

  it('serializes launchLane for both lanes through the real route pipeline', async () => {
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    const body = res.body as Array<{ id: string; launchLane?: string }>;
    const rerouted = body.find((s) => s.id === 'lane-rr');
    const headless = body.find((s) => s.id === 'lane-hl');
    expect(rerouted?.launchLane).toBe('rerouted-interactive');
    expect(headless?.launchLane).toBe('headless');
  });
});
