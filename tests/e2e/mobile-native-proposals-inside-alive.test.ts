/**
 * Feature-is-alive proof for the phone's native Proposals and How I'm doing inside screens
 * (docs/specs/mobile-native-proposals-inside.md): an AgentServer booted on its production path, a phone
 * paired through the existing redeem/confirm path, then GET /mobile/proposals and /mobile/inside answer
 * 200 (not 403/503) for the owner phone, built from the server's real wiring; a proposal on disk reaches
 * the phone without its id; each section's state agrees with the server's own raw route; the raw routes
 * stay closed to the phone; and the bearer reads the same summaries.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-proposals-inside-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-proposals-inside-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'proposals-inside-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'proposals-inside-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir };
}

describe('native proposals and inside screens — production wiring', () => {
  it('is alive: an owner phone reads proposals and inside', async () => {
    const { server, stateDir } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'proposals-inside-e2e');
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    let t = Date.now();
    const pairPhone = async (name: string) => {
      const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
      expect(m.status).toBe(200);
      const dev = makeDevice();
      const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: name, devicePublicKey: dev.publicKey });
      expect(r.status).toBe(200);
      const deviceId = r.body.deviceId as string;
      const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
        const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const time = String(++t);
        const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
        const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
        q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
        return raw ? q.send(raw.toString()) : q;
      };
      const code = /is (\d{3}) (\d{3})\./.exec(dms[dms.length - 1]!)!.slice(1).join('');
      expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
      return { deviceId, send };
    };
    const phone = await pairPhone('e2e phone');

    // A proposal the reviewer wrote to disk reaches the phone, without its id.
    const propDir = path.join(stateDir, 'remediation', 'proposals-m_e2e');
    fs.mkdirSync(propDir, { recursive: true });
    fs.writeFileSync(path.join(propDir, 'prop-e2e-1.json'), JSON.stringify({ proposalId: 'prop-e2e-1', status: 'outstanding', llmSummary: 'Timeouts while saving', generatedAt: Date.now(), occurrencesObserved: 2, processLifetimes: 1 }));
    const proposals = await phone.send('GET', '/mobile/proposals');
    expect(proposals.status).toBe(200);
    expect(proposals.body).toMatchObject({ schemaVersion: 1, state: 'ok', selfState: 'ok' });
    expect(proposals.body.rows.map((r: { summary: string }) => r.summary)).toEqual(['Timeouts while saving']);
    expect(JSON.stringify(proposals.body)).not.toContain('prop-e2e-1');

    const inside = await phone.send('GET', '/mobile/inside');
    expect(inside.status).toBe(200);
    expect(inside.body.schemaVersion).toBe(1);
    expect(typeof inside.body.headline).toBe('string');
    // Wiring integrity: each section's state agrees with the server's own raw route.
    for (const [section, p] of [['activity', '/shared-state/recent'], ['claims', '/completion-claim/audit'], ['reviews', '/class-reviews'], ['problems', '/failures/insights']] as const) {
      const raw = await auth(request(app).get(p));
      expect(inside.body.self[section].state === 'off', section).toBe(raw.status === 503);
      expect(inside.body.self[section].state === 'ok', section).toBe(raw.status === 200);
    }

    // The raw routes stay closed to the phone.
    for (const p of ['/remediation/proposals', '/shared-state/recent', '/failures/insights', '/failures/analysis', '/completion-claim/audit', '/class-reviews']) {
      const res = await phone.send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summaries.
    for (const p of ['/mobile/proposals', '/mobile/inside']) expect((await auth(request(app).get(p))).status, p).toBe(200);
  });
});
