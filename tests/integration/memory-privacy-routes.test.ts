/**
 * Integration — the session token against the full HTTP pipeline.
 * Spec: docs/specs/memory-privacy.md §5.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { MemoryPrivacyRecovery } from '../../src/users/MemoryPrivacyRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('memory privacy routes (integration)', () => {
  let dir: string;
  let app: Parameters<typeof request>[0];
  let sessionToken: string;
  let noneToken: string;
  const agentToken = 'agent-token-for-test';
  let repairs = 0;
  const recovery = new MemoryPrivacyRecovery({
    facts: () => ({ blocker: 'claude-too-old', platform: 'darwin', floor: '2.1.316', haveVersion: '2.1.300', candidate: '/opt/<b>/claude' }),
    repair: async () => { repairs += 1; return true; },
    linkFor: (p) => p,
  });
  const freshLink = () => /\/memory-privacy\/fix\/[A-Za-z0-9_-]{43}/.exec(recovery.ownerMessage())?.[0] as string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-privacy-routes-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'mp', authToken: agentToken }));
    const config = {
      projectName: 'mp', projectDir: dir, stateDir, port: 0, authToken: agentToken, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const privacy = new MemoryPrivacy({
      stateDir, instarRoot: dir, agentId: 'mp', config: () => ({}), users: () => [],
      reachable: () => ({ slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' }),
    });
    sessionToken = privacy.issueSessionToken('s1', { kind: 'person', userId: 'b' }, 'slack:D2');
    noneToken = privacy.issueSessionToken('s2', { kind: 'none' }, null);
    const server = new AgentServer({
      config, state: new StateManager(stateDir), memoryPrivacy: privacy,
      sessionManager: {
        listRunningSessions: () => [], getSession: () => null,
        memoryPrivacyStatus: () => ({ enabled: true, multiPerson: true, ownerUserId: null, sandboxReady: true }),
        memoryAudienceKind: () => 'open',
        memoryPrivacyRecovery: () => recovery,
      } as never,
    });
    app = server.getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/memory-privacy-routes.test.ts' }));

  const as = (token: string, route: string) => request(app).get(route).set('Authorization', `Bearer ${token}`);

  it('the owner link opens with no token, shows the cause escaped, and changes nothing', async () => {
    const link = freshLink();
    const before = repairs;
    for (let i = 0; i < 2; i++) {
      const page = await request(app).get(link);
      expect(page.status).toBe(200);
      expect(page.text).toContain('2.1.300');
      expect(page.text).not.toContain('<b>');
      expect(page.headers['cache-control']).toContain('no-store');
    }
    expect(repairs).toBe(before);
  });

  it('a cause with no repair still opens a page, with no button to press', async () => {
    const link = /\/memory-privacy\/fix\/[A-Za-z0-9_-]{43}/.exec(recovery.ownerMessage('framework'))?.[0] as string;
    const page = await request(app).get(link);
    expect(page.status).toBe(200);
    expect(page.text).toContain('needs Claude Code');
    expect(page.text).not.toContain('<form');
  });

  it('the owner link repairs on POST and only once', async () => {
    const link = freshLink();
    const before = repairs;
    expect((await request(app).post(link)).status).toBe(200);
    expect(repairs).toBe(before + 1);
    expect((await request(app).post(link)).status).toBe(410);
    expect((await request(app).get(link)).status).toBe(410);
    expect(repairs).toBe(before + 1);
  });

  it('a well-formed guess is refused and repairs nothing', async () => {
    const before = repairs;
    freshLink();
    const guess = `/memory-privacy/fix/${'a'.repeat(43)}`;
    expect((await request(app).get(guess)).status).toBe(410);
    expect((await request(app).post(guess)).status).toBe(410);
    expect(repairs).toBe(before);
  });

  it.each(['/memory-privacy/fix/short', `/memory-privacy/fix/${'a'.repeat(43)}/more`, '/memory-privacy/fix/'])('%s stays behind the normal auth wall', async (route) => {
    expect((await request(app).post(route)).status).toBe(401);
  });

  it('the auth exemption does not reach the status route', async () => {
    expect((await request(app).get('/memory-privacy')).status).toBe(401);
  });

  it('reports status to the agent token', async () => {
    const res = await as(agentToken, '/memory-privacy');
    expect(res.status).toBe(200);
    expect(res.body.multiPerson).toBe(true);
  });

  it.each(['/memory-privacy', '/api/files/read?path=.instar/MEMORY.md', '/sessions', '/semantic/search?q=x', '/memory/search?q=x', '/relationships', '/context/working-memory', '/feedback', '/shared-state/render'])(
    'refuses a session token on %s', async (route) => {
      const res = await as(sessionToken, route);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not-available-to-this-session');
    });

  it('refuses an unknown session token as unauthenticated', async () => {
    expect((await as('mps_madeup', '/memory-privacy')).status).toBe(401);
  });

  it('lets a session report feedback but not read it', async () => {
    const post = await request(app).post('/feedback').set('Authorization', `Bearer ${sessionToken}`).send({});
    expect(post.status).not.toBe(403);
    expect((await as(sessionToken, '/feedback')).status).toBe(403);
  });

  it('gives no session the history routes', async () => {
    expect((await as(noneToken, '/commitments')).status).toBe(403);
    expect((await as(sessionToken, '/commitments')).status).toBe(403);
    expect((await as(sessionToken, '/topic/context/5?assembled=true')).status).toBe(403);
  });

  it('refuses reply files from a session inside the boundary', async () => {
    const res = await request(app).post('/app/session-reply').set('Authorization', `Bearer ${sessionToken}`)
      .send({ conversationId: 1, text: 'x', files: [{ path: '.instar/MEMORY.md' }] });
    expect(res.status).toBe(403);
  });

  it('leaves ping public', async () => {
    expect((await request(app).get('/ping')).status).toBe(200);
  });
});
