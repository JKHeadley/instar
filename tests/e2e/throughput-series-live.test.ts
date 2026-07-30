import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createThroughputRoutes } from '../../src/server/throughputRoutes.js';

describe('Throughput series route is alive', () => {
  it('serves the real route contract through Express', async () => {
    // Dates are RELATIVE to now on purpose. The route keeps only PRs with
    // `cutoff <= mergedAt <= now` where `cutoff = now - days`, so hardcoded
    // fixture dates silently expire: the previous literals
    // (createdAt 2026-07-22T12:00:00Z, mergedAt 2026-07-23T12:00:00Z) fell out of
    // the rolling 7-day window at 2026-07-30T12:00:00Z and turned CI red on every
    // open PR — a test that passes for a week and then fails for a reason that has
    // nothing to do with the code under test. Anchoring to now removes the clock
    // from the assertion. The 24h created→merged gap is preserved deliberately:
    // `team.index` is derived from median latency, so changing the gap would move
    // the expected index below.
    const mergedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const createdAt = new Date(mergedAt.getTime() - 24 * 60 * 60 * 1000);
    const graphql = async () => ({
      search: {
        issueCount: 1,
        nodes: [{
            number: 42, title: 'Feature', author: { login: 'JKHeadley' },
            createdAt: createdAt.toISOString(), mergedAt: mergedAt.toISOString(),
            additions: 70, deletions: 30,
            reviews: { nodes: [] }, commits: { totalCount: 2 },
          }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const app = express().use(createThroughputRoutes({ graphql }));
    const response = await request(app).get('/throughput/series?days=7');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      repo: 'JKHeadley/instar',
      windowDays: 7,
      rows: [{ authors: { codey: { merges: 1 } }, team: { index: 80 } }],
    });
  });

  it('rejects windows outside the dashboard contract', async () => {
    const app = express().use(createThroughputRoutes());
    const response = await request(app).get('/throughput/series?days=90');
    expect(response.status).toBe(400);
    expect(response.body.allowed).toEqual([7, 14, 30]);
  });

  it('fails closed with a distinct error when no explicit GitHub identity exists', async () => {
    const app = express().use(createThroughputRoutes({
      stateDir: '/definitely/missing',
      env: {},
    }));
    const response = await request(app).get('/throughput/series?days=7');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'github-auth-unavailable' });
  });
});
