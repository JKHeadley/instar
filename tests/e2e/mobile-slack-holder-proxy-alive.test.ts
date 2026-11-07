/**
 * Feature-is-alive proof for the owner phone's holder read (docs/specs/mobile-slack-holder-proxy.md):
 * a real AgentServer on its production path, a device-signed owner phone, and a real socket
 * standing in for the holder. Proves the read is wired, not that a live pair of machines was used;
 * tests/integration/mobile-slack-holder-proxy.test.ts runs two real servers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-holder-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
const sockets: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const s of sockets) { s.closeAllConnections(); s.close(); }
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-slack-holder-proxy-alive.test.ts:cleanup' });
});

describe('owner phone Slack holder read — production wiring', () => {
  it('a real server forwards the exact id and machine by token and returns the holder answer', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const holder = http.createServer((q, r) => {
      seen.push({ url: q.url ?? '', auth: q.headers.authorization });
      r.setHeader('Content-Type', 'application/json');
      r.end(JSON.stringify({ deviceView: true, conversationId: -42, title: 'held elsewhere', conversationKey: 'slack:T:C', messages: [{ text: 'from the holder' }], nextBefore: null }));
    });
    await new Promise<void>((go) => holder.listen(0, '127.0.0.1', () => go()));
    sockets.push(holder);
    const url = `http://127.0.0.1:${(holder.address() as AddressInfo).port}`;

    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'holder-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const config = {
      projectName: 'holder-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
      mobilePairing: { multiRoute: { enabled: false } },
      tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      threadline: { ownerName: 'Justin' },
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
    const server = new AgentServer({
      config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
      resolvePeerUrls: () => [{ machineId: 'm_holder', url, kind: 'lan' }],
    } as never);
    servers.push(server);

    const pairing = server.mobilePairing!;
    expect(pairing.nativeOn).toBe(true);
    // Production boot must supply the real revocation authority the shared admission requires.
    expect(pairing.keyLedger).not.toBeNull();
    const dev = makeDevice();
    const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
    if (!c.ok) throw new Error('setup');
    pairing.devices.applyConfirm(c.device.id, { ok: true });
    const route = '/mobile/chat/slack/-42/messages?machine=m_holder&limit=5';
    const time = String(Date.now());
    const sig = dev.sign(canonicalString(c.device.id, HOST, 'GET', route, time, undefined));
    const r = await request(server.getApp()).get(route).set('Host', HOST).set('X-Instar-Device', c.device.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([{ text: 'from the holder' }]);
    expect(r.body.deviceView).toBeUndefined();
    expect(seen).toEqual([{ url: '/mobile/chat/slack/-42/messages?machine=m_holder&limit=5&deviceView=1', auth: 'Bearer e2e-token' }]);
  });
});
