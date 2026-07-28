/**
 * Route-level wiring-integrity test (Testing Integrity Standard) for the
 * Live-User-Channel Proof completion gate (spec §4): proves the LiveTestGate is
 * actually WIRED into the production POST /autonomous/evaluate-completion path (not
 * dead code). A met:true verdict for a user-facing feature with no verified artifact
 * is OVERRIDDEN to met:false in veto mode, SURFACED-but-honored in dry-run, and
 * ALLOWED once a verified artifact exists. With no gate in ctx, the verdict passes
 * through unchanged (today's behavior).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { LiveTestArtifactStore, type LiveTestArtifact } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestGate, type LiveTestGateMode } from '../../src/core/LiveTestGate.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
const verify = (d: string, s: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64'));

interface TestServer { url: string; close: () => Promise<void>; dir: string; store: LiveTestArtifactStore }

function buildServer(opts: { met: boolean; mode: LiveTestGateMode | null }): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltg-route-'));
  const store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'm', signerFingerprint: 'm', sign, verify });
  const ctx: any = {
    config: { authToken: 'test', stateDir: dir, port: 0 },
    completionEvaluator: { evaluate: async () => ({ met: opts.met, reason: opts.met ? 'goal met' : 'not yet' }) },
    liveTestGate: opts.mode ? new LiveTestGate(store) : null,
    liveTestGateMode: opts.mode ?? 'dry-run',
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, dir, store, close: () => new Promise<void>((r) => srv.close(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* */ } r(); })) });
    });
  });
}

async function evaluate(url: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${url}/autonomous/evaluate-completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function goodArtifact(featureId: string): LiveTestArtifact {
  return {
    featureId, runId: 'r', surfaces: ['telegram', 'slack'], riskCategories: ['happy-path', 'channel-parity'],
    scenarios: [
      { id: 'a', description: 'tg', surface: 'telegram', riskCategory: 'happy-path', verdict: 'PASS' },
      { id: 'b', description: 'sl', surface: 'slack', riskCategory: 'happy-path', verdict: 'PASS' },
      { id: 'c', description: 'parity', surface: 'slack', riskCategory: 'channel-parity', verdict: 'PASS' },
    ],
    createdAt: '2026-06-15T20:00:00.000Z', runnerFingerprint: 'm',
  };
}

describe('POST /autonomous/evaluate-completion — LiveTestGate wiring', () => {
  let server: TestServer;
  afterEach(async () => { if (server) await server.close(); });

  it('veto mode: met:true for a user-facing feature with NO artifact is OVERRIDDEN to met:false', async () => {
    server = await buildServer({ met: true, mode: 'veto' });
    const r = await evaluate(server.url, { condition: 'move the seat between machines', userFacing: true, featureId: 'transfer' });
    expect(r.met).toBe(false);
    expect(r.liveTestGate.overrode).toBe(true);
    expect(r.reason).toContain('live-test gate');
  });

  it('dry-run mode: the veto is SURFACED but the original met:true verdict is honored', async () => {
    server = await buildServer({ met: true, mode: 'dry-run' });
    const r = await evaluate(server.url, { condition: 'move the seat between machines', userFacing: true, featureId: 'transfer' });
    expect(r.met).toBe(true);
    expect(r.liveTestGate.wouldBlock).toBe(true);
    expect(r.liveTestGate.overrode).toBe(false);
  });

  it('veto mode: ALLOWS once a verified artifact exists', async () => {
    server = await buildServer({ met: true, mode: 'veto' });
    server.store.write(goodArtifact('transfer'));
    const r = await evaluate(server.url, { condition: 'move the seat', userFacing: true, featureId: 'transfer' });
    expect(r.met).toBe(true);
    expect(r.liveTestGate).toBeUndefined(); // allow → no override envelope
  });

  it('a met:false verdict passes through untouched (gate only post-checks a met:true)', async () => {
    server = await buildServer({ met: false, mode: 'veto' });
    const r = await evaluate(server.url, { condition: 'move the seat', userFacing: true, featureId: 'transfer' });
    expect(r.met).toBe(false);
    expect(r.reason).toBe('not yet');
  });

  it('with NO gate wired, the verdict passes through unchanged (today\'s behavior)', async () => {
    server = await buildServer({ met: true, mode: null });
    const r = await evaluate(server.url, { condition: 'move the seat', userFacing: true, featureId: 'transfer' });
    expect(r.met).toBe(true);
    expect(r.liveTestGate).toBeUndefined();
  });

  it('a non-user-facing goal is allowed even with no artifact (gate scoped to user-facing)', async () => {
    server = await buildServer({ met: true, mode: 'veto' });
    const r = await evaluate(server.url, { condition: 'optimize the token ledger sqlite index', userFacing: false, featureId: 'tokens' });
    expect(r.met).toBe(true);
  });
});
