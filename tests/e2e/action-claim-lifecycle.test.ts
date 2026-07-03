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

// slack-followthrough-generalization §9.3 — the Slack (minted-id) lane is ALIVE on
// the production-init path: a time-boxed promise on a NEGATIVE minted id, with a
// valid spawn-env bind token, opens a durably-bound, beacon-armed commitment.
describe('POST /action-claim/observe — Slack minted-id lane is ALIVE (E2E over HTTP)', () => {
  let server: TestServer;
  let tmpDir: string;
  let tracker: CommitmentTracker;
  let token: string;
  const MINTED = -4242;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-slack-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ authToken: 'test', port: 0, developmentAgent: true, messaging: { actionClaim: { enabled: true, slack: { dryRun: false } } } }),
    );
    const liveConfig = new LiveConfig(tmpDir);
    const conversationBinder = {
      bind: (id: number) => ({ ok: true as const, boundTuple: { platform: 'slack' as const, channelId: 'C_TEST', threadTs: String(id) } }),
      release: () => {},
    };
    tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner', conversationBinder });
    const { createConversationBindAuth } = await import('../../src/core/conversationBindToken.js');
    const auth = createConversationBindAuth(tmpDir);
    token = auth.mint('agent-slack-thread', [MINTED]);
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0, developmentAgent: true },
      liveConfig, commitmentTracker: tracker, conversationBindAuth: auth, telegram: null, startTime: new Date(),
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => { await server?.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('FEATURE IS ALIVE: a minted-id time-promise + valid token opens a bound, beacon-armed commitment', async () => {
    const res = await fetch(server.url + '/action-claim/observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', 'X-Instar-Bind-Token': token },
      body: JSON.stringify({ message: "I'll post the check-in note here in about 5 minutes.", topicId: MINTED }),
    });
    expect(res.status).toBe(200); // not 404/503 — alive
    const body = await res.json();
    expect(body).toMatchObject({ observed: true, registered: true, lane: 'time', beaconEnabled: true });
    const open = tracker.getActive().filter((c) => c.topicId === MINTED);
    expect(open).toHaveLength(1);
    expect(open[0].externalKey).toMatch(/^timepromise:/);
    expect(open[0].boundTuple).toBeTruthy();
    expect(open[0].beaconEnabled).toBe(true);
  });

  it('the same minted-id promise WITHOUT a token is refused 403 (fail-closed), no row', async () => {
    const res = await fetch(server.url + '/action-claim/observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ message: "I'll post the note here in about 5 minutes.", topicId: MINTED }),
    });
    expect(res.status).toBe(403);
    expect(tracker.getActive()).toHaveLength(0);
  });
});
