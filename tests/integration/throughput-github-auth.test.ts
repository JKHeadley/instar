import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createThroughputRoutes } from '../../src/server/throughputRoutes.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-auth-integration-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/throughput-github-auth.test.ts',
  });
});

describe('Throughput explicit GitHub identity integration', () => {
  it('reads github_token from the agent vault and sends it to direct GraphQL', async () => {
    new SecretStore({ stateDir, forceFileKey: true }).set('github_token', 'vault-agent-token');
    let authorization: string | null = null;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({
        data: {
          search: {
            issueCount: 1,
            nodes: [{
              number: 77,
              title: 'Fix',
              author: { login: 'EchoOfDawn' },
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              mergedAt: new Date(Date.now() - 1_000).toISOString(),
              additions: 4,
              deletions: 1,
              reviews: { nodes: [] },
              commits: { totalCount: 1 },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const app = express().use(createThroughputRoutes({
      stateDir,
      env: {},
      fetchImpl,
    }));

    const response = await request(app).get('/throughput/series?days=7');
    expect(response.status).toBe(200);
    expect(response.body.rows[0].authors.echo.merges).toBe(1);
    expect(authorization).toBe('Bearer vault-agent-token');
  });
});
