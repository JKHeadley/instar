/**
 * E2E (HTTP) lifecycle test for the agent digital passport (EXO 3.0). Tier-3:
 * boots a REAL Express server on a real port with a REAL ORG-INTENT.md and makes
 * REAL HTTP calls. Key assertion: the feature is ALIVE — GET /passport and
 * POST /passport/verify return 200 (not 404/503) and behave end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Agent digital passport — (E2E over HTTP)', () => {
  let server: TestServer, tmpDir: string, stateDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Echo',
      '## Constraints (Mandatory — agents cannot override)',
      '- Never delete the production database.',
    ].join('\n'));
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { projectName: 'echo', authToken: 'test', stateDir, port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => { await server?.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('FEATURE IS ALIVE: GET /passport returns 200 with the passport', async () => {
    const res = await fetch(server.url + '/passport');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent).toBe('echo');
    expect(body.forbiddenActions).toContain('Never delete the production database.');
  });

  it('FEATURE IS ALIVE: POST /passport/verify denies a forbidden action end-to-end', async () => {
    const passport = (await (await fetch(server.url + '/passport')).json());
    const res = await fetch(server.url + '/passport/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passport, action: 'delete the production database now' }),
    });
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.permitted).toBe(false);
    expect(v.basis).toBe('forbidden-action');
  });
});
