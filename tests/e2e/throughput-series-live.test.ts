import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createThroughputRoutes } from '../../src/server/throughputRoutes.js';

describe('Throughput series route is alive', () => {
  it('serves the real route contract through Express', async () => {
    const run = async (args: string[]) => args[0] === 'pr'
      ? {
          code: 0, stderr: '', stdout: JSON.stringify([{
            number: 42, title: 'Feature', author: { login: 'JKHeadley' },
            createdAt: '2026-07-22T12:00:00Z', mergedAt: '2026-07-23T12:00:00Z',
            additions: 70, deletions: 30,
          }]),
        }
      : {
          code: 0, stderr: '', stdout: JSON.stringify({ data: { repository: {
            p42: { reviews: { nodes: [] }, commits: { totalCount: 2 } },
          } } }),
        };
    const app = express().use(createThroughputRoutes({ run }));
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
});
