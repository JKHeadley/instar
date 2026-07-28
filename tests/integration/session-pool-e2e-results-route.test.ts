/**
 * Integration test (§Rollout): GET /session-pool/e2e-results — the observable
 * rollout-gate state, over the real Express route + a real SessionPoolE2EResultStore.
 * Asserts latest-per-stage + per-row verification, and the 503 when the gate is dark.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
}
const hmac = (c: string) => crypto.createHmac('sha256', 'k').update(c).digest('hex');

describe('GET /session-pool/e2e-results (§Rollout)', () => {
  let dir: string;
  function serve(store: SessionPoolE2EResultStore | null): Promise<Server> {
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, sessionPoolE2EResultStore: store };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return listen(app);
  }
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-route-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/session-pool-e2e-results-route.test.ts' }));

  it('503 when the gate is dark (no store wired)', async () => {
    const s = await serve(null);
    const r = await fetch(s.url + '/session-pool/e2e-results').then(async (x) => ({ status: x.status, body: await x.json() }));
    await s.close();
    expect(r.status).toBe(503);
  });

  it('returns the latest result per stage, each verified', async () => {
    const store = new SessionPoolE2EResultStore({ filePath: path.join(dir, 'r.json'), sign: hmac, verifySig: (c, sig) => hmac(c) === sig });
    store.recordResult(0, 'green', 'sha1', 'e0');
    store.recordResult(1, 'green', 'sha1', 'e1a');
    store.recordResult(1, 'red', 'sha1', 'e1b'); // supersedes the green for stage 1
    const s = await serve(store);
    const r = await fetch(s.url + '/session-pool/e2e-results').then(async (x) => ({ status: x.status, body: await x.json() }));
    await s.close();
    expect(r.status).toBe(200);
    const byStage = Object.fromEntries(r.body.latestPerStage.map((x: any) => [x.stage, x]));
    expect(byStage[0]).toMatchObject({ result: 'green', commitSha: 'sha1', verified: true });
    expect(byStage[1]).toMatchObject({ result: 'red', verified: true });   // latest wins
    expect(byStage[2]).toMatchObject({ result: null, verified: null });    // no result yet
    expect(r.body.total).toBe(3);                                          // append-only history
  });
});
