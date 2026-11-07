/**
 * Tier-2 integration for resource-aware placement (docs/specs/resource-aware-placement.md §6):
 * GET /pool/placement/preview and POST /pool/heavy-work/spawn through the real route
 * stack (createRoutes) with a real MachinePoolRegistry fed load-report heartbeats, and a
 * stub peer server standing in for the chosen machine's POST /sessions/spawn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GIB = 1024 ** 3;
interface Server { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function report(cores: number, memGiB: number, loadPerCore: number, verdict: MachineLoadReport['verdict'] = 'ok'): MachineLoadReport {
  return {
    bootId: 'boot', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: memGiB * GIB, loadPerCore,
    cpuIdlePct: 40, memAvailablePct: 40, memPressureNative: 'normal', eventLoopLagP99Ms: 5, sessionsActive: 1, sessionsMax: 10,
    spawnCapSaturated: false, testRunnerSaturated: false, verdict, uptimeS: 1000,
  };
}

describe('resource-aware placement routes', () => {
  let dir: string;
  let registry: MachinePoolRegistry;
  let server: Server;
  let peer: Server;
  let peerCalls: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
  let peerAnswer: { status: number; body: Record<string, unknown> };
  let peerUrls: Array<{ machineId: string; url: string; kind: string }>;
  const SELF = 'm_studio';

  function beat(machineId: string, r: MachineLoadReport, loadAvg: number) {
    registry.recordHeartbeat({ machineId, selfReportedLastSeen: new Date().toISOString(), loadAvg, loadReport: r } as never);
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-'));
    registry = new MachinePoolRegistry({
      listMachines: () => [
        { machineId: SELF, nickname: 'Mac Studio' },
        { machineId: 'm_m5', nickname: 'Mac M5 Pro' },
        { machineId: 'm_mini', nickname: 'Mac Mini' },
      ],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    beat(SELF, report(16, 64, 1.5, 'saturated'), 24);
    beat('m_m5', report(18, 48, 0.6), 10.8);
    beat('m_mini', report(10, 16, 0.2), 2);

    peerCalls = [];
    peerAnswer = { status: 201, body: { tmuxSession: 'echo-heavy-helper', name: 'heavy-helper' } };
    const peerApp = express();
    peerApp.use(express.json());
    peerApp.post('/sessions/spawn', (req, res) => {
      peerCalls.push({ auth: req.headers.authorization, body: req.body });
      res.status(peerAnswer.status).json(peerAnswer.body);
    });
    peer = await listen(peerApp);
    peerUrls = [{ machineId: 'm_m5', url: peer.url, kind: 'lan' }];

    const ctx: Record<string, unknown> = {
      config: { authToken: 'test-token', stateDir: dir, port: 0 },
      stateDir: dir,
      machinePoolRegistry: registry,
      meshSelfId: SELF,
      resolvePeerUrls: () => peerUrls,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx as never));
    server = await listen(app);
  });

  afterEach(async () => {
    await server.close();
    await peer.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/resource-aware-placement-routes.test.ts' });
  });

  async function api(p: string, init?: RequestInit) {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
  }
  const spawn = (body: Record<string, unknown>, intent = true) => api('/pool/heavy-work/spawn', {
    method: 'POST', body: JSON.stringify(body), headers: intent ? { 'X-Instar-Request': '1' } : {},
  });

  describe('GET /pool/placement/preview', () => {
    it('heavy → the big machine with room, with a why for every machine', async () => {
      const r = await api('/pool/placement/preview?workWeight=heavy');
      expect(r.status).toBe(200);
      expect(r.body.answeredBy).toEqual({ machineId: SELF, nickname: 'Mac Studio' });
      expect(r.body.decision).toMatchObject({ chosenMachine: 'm_m5', chosenNickname: 'Mac M5 Pro', outcome: 'placed' });
      const why = Object.fromEntries(r.body.machines.map((m: any) => [m.nickname, m.why]));
      expect(why).toEqual({ 'Mac Studio': 'machine-busy', 'Mac M5 Pro': 'fits', 'Mac Mini': 'machine-too-small' });
    });
    it('light → the idle small machine is allowed', async () => {
      const r = await api('/pool/placement/preview?workWeight=light');
      expect(r.body.decision.chosenMachine).toBe('m_mini');
    });
    it('command adds only the signal-only guess', async () => {
      const r = await api('/pool/placement/preview?workWeight=heavy&command=' + encodeURIComponent('xcodebuild -scheme App'));
      expect(r.body.inferred).toEqual({ weight: 'heavy', matched: 'xcodebuild' });
    });
    it('400 on a bad weight or an over-long command', async () => {
      expect((await api('/pool/placement/preview?workWeight=huge')).status).toBe(400);
      expect((await api('/pool/placement/preview?workWeight=heavy&command=' + 'x'.repeat(2001))).status).toBe(400);
    });
  });

  describe('POST /pool/heavy-work/spawn', () => {
    it('403 without the intent header', async () => {
      expect((await spawn({ name: 'heavy-helper', prompt: 'build' }, false)).status).toBe(403);
    });
    it('400 on a name that would need a topic (a placed helper is headless)', async () => {
      const r = await spawn({ name: 'lane2-build', prompt: 'build' });
      expect(r.status).toBe(400);
      expect(peerCalls).toHaveLength(0);
    });
    it('started: forwarded once to the chosen machine\'s /sessions/spawn with the agent token and the heavy weight', async () => {
      const r = await spawn({ name: 'heavy-helper', prompt: 'build the app' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ outcome: 'started', machine: 'm_m5', nickname: 'Mac M5 Pro', sessionName: 'echo-heavy-helper' });
      expect(peerCalls).toHaveLength(1);
      expect(peerCalls[0].auth).toBe('Bearer test-token');
      expect(peerCalls[0].body).toEqual({ name: 'heavy-helper', prompt: 'build the app', workWeight: 'heavy' });
    });
    it('a burst does not pile onto one machine: the reservation counts before the target reports', async () => {
      // m5 at 0.6/core: one reserved heavy item (+0.5) takes it over the 1.0 line.
      await spawn({ name: 'heavy-a', prompt: 'a' });
      const second = await spawn({ name: 'heavy-b', prompt: 'b' });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('heavy-work-no-machine');
      expect(peerCalls).toHaveLength(1);
    });
    it('refused: a definite target refusal is 502 target-refused and releases the reservation', async () => {
      peerAnswer = { status: 409, body: { code: 'admission-refused', error: 'admission-refused (overloaded): x' } };
      const r = await spawn({ name: 'heavy-r1', prompt: 'a' });
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ outcome: 'refused', targetCode: 'admission-refused' });
      peerAnswer = { status: 201, body: { tmuxSession: 'echo-heavy-r2' } };
      expect((await spawn({ name: 'heavy-r2', prompt: 'b' })).status).toBe(201); // released → m5 still has room
    });
    it('unconfirmed: an unknown 5xx is 504 and says not to retry', async () => {
      peerAnswer = { status: 500, body: { error: 'launch failed after start' } };
      const r = await spawn({ name: 'heavy-u', prompt: 'a' });
      expect(r.status).toBe(504);
      expect(r.body).toMatchObject({ outcome: 'unconfirmed', sessionName: 'heavy-u' });
      expect(String(r.body.next)).toMatch(/Do not retry/);
    });
    it('409 heavy-work-no-machine when nothing big has room; nothing is sent', async () => {
      beat('m_m5', report(18, 48, 1.4), 25);
      const r = await spawn({ name: 'heavy-q', prompt: 'a' });
      expect(r.status).toBe(409);
      expect(r.body.decision).toMatchObject({ outcome: 'queued', reason: 'heavy-capable-machines-busy' });
      expect(r.body.machines).toHaveLength(3);
      expect(peerCalls).toHaveLength(0);
    });
    it('502 target-unreachable when no address is known for the chosen machine', async () => {
      peerUrls = [];
      const r = await spawn({ name: 'heavy-x', prompt: 'a' });
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('target-unreachable');
    });
  });
});

describe('resource-aware placement routes — pool not running', () => {
  it('both routes 503 without a pool registry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-dark-'));
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, stateDir: dir } as never));
    const s = await listen(app);
    try {
      expect((await fetch(s.url + '/pool/placement/preview?workWeight=heavy')).status).toBe(503);
      expect((await fetch(s.url + '/pool/heavy-work/spawn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Request': '1' }, body: '{"name":"h","prompt":"p"}' })).status).toBe(503);
    } finally {
      await s.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/resource-aware-placement-routes.test.ts' });
    }
  });
});
