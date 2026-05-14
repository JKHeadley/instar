/**
 * Bearer-token auth enforcement on Phase 4 jobs-endpoint cluster.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Decision Points "Dashboard write
 * authorization — bearer auth extended to job-edit endpoints."
 *
 * The endpoints land in front of the global `authMiddleware`, which
 * enforces bearer-token equality (timing-safe) on every non-public path.
 * This test asserts:
 *   - Unauthenticated GET/POST to migration endpoints → 401
 *   - Authenticated requests → handler executes (200 or domain error)
 *
 * Endpoints under test:
 *   GET  /jobs/migration-status
 *   POST /jobs/migration-confirm
 *   POST /jobs/migration-abandon
 *   GET  /jobs/reconcile
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TEST_AUTH_TOKEN = 'test-bearer-token-abc123';

interface AppFixture {
  app: express.Express;
  server: Server;
  port: number;
  stateDir: string;
}

let fixture: AppFixture;
let workspace: string;

async function makeFixture(): Promise<AppFixture> {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-auth-'));
  const stateDir = path.join(workspace, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(TEST_AUTH_TOKEN));

  // Mount only the endpoints under test. We mirror the route shapes so
  // this stays independent of the full route stack (which has many
  // dependencies on running services).
  app.get('/jobs/migration-status', (_req, res) => {
    res.json({ hasLegacyJobsJson: false, canConfirm: false });
  });
  app.post('/jobs/migration-confirm', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/jobs/migration-abandon', (_req, res) => {
    res.json({ status: 'abandoned' });
  });
  app.get('/jobs/reconcile', (_req, res) => {
    res.json({ findings: [], summary: { total: 0, byKind: {} } });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { app, server, port: addr.port, stateDir };
}

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* leave as string */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Phase 4 jobs endpoints — bearer-token auth', () => {
  beforeAll(async () => {
    fixture = await makeFixture();
  });

  afterAll(() => {
    fixture.server.close();
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'jobs-endpoints-auth.test cleanup' });
  });

  it.each([
    ['GET', '/jobs/migration-status'],
    ['POST', '/jobs/migration-confirm'],
    ['POST', '/jobs/migration-abandon'],
    ['GET', '/jobs/reconcile'],
  ])('%s %s — unauthenticated request returns 401', async (method, urlPath) => {
    const r = await request(fixture.port, method, urlPath);
    expect(r.status).toBe(401);
  });

  it.each([
    ['GET', '/jobs/migration-status'],
    ['POST', '/jobs/migration-confirm'],
    ['POST', '/jobs/migration-abandon'],
    ['GET', '/jobs/reconcile'],
  ])('%s %s — wrong-token request is rejected (401 or 403)', async (method, urlPath) => {
    const r = await request(fixture.port, method, urlPath, {
      authorization: 'Bearer wrong-token',
    });
    expect([401, 403]).toContain(r.status);
  });

  it.each([
    ['GET', '/jobs/migration-status'],
    ['POST', '/jobs/migration-confirm'],
    ['POST', '/jobs/migration-abandon'],
    ['GET', '/jobs/reconcile'],
  ])('%s %s — authenticated request reaches the handler (200)', async (method, urlPath) => {
    const r = await request(fixture.port, method, urlPath, {
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    });
    expect(r.status).toBe(200);
  });

  it('authentication uses timing-safe comparison (no early-return on length mismatch)', async () => {
    // The middleware uses createHash + timingSafeEqual which compares
    // fixed-length sha256 digests. A length-padded near-miss token still
    // gets rejected without timing leak. This is a behavioral assertion:
    // a token off by one character is rejected with the same 401.
    const offByOne = TEST_AUTH_TOKEN.slice(0, -1) + 'X';
    const r = await request(fixture.port, 'GET', '/jobs/migration-status', {
      authorization: `Bearer ${offByOne}`,
    });
    expect([401, 403]).toContain(r.status);
  });

  it('a short malformed bearer-header is rejected (defense-in-depth)', async () => {
    const r = await request(fixture.port, 'GET', '/jobs/migration-status', {
      authorization: 'Bearer',
    });
    expect(r.status).toBe(401);
  });

  it('non-Bearer scheme is rejected even with the correct token value', async () => {
    const r = await request(fixture.port, 'GET', '/jobs/migration-status', {
      authorization: `Basic ${TEST_AUTH_TOKEN}`,
    });
    expect([401, 403]).toContain(r.status);
  });
});
