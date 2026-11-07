/**
 * GET /team/people through the full HTTP pipeline. Spec: docs/specs/team-roles-and-access.md §3.10.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ReachablePeople } from '../../src/users/ReachablePeople.js';
import type { InstarConfig } from '../../src/core/types.js';

const token = 'team-people-agent-token';

function boot(dir: string, people?: ReachablePeople) {
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'tp', authToken: token }));
  const config = {
    projectName: 'tp', projectDir: dir, stateDir, port: 0, authToken: token, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return new AgentServer({
    config, state: new StateManager(stateDir), reachablePeople: people,
    sessionManager: {
      listRunningSessions: () => [], getSession: () => null,
      memoryPrivacyStatus: () => ({ enabled: false, multiPerson: false, ownerUserId: null, sandboxReady: false, blocker: null, fix: null }),
      memoryAudienceKind: () => 'open',
    } as never,
  }).getApp();
}

describe('GET /team/people', () => {
  let dir: string;
  let app: ReturnType<typeof boot>;
  let bare: ReturnType<typeof boot>;
  let people: ReachablePeople;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-people-routes-'));
    people = new ReachablePeople({
      stateDir: path.join(dir, '.instar'), users: () => [], reachable: () => ({ slackAuthorizedIds: ['U1', 'U2'] }),
      sharedMemoryPeople: () => [], privacyOn: () => false, ownerUserId: () => null, ownerName: () => 'Ann', phones: () => [],
    });
    app = boot(dir, people);
    bare = boot(fs.mkdtempSync(path.join(dir, 'bare-')));
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/team-people-routes.test.ts' }));

  it('refuses without the agent token', async () => {
    expect((await request(app).get('/team/people')).status).toBe(401);
  });

  it('lists the people, the count and the privacy state', async () => {
    const res = await request(app).get('/team/people').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.privacyOn).toBe(false);
    expect(res.body.people.map((p: { name: string }) => p.name)).toContain('Ann');
    expect(res.body.pool).toBeUndefined();
  });

  it('a pool read with no peers is complete', async () => {
    const res = await request(app).get('/team/people?scope=pool').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual({ complete: true, failed: [] });
  });

  it('says unavailable, not empty, when the tracker is not wired', async () => {
    const res = await request(bare).get('/team/people').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
  });
});
