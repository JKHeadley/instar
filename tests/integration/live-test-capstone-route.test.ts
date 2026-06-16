/**
 * Route-level wiring-integrity test (Testing Integrity Standard) for the
 * Live-User-Channel Proof CAPSTONE runner (spec §6/§7.5): proves
 * POST /live-test/multi-machine-capstone is WIRED into the production HTTP pipeline.
 *   - 503 when the runner is dark (no ctx.liveTestRunnerCtx).
 *   - A wired run with a FAKE driver + a fake /pool/transfer: seatMoved:true → an
 *     artifact is recorded (PASS where the reply came FROM the target); seatMoved:false
 *     → a recorded 200 'aborted' (NOT a 500), and no artifact.
 *   - GET /live-test/artifacts lists recorded artifacts (503 when dark).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestHarness, type ChannelDriver, type ReplyResult } from '../../src/core/LiveTestHarness.js';
import { LiveTestRunner } from '../../src/core/LiveTestRunner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
const verify = (d: string, s: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64'));

interface TestServer { url: string; close: () => Promise<void>; dir: string; store: LiveTestArtifactStore }

/**
 * A fake driver whose every reply is attributed to `responderMachine` — so a scenario
 * expecting `responderMachine: target` PASSes when `responderMachine === target`.
 */
function fakeDriver(responderMachine: string): ChannelDriver {
  return {
    isDemoChannel: () => true,
    send: async () => ({ messageId: 'm1' }),
    awaitReply: async (): Promise<ReplyResult> => ({ text: 'agent reply', messageId: 'm2', responderMachineId: responderMachine }),
  };
}

function buildServer(opts: { dark?: boolean; seatMoves: boolean; responderMachine?: string }): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-route-'));
  const store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'm', signerFingerprint: 'm', sign, verify });
  const responder = opts.responderMachine ?? 'mini-001';
  const driver = fakeDriver(responder);

  const ctx: any = {
    config: { authToken: 'test', stateDir: dir, port: 0 },
    telegram: null,
    slack: null,
    liveTestRunnerCtx: opts.dark
      ? null
      : {
          artifactStore: store,
          runnerFingerprint: 'm',
          makeHarness: (d: ChannelDriver) => new LiveTestHarness({ store, driver: d, runnerFingerprint: 'm' }),
          makeRunner: (d: ChannelDriver) =>
            new LiveTestRunner({ harness: new LiveTestHarness({ store, driver: d, runnerFingerprint: 'm' }) }),
          driverForRequest: () => driver, // the test injection seam (fake driver)
        },
  };

  const app = express();
  app.use(express.json());
  // A controllable /pool/transfer stub the route's in-process fetch hits.
  app.post('/pool/transfer', (_req, res) => {
    res.json(opts.seatMoves ? { ok: true, seatMoved: true } : { ok: true, seatMoved: false, seatMoveReason: 'ownership did not transfer' });
  });
  app.use(createRoutes(ctx));

  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      ctx.config.port = port; // so the route's loopback fetch reaches THIS server
      resolve({
        url: `http://127.0.0.1:${port}`, dir, store,
        close: () => new Promise<void>((r) => srv.close(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/live-test-capstone-route.test.ts' }); } catch { /* */ } r(); })),
      });
    });
  });
}

async function runCapstone(url: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/live-test/multi-machine-capstone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /live-test/multi-machine-capstone — capstone runner wiring', () => {
  let server: TestServer;
  afterEach(async () => { if (server) await server.close(); });

  it('503s when the runner is dark (no liveTestRunnerCtx)', async () => {
    server = await buildServer({ dark: true, seatMoves: true });
    const { status, json } = await runCapstone(server.url, { targetMachine: 'mini-001', telegramTopicId: '13481' });
    expect(status).toBe(503);
    expect(json.error).toMatch(/not available/);
  });

  it('400s without targetMachine / telegramTopicId', async () => {
    server = await buildServer({ dark: false, seatMoves: true });
    const { status } = await runCapstone(server.url, { telegramTopicId: '13481' });
    expect(status).toBe(400);
  });

  it('seatMoved:true → runs the matrix and RECORDS a signed artifact (PASS from target)', async () => {
    server = await buildServer({ dark: false, seatMoves: true, responderMachine: 'mini-001' });
    const { status, json } = await runCapstone(server.url, { targetMachine: 'mini-001', telegramTopicId: '13481' });
    expect(status).toBe(200);
    expect(json.seatMoved).toBe(true);
    expect(json.capstone).toBe('ran');
    expect(json.artifact).toBeDefined();
    expect(json.artifact.featureId).toBe('multi-machine-transfer');
    // Every move-to-target scenario replied from mini-001 → all PASS.
    expect(json.artifact.scenarios.every((s: { verdict: string }) => s.verdict === 'PASS')).toBe(true);
    // The artifact is durably recorded (the gate would read THIS).
    expect(server.store.allEntries().length).toBe(1);
  });

  it('seatMoved:false → 200 "aborted", NO artifact recorded (honesty contract, not a 500)', async () => {
    server = await buildServer({ dark: false, seatMoves: false });
    const { status, json } = await runCapstone(server.url, { targetMachine: 'mini-001', telegramTopicId: '13481' });
    expect(status).toBe(200);
    expect(json.seatMoved).toBe(false);
    expect(json.capstone).toBe('aborted');
    expect(json.reason).toMatch(/ownership did not transfer/);
    expect(server.store.allEntries().length).toBe(0);
  });

  it('a reply from the WRONG machine → recorded FAIL (deterministic cross-machine proof)', async () => {
    server = await buildServer({ dark: false, seatMoves: true, responderMachine: 'laptop-999' });
    const { json } = await runCapstone(server.url, { targetMachine: 'mini-001', telegramTopicId: '13481' });
    expect(json.capstone).toBe('ran');
    expect(json.artifact.scenarios.every((s: { verdict: string }) => s.verdict === 'FAIL')).toBe(true);
  });

  it('GET /live-test/artifacts lists recorded artifacts (503 when dark)', async () => {
    server = await buildServer({ dark: false, seatMoves: true });
    await runCapstone(server.url, { targetMachine: 'mini-001', telegramTopicId: '13481' });
    const res = await fetch(`${server.url}/live-test/artifacts`, { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.count).toBe(1);
    expect(j.entries[0].featureId).toBe('multi-machine-transfer');
  });

  it('GET /live-test/artifacts 503s when dark', async () => {
    server = await buildServer({ dark: true, seatMoves: true });
    const res = await fetch(`${server.url}/live-test/artifacts`, { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(503);
  });
});
