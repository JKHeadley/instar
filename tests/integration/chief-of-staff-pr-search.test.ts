import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';
import { mountChiefOfStaffPrSearch } from '../../src/server/chiefOfStaffPrSearchRoutes.js';

const ownerToken = 'fixture-owner';
const prSearchPath = '/chief-of-staff/pr-search?q=instar.sh';

function server({ owner = true, enabled = true } = {}) {
  const authToken = owner ? ownerToken : undefined;
  const app = express();
  app.use(authMiddleware(authToken, 'echo', undefined, (req) => {
    if (req.header('X-Instar-Device') !== '1') return 'none';
    Object.assign(req, { instarPrincipal: { kind: 'device' } });
    return 'ok';
  }, undefined, undefined, token => token === 'dst_scoped-fixture'));
  mountChiefOfStaffPrSearch(app, { ownerToken: () => authToken, enabled: () => enabled });
  return app;
}

function row(number: number, title = 'Permanent agent links') {
  return {
    number, state: 'OPEN', title, body: 'Plan to use instar.sh',
    headRefName: 'topic/144473-permanent-agent-links', baseRefName: 'main', updatedAt: new Date().toISOString(), mergedAt: null,
  };
}

function githubPage(nodes: ReturnType<typeof row>[], cursor: string | null = null, errors?: unknown[]) {
  return new Response(JSON.stringify({
    data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } },
    errors,
  }));
}

function githubVariables(options: RequestInit) {
  return (JSON.parse(String(options.body)) as { variables: { states: string[]; cursor: string | null } }).variables;
}

function fakeGitHub() {
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github');
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const variables = githubVariables(options);
    return githubPage(variables.states[0] === 'OPEN' ? [row(3342)] : []);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Chief of Staff PR search over the agent HTTP router', () => {
  it('returns canonical links and coverage for an owner bearer without exposing bodies', async () => {
    const fetch = fakeGitHub();
    const app = server();
    const res = await request(app).get(prSearchPath).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      coverage: { open: { status: 'fresh' }, merged: { status: 'fresh' } },
      matchCount: 1,
      items: [{ number: 3342, url: 'https://github.com/JKHeadley/instar/pull/3342' }],
    });
    expect(res.body.items[0]).not.toHaveProperty('body');
    await request(app).get(prSearchPath).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => url === 'https://api.github.com/graphql')).toBe(true);
  });

  it('refuses scoped devices, dashboard tokens, and no-token setups before reading GitHub', async () => {
    const fetch = fakeGitHub();
    const app = server();
    await request(app).get(prSearchPath).expect(401);
    await request(app).get(prSearchPath).set('Authorization', 'Bearer dst_scoped-fixture').expect(403);
    await request(app).get(prSearchPath).set('Authorization', `Bearer ${ownerToken}`).set('X-Instar-Device', '1').expect(403);
    await request(server({ owner: false })).get(prSearchPath).expect(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a caller-selected repo and discloses source failure', async () => {
    const fetch = fakeGitHub();
    const app = server();
    const claims = { Authorization: `Bearer ${ownerToken}` };
    await request(app).get(`${prSearchPath}&repo=private/other`).set(claims).expect(400);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRejectedValue(new Error('GitHub unavailable'));
    const res = await request(app).get(prSearchPath).set(claims).expect(503);
    expect(res.body).toMatchObject({
      coverage: { open: { status: 'unavailable' }, merged: { status: 'unavailable' } },
      matchCount: null,
    });
  });
  it('feeds preserved public GitHub response bytes through the HTTPS transport and provider', async () => {
    const fetch = fakeGitHub();
    const captured = loadCapturedFixture('github-pr-search', 'open-pr-3342');
    fetch.mockResolvedValueOnce(new Response(captured));
    const result = await request(server()).get(prSearchPath).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(result.body.items[0]).toMatchObject({
      number: 3342, headRefName: 'topic/144473-permanent-agent-links',
      bodyMatchExcerpt: expect.stringMatching(/instar\.sh/i),
    });
    expect(result.body.items[0].bodyMatchExcerpt.length).toBeLessThanOrEqual(240);
  });

  it('binds continuation to the query and snapshot revision', async () => {
    fakeGitHub();
    const app = server();
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const first = await request(app).get(prSearchPath).set(auth).expect(200);
    const revision = first.body.revision as string;
    await request(app).get(`${prSearchPath}&offset=20&revision=${revision}`).set(auth).expect(200);
    await request(app).get(`/chief-of-staff/pr-search?q=other&offset=20&revision=${revision}`).set(auth).expect(409);
    await request(app).get(`${prSearchPath}&offset=20`).set(auth).expect(400);
  });

  it('rejects usable GraphQL rows and evicts both snapshots when a mixed response denies access', async () => {
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = fakeGitHub();
    const app = server();
    const auth = { Authorization: `Bearer ${ownerToken}` };
    await request(app).get(prSearchPath).set(auth).expect(200);
    time.mockReturnValue(now + 120_000);
    fetch.mockResolvedValueOnce(githubPage([row(3342)], null, [
      { type: 'RATE_LIMITED', message: 'provider internal throttle detail' },
      { type: 'FORBIDDEN', message: 'provider internal access detail' },
    ]));
    const result = await request(app).get(prSearchPath).set(auth).expect(503);
    expect(result.body).toMatchObject({
      coverage: { open: { status: 'unavailable' }, merged: { status: 'unavailable' } },
      knownMatchCount: null,
      items: [],
    });
    expect(result.text).not.toContain('provider internal');
  });

  it.each(['HTTP 403', 'GraphQL 200'])('retains stale evidence and honors a retry cooldown for %s throttling', async (form) => {
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = fakeGitHub();
    const app = server();
    const auth = { Authorization: `Bearer ${ownerToken}` };
    await request(app).get(prSearchPath).set(auth).expect(200);
    time.mockReturnValue(now + 120_000);
    const headers = { 'retry-after': '120' };
    const throttle = form === 'HTTP 403'
      ? new Response('internal throttle detail', { status: 403, headers })
      : new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }), { headers });
    fetch.mockResolvedValueOnce(throttle);
    const result = await request(app).get(prSearchPath).set(auth).expect(200);
    expect(result.body).toMatchObject({
      coverage: { open: { status: 'stale' } },
      items: [{ number: 3342 }],
    });
    expect(result.text).not.toContain('throttle detail');
    time.mockReturnValue(now + 235_000);
    await request(app).get(prSearchPath).set(auth).expect(200);
    expect(fetch).toHaveBeenCalledTimes(4);
    time.mockReturnValue(now + 240_001);
    const recovered = await request(app).get(prSearchPath).set(auth).expect(200);
    expect(recovered.body.coverage.open.status).toBe('fresh');
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('invalidates a continuation if prior contributing evidence expires between pages', async () => {
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = fakeGitHub();
    const app = server();
    const auth = { Authorization: `Bearer ${ownerToken}` };
    fetch.mockResolvedValueOnce(githubPage([row(3342, 'instar.sh')]));
    await request(app).get(prSearchPath).set(auth).expect(200);
    time.mockReturnValue(now + 590_000);
    fetch.mockImplementation(async (_url, options) => {
      const variables = githubVariables(options);
      if (variables.states[0] === 'MERGED') return githubPage([]);
      if (variables.cursor) throw new Error('unavailable');
      return githubPage(Array.from({ length: 21 }, (_, n) => row(n + 1)), 'second');
    });
    const first = await request(app).get(prSearchPath).set(auth).expect(200);
    expect(first.body.nextOffset).toBe(20);
    expect(first.body.items[0]).toMatchObject({ number: 3342, priorComplete: true });
    time.mockReturnValue(now + 600_001);
    await request(app).get(`${prSearchPath}&offset=20&revision=${first.body.revision}`).set(auth).expect(409);
    const restarted = await request(app).get(prSearchPath).set(auth).expect(200);
    expect(restarted.body.knownMatchCount).toBe(21);
    expect(restarted.body.items.some((item: { number: number }) => item.number === 3342)).toBe(false);
  });

  it('treats a 403 with ordinary positive quota headers and invalid retry advice as denial', async () => {
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = fakeGitHub();
    const app = server();
    const auth = { Authorization: `Bearer ${ownerToken}` };
    await request(app).get(prSearchPath).set(auth).expect(200);
    time.mockReturnValue(now + 120_000);
    fetch.mockResolvedValueOnce(new Response('Sensitive access details', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': '1795490000', 'retry-after': 'invalid' },
    }));
    const result = await request(app).get(prSearchPath).set(auth).expect(503);
    expect(result.body).toMatchObject({ matchCount: null, items: [] });
    expect(result.text).not.toContain('Sensitive access details');
  });

});
