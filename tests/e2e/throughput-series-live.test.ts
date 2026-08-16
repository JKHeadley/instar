import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createThroughputRoutes } from '../../src/server/throughputRoutes.js';

describe('Throughput series route is alive', () => {
  it('serves the real route contract through Express', async () => {
    // Dates are RELATIVE to now, deliberately. They were hardcoded to
    // 2026-07-22/23, which sat inside the 7-day window when the test was written
    // and silently fell out of it on 2026-07-30 — the route then returned an
    // empty series and the test failed for a reason that had nothing to do with
    // the code. A fixture that expires is a test with a hidden clock in it.
    const daysAgo = (n: number): string =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    const graphql = async () => ({
      search: {
        issueCount: 1,
        nodes: [{
            number: 42, title: 'Feature', author: { login: 'JKHeadley' },
            createdAt: daysAgo(3), mergedAt: daysAgo(2),
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
