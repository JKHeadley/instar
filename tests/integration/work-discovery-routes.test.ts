import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ChiefOfStaffPrSearch } from '../../src/core/ChiefOfStaffPrSearch.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { createWorkDiscoveryRouter } from '../../src/server/workDiscoveryRoutes.js';

const WORK = '/work/discover';
const OWNER = { Authorization: 'Bearer dst_owner' };
const SECRET_QUERY = 'private-marker-4c97';

function harness(options: { budgetMs?: number; hold?: Promise<void>; includeLaterLiteral?: boolean } = {}) {
  let active = true;
  const fetchPage = vi.fn(async (_token: string, state: string) => {
    await options.hold;
    const nodes = state === 'OPEN' ? [{
      number: 3342, title: 'Permanent agent links', body: 'Design for instar.sh and a permanent address for each agent',
      headRefName: 'topic/links', baseRefName: 'main', state: 'OPEN' as const,
      updatedAt: '2026-11-23T00:00:00.000Z', mergedAt: null,
    }] : [];
    if (state === 'OPEN' && options.includeLaterLiteral) nodes.push({
      ...nodes[0], number: 9000, body: 'Question quoted in a later work log: instar.sh addresses for agents',
      updatedAt: '2026-11-24T00:00:00.000Z',
    });
    return { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
  });
  const readConversations = vi.fn(() => null);
  const app = express();
  app.use(WORK, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json());
  app.use(authMiddleware(
    () => 'agent-master', undefined, undefined,
    (req) => {
      const tier = req.get('X-Instar-Device');
      if (tier !== 'member' && tier !== 'guest') return 'none';
      Object.assign(req, { instarPrincipal: { kind: 'device' }, instarDevicePerson: { ok: true, role: 'team', tier } });
      return 'ok';
    },
    token => token === 'mps_shared' ? {
      sessionId: 'shared-session', placeKey: 'telegram:example', audience: { kind: 'place', placeKey: 'telegram:example' },
    } : null,
    undefined, token => token === 'dst_owner' && active,
  ));
  const pullRequestSource = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage });
  app.use(createWorkDiscoveryRouter({
    enabled: () => true,
    mayReadPrivateWork: (_req, res) => active && res.locals.dashboardScopedSession === true,
    conversationSource: readConversations,
    configuredMessaging: () => false,
    pullRequestSource,
    budgetMs: options.budgetMs,
  }));
  return { app, fetchPage, readConversations, pullRequestSource, revoke: () => { active = false; } };
}

describe('work discovery HTTP boundary', () => {
  it('returns an explicitly partial read and keeps the phrase out of PR refresh callbacks', async () => {
    const { app, fetchPage, readConversations } = harness();
    const result = await request(app).post(WORK).set(OWNER).send({ query: 'instar.sh' }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({
      version: 1, status: 'partial',
      candidates: [{ kind: 'pull-request', number: 3342, state: 'OPEN', matchedBy: 'literal' }],
      coverage: {
        conversations: { status: 'unavailable', peers: 'unsearched' },
        pullRequests: { status: 'fresh', open: { status: 'fresh' }, merged: { status: 'fresh' } },
        gitRefs: { status: 'unsearched' }, projects: { status: 'unsearched' }, jobs: { status: 'unsearched' },
      },
    });
    expect(readConversations).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const miss = await request(app).post(WORK).set(OWNER).send({ query: SECRET_QUERY }).expect(200);
    expect(miss.body).toMatchObject({ status: 'partial', candidates: [] });
    expect(JSON.stringify(fetchPage.mock.calls)).not.toContain('instar.sh');
    expect(JSON.stringify(fetchPage.mock.calls)).not.toContain(SECRET_QUERY);
    expect(miss.text).not.toContain(SECRET_QUERY);
  });

  it('finds all meaningful terms in public PR fields on cold and warm Work queries', async () => {
    const { app, fetchPage, pullRequestSource } = harness();
    const query = 'instar.sh addresses for agents';
    for (let retry = 0; retry < 2; retry++) {
      const result = await request(app).post(WORK).set(OWNER).send({ query }).expect(200);
      expect(result.body).toMatchObject({
        candidates: [{ kind: 'pull-request', number: 3342, matchedBy: 'all-terms' }],
        coverage: { pullRequests: { status: 'fresh', method: 'all-terms' } },
      });
      expect(result.text).not.toContain(query);
    }
    await expect(pullRequestSource.search(query)).resolves.toMatchObject({ matchKind: 'literal', items: [] });
    for (const miss of ['instar.sh addresses for widgets', 'instar.sh addresses for agents #9999', 'instar.shx addresses for agents']) {
      const result = await request(app).post(WORK).set(OWNER).send({ query: miss }).expect(200);
      expect(result.body.candidates).toEqual([]);
    }
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetchPage.mock.calls)).not.toMatch(/instar\.sh|addresses|agents/);
  });

  it('ranks a later literal match first and still finds the earlier term match', async () => {
    const { app, pullRequestSource } = harness({ includeLaterLiteral: true });
    const query = 'instar.sh addresses for agents';
    const response = await request(app).post(WORK).set(OWNER).send({ query }).expect(200);
    expect(response.body).toMatchObject({
      candidates: [{ number: 9000, matchedBy: 'literal' }, { number: 3342, matchedBy: 'all-terms' }],
      coverage: { pullRequests: { method: 'literal-and-all-terms' } },
    });
    const legacy = await pullRequestSource.search(query);
    expect(legacy.matchKind).toBe('literal');
    expect(legacy.items.map(item => item.number)).toEqual([9000]);
    expect(legacy.items[0]).not.toHaveProperty('matchedBy');
  });

  it('rejects untrusted and masquerading requests before touching providers', async () => {
    const { app, fetchPage, readConversations } = harness();
    const check = (headers: Record<string, string>) =>
      request(app).post(WORK).set(headers).send({ query: SECRET_QUERY, destination: 'private-work' });
    for (const [headers, status] of [
      [{}, 401], [{ Authorization: 'Bearer agent-master' }, 403],
      [{ 'X-Instar-Device': 'member' }, 403], [{ 'X-Instar-Device': 'guest' }, 403], [{ Authorization: 'Bearer mps_shared' }, 403],
      [OWNER, 400],
    ] as const) {
      const response = await check(headers).expect(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toContain(SECRET_QUERY);
    }
    await request(app).post(WORK + '?query=' + SECRET_QUERY).set(OWNER).send({ query: 'instar.sh' }).expect(400);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(readConversations).not.toHaveBeenCalled();
  });

  it('stops waiting at its lookup deadline and discards results after session revocation', async () => {
    let finish!: () => void;
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const bounded = harness({ budgetMs: 5, hold });
    try {
      const timeout = await request(bounded.app).post(WORK).set(OWNER).send({ query: 'instar.sh' }).expect(503);
      expect(timeout.body).toMatchObject({ status: 'unavailable', candidates: [], coverage: { pullRequests: { status: 'unavailable' } } });
      const revoking = harness({ hold });
      const pending = request(revoking.app).post(WORK).set(OWNER).send({ query: 'instar.sh' }).then(r => r);
      await vi.waitFor(() => expect(revoking.fetchPage).toHaveBeenCalled(), { interval: 5 });
      revoking.revoke();
      finish();
      const revoked = await pending;
      expect(revoked.status).toBe(403);
      expect(revoked.body).toEqual({ error: 'private-work-session-required' });
      expect(revoking.readConversations).not.toHaveBeenCalled();
    } finally {
      finish();
    }
  });
});
