/**
 * Tier-2 integration for agent-sessions-placed-by-load Step 1: POST /sessions/spawn (shadow
 * log + opt-in live placement), GET /sessions/:name/output (proxied to the placed machine)
 * and DELETE /sessions/:id (409 placed-on-peer) through the real route stack
 * (createRoutes), a real MachinePoolRegistry fed load-report heartbeats, and a stub peer
 * server standing in for the chosen machine.
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
import { heavyReservations } from '../../src/core/heavyWorkPlacement.js';
import { agentSessionReservations, getActiveAgentSessionPlacement, setActiveAgentSessionPlacement } from '../../src/core/agentSessionPlacement.js';

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
function report(cores: number, loadPerCore: number, verdict: MachineLoadReport['verdict'] = 'ok', memoryPressured?: boolean): MachineLoadReport {
  return {
    bootId: 'boot', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: 64 * GIB, loadPerCore,
    cpuIdlePct: 40, memAvailablePct: memoryPressured ? 3 : 40, memPressureNative: memoryPressured ? 'critical' : 'normal', eventLoopLagP99Ms: 5,
    sessionsActive: 1, sessionsMax: 25, spawnCapSaturated: false, testRunnerSaturated: false, verdict, uptimeS: 1000,
    ...(memoryPressured !== undefined ? { memoryPressured } : {}),
  } as MachineLoadReport;
}

describe('agent-session placement routes', () => {
  let dir: string;
  let registry: MachinePoolRegistry;
  let server: Server;
  let peer: Server;
  let peerSpawns: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }>;
  let peerAnswer: { status: number; body: Record<string, unknown> };
  let peerRunning: Array<Record<string, unknown>>;
  let localSpawns: Array<Record<string, unknown>>;
  let developmentAgent: boolean;
  const SELF = 'm_studio';

  function beat(machineId: string, r: MachineLoadReport) {
    registry.recordHeartbeat({ machineId, selfReportedLastSeen: new Date().toISOString(), loadAvg: r.loadPerCore! * r.cores!, loadReport: r } as never);
  }

  async function boot() {
    const ctx: Record<string, unknown> = {
      config: { authToken: 'test-token', stateDir: dir, port: 0, projectName: 'echo', developmentAgent },
      stateDir: dir,
      machinePoolRegistry: registry,
      meshSelfId: SELF,
      resolvePeerUrls: () => [{ machineId: 'm_m5', url: peer.url, kind: 'lan' }],
      state: { listSessions: () => [], getSession: () => null },
      sessionManager: {
        spawnSession: async (o: Record<string, unknown>) => { localSpawns.push(o); return { id: 'local-1', name: o.name, tmuxSession: `echo-${o.name}`, status: 'running' }; },
        captureOutput: () => null,
      },
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx as never));
    server = await listen(app);
  }

  beforeEach(async () => {
    heavyReservations.clear();
    agentSessionReservations.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-routes-'));
    developmentAgent = true;
    registry = new MachinePoolRegistry({
      listMachines: () => [{ machineId: SELF, nickname: 'Mac Studio' }, { machineId: 'm_m5', nickname: 'Mac M5 Pro' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    beat(SELF, report(16, 1.6, 'saturated'));
    beat('m_m5', report(18, 0.3));
    peerSpawns = [];
    peerRunning = [];
    localSpawns = [];
    peerAnswer = { status: 201, body: { id: 'peer-1', name: 'review-helper', tmuxSession: 'echo-review-helper' } };
    const peerApp = express();
    peerApp.use(express.json());
    peerApp.post('/sessions/spawn', (req, res) => { peerSpawns.push({ headers: req.headers, body: req.body }); res.status(peerAnswer.status).json(peerAnswer.body); });
    peerApp.get('/sessions', (_req, res) => res.json(peerRunning));
    peerApp.get('/sessions/:name/output', (req, res) => res.json({ session: req.params.name, output: 'peer output', placedHeader: req.headers['x-instar-placed'] }));
    peer = await listen(peerApp);
    await boot();
  });

  afterEach(async () => {
    await server.close();
    await peer.close();
    setActiveAgentSessionPlacement(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/agent-session-placement-routes.test.ts' });
  });

  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
  };
  const spawn = (body: Record<string, unknown>, headers: Record<string, string> = {}) => api('/sessions/spawn', { method: 'POST', body: JSON.stringify(body), headers });
  const shadowRows = () => {
    const f = path.join(dir, '..', 'logs', 'agent-session-placement.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  afterEach(() => { SafeFsExecutor.safeRmSync(path.join(dir, '..', 'logs', 'agent-session-placement.jsonl'), { force: true, operation: 'tests/integration/agent-session-placement-routes.test.ts' }); });

  it('without placement:"auto" the session starts here, and one shadow row says where it would have gone (no prompt)', async () => {
    const r = await spawn({ name: 'plain-helper', prompt: 'secret words' });
    expect(r.status).toBe(201);
    expect(localSpawns).toHaveLength(1);
    expect(peerSpawns).toHaveLength(0);
    const rows = shadowRows().filter((x) => x.name === 'plain-helper');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'shadow', wouldPlaceOn: 'm_m5', topicBound: false });
    expect(JSON.stringify(rows)).not.toContain('secret words');
  });

  it('placement:"auto" on a busy machine starts the helper on the peer through its own /sessions/spawn', async () => {
    const r = await spawn({ name: 'review-helper', prompt: 'review it', placement: 'auto' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ placementOutcome: 'peer', placedOn: { machineId: 'm_m5', nickname: 'Mac M5 Pro' }, tmuxSession: 'echo-review-helper' });
    expect(localSpawns).toHaveLength(0);
    expect(peerSpawns).toHaveLength(1);
    expect(peerSpawns[0].body).toEqual({ name: 'review-helper', prompt: 'review it', workWeight: 'standard' });
    expect(peerSpawns[0].headers['x-instar-placed']).toBe('1');
    expect(peerSpawns[0].headers.authorization).toBe('Bearer test-token');
  });

  it('memory short here moves the helper even when CPU load is low', async () => {
    beat(SELF, report(16, 0.3, 'ok', true));
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.body.placementOutcome).toBe('peer');
  });

  it('a peer short of memory never receives it: the helper starts here', async () => {
    beat('m_m5', report(18, 0.2, 'ok', true));
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ placementOutcome: 'local', placementReason: 'no-eligible-peer' });
    expect(peerSpawns).toHaveLength(0);
  });

  it('this machine with room keeps the helper (it is preferred)', async () => {
    beat(SELF, report(16, 0.4));
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.body).toMatchObject({ placementOutcome: 'local', placementReason: 'self-has-room' });
  });

  it('fields that cannot travel keep it here, with the reason', async () => {
    const r = await spawn({ name: 'job-helper', prompt: 'p', placement: 'auto', jobSlug: 'nightly' });
    expect(r.body).toMatchObject({ placementOutcome: 'local', placementReason: 'options-do-not-travel' });
    expect(peerSpawns).toHaveLength(0);
  });

  it('a forwarded spawn (X-Instar-Placed) is never re-placed', async () => {
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' }, { 'X-Instar-Placed': '1' });
    expect(r.status).toBe(201);
    expect(localSpawns).toHaveLength(1);
    expect(peerSpawns).toHaveLength(0);
    expect(shadowRows().at(-1)).toMatchObject({ mode: 'forwarded' });
  });

  it('a definite peer refusal starts it here (local-fallback)', async () => {
    peerAnswer = { status: 409, body: { code: 'admission-refused', error: 'admission-refused (overloaded): x' } };
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ placementOutcome: 'local-fallback', placementReason: 'peer-refused:admission-refused' });
    expect(localSpawns).toHaveLength(1);
  });

  it('a duplicate name on the peer answers 409 exists-on-peer and starts nothing here', async () => {
    peerAnswer = { status: 409, body: { code: 'session-exists', error: 'tmux session "echo-review-helper" already exists' } };
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.status).toBe(409);
    expect(r.body.placementOutcome).toBe('exists-on-peer');
    expect(localSpawns).toHaveLength(0);
  });

  it('output of a placed helper is read from its machine; a kill answers 409 placed-on-peer', async () => {
    await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    const out = await api('/sessions/review-helper/output');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ output: 'peer output', placedHeader: '1', placedOn: { machineId: 'm_m5' } });
    const kill = await api('/sessions/review-helper', { method: 'DELETE' });
    expect(kill.status).toBe(409);
    expect(kill.body).toMatchObject({ error: 'placed-on-peer', placedOn: { machineId: 'm_m5' } });
  });

  it('a plain request (no placement) for a name placed on a peer is read-only: nothing starts here', async () => {
    await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    peerRunning = [{ name: 'review-helper', tmuxSession: 'echo-review-helper', status: 'running' }];
    const r = await spawn({ name: 'review-helper', prompt: 'p' });
    expect(r.status).toBe(409);
    expect(r.body.placementOutcome).toBe('exists-on-peer');
    expect(localSpawns).toHaveLength(0);
  });

  it('a placement error before anything is sent never blocks the spawn: it starts here', async () => {
    (registry as unknown as { getCapacities: () => never }).getCapacities = () => { throw new Error('registry broke'); };
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ placementOutcome: 'local', placementReason: 'placement-error' });
    const plain = await spawn({ name: 'other-helper', prompt: 'p' });
    expect(plain.status).toBe(201);
  });

  it('the route registered the reconciler for the pool tick', () => {
    expect(getActiveAgentSessionPlacement()).not.toBeNull();
  });

  it('400 on an unknown placement value', async () => {
    expect((await spawn({ name: 'x', prompt: 'p', placement: 'everywhere' })).status).toBe(400);
  });

  it('feature off (fleet, not a development agent): placement:"auto" starts here, no shadow log', async () => {
    await server.close();
    setActiveAgentSessionPlacement(null);
    developmentAgent = false;
    await boot();
    const r = await spawn({ name: 'review-helper', prompt: 'p', placement: 'auto' });
    expect(r.status).toBe(201);
    expect(r.body.placementOutcome).toBeUndefined();
    expect(localSpawns).toHaveLength(1);
    expect(peerSpawns).toHaveLength(0);
    expect(shadowRows()).toHaveLength(0);
    expect(getActiveAgentSessionPlacement()).toBeNull();
  });
});
