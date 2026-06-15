// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * E2E (HTTP) lifecycle test for POST /action-claim/observe (Action-Claim
 * Follow-Through Sentinel). Tier-3: boots a REAL Express server on a real port and
 * makes REAL HTTP calls. Key assertion: the feature is ALIVE — 200, not 404/503 —
 * and a concrete future-action claim actually opens a follow-through commitment
 * end-to-end (visible via GET /commitments).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('POST /action-claim/observe — (E2E over HTTP)', () => {
  let server: TestServer;
  let tmpDir: string;
  let tracker: CommitmentTracker;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ authToken: 'test', port: 0, messaging: { actionClaim: { enabled: true } } }));
    const liveConfig = new LiveConfig(tmpDir);
    tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner' });
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 'test', stateDir: tmpDir, port: 0 }, liveConfig, commitmentTracker: tracker, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => { await server?.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function observe(body: object) {
    const res = await fetch(server.url + '/action-claim/observe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('FEATURE IS ALIVE: a concrete future-action claim returns 200 and opens a commitment', async () => {
    const r = await observe({ message: "I'll restart the server now to apply the change.", topicId: 4242 });
    expect(r.status).toBe(200); // not 404/503 — the route exists and runs
    expect(r.body).toMatchObject({ observed: true, registered: true, verb: 'restart' });
    // the commitment is REAL and open for the topic
    const open = tracker.getActive().filter((c) => c.topicId === 4242);
    expect(open).toHaveLength(1);
    expect(open[0].externalKey).toMatch(/^actionclaim:/);
  });

  it('a benign (non-claim) message is alive but registers nothing', async () => {
    const r = await observe({ message: "I'll take a look and circle back later.", topicId: 4242 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ observed: true, registered: false });
    expect(tracker.getActive()).toHaveLength(0);
  });
});
