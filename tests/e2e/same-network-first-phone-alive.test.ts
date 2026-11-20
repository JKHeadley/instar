/**
 * Identity A4 is alive through the production start path (docs/specs/identity-security-piece3e-same-network-first-phone.md §6):
 * AgentServer builds the same-network listener and wires it into the pairing service; the listener
 * is absent before "Add your phone", answers after it (a real TLS 1.3 round trip with a phone that
 * pins the scanned hash, through the number at the computer to an active phone), and is back after
 * a restart. A second machine of the same agent that was not asked keeps its listener closed.
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
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { pinnedRequest, signedHeaders } from '../helpers/pinnedPhone.js';
import { ceremonyCredential } from '../../src/commands/mobileCeremonyCredential.js';
import { ceremonyCredentialPath } from '../../src/core/ceremonyCredential.js';
import { defaultSameNetworkPort } from '../../src/server/sameNetworkListener.js';

const PIN = '731904';
const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'eth0', router: '192.168.7.1', address: '192.168.7.40', range: '192.168.7.0/24' } };
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => undefined);
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/same-network-first-phone-alive.test.ts' });
});

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sn-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  // The real CLI command below runs loadConfig, which needs a framework binary: CI has no Claude CLI, so
  // point the configured path at a binary every runner has (as the other e2e tests do).
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'sn-e2e', sessions: { claudePath: '/usr/bin/echo' } }));
  return dir;
}

async function boot(dir: string) {
  const stateDir = path.join(dir, '.instar');
  const config = {
    projectName: 'sn-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir),
    sameNetwork: { port: 0, bindHost: '127.0.0.1', wsl: false, announce: false, machineName: 'e2e-box', observe: async () => HOME },
  });
  servers.push(server);
  await server.start();
  return server;
}

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'sn-e2e');

describe('identity A4 — same-network first phone, production wiring', () => {
  it('absent before "Add your phone", alive after it end to end, back after a restart', async () => {
    const dir = newDir();
    const server = await boot(dir);
    const svc = server.mobilePairing;
    expect(svc).not.toBeNull();
    // Wiring integrity: a real listener, wired to the real pairing service, closed until asked.
    expect(svc!.sameNetwork).not.toBeNull();
    expect(svc!.sameNetwork!.listening()).toBe(false);
    const app = server.getApp();
    const status0 = await bearer(request(app).get('/mobile/same-network'));
    expect(status0.status).toBe(200);
    expect(status0.body.listening).toBe(false);

    const s = await bearer(request(app).post('/mobile/phone-setup')).send({ pin: PIN });
    expect(s.status).toBe(200);
    const q = new URLSearchParams(String(s.body.link).split('#')[1]);
    const host = q.get('h')!; const pin = q.get('k')!; const code = q.get('c')!;
    const port = Number(host.split(':')[1]);
    expect(svc!.sameNetwork!.listening()).toBe(true);

    const dev = makeDevice();
    const r = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body: JSON.stringify({ code, deviceName: 'Phone', devicePublicKey: dev.publicKey, pinnedKeyHash: pin }) });
    expect(r.status).toBe(200);
    expect(r.json.approval).toBe('computer');
    const n = await bearer(request(app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number });
    expect(n.status).toBe(200);
    const body = JSON.stringify({ pinnedKeyHash: pin });
    const act = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/device/activate-at-computer', body, headers: signedHeaders(dev, String(r.json.deviceId), host, 'POST', '/mobile/device/activate-at-computer', body) });
    expect(act.status).toBe(200);
    expect(act.json.status).toBe('active');
    const me = await pinnedRequest({ port, pin, method: 'GET', path: '/mobile/device', headers: signedHeaders(dev, String(r.json.deviceId), host, 'GET', '/mobile/device') });
    expect(me.status).toBe(200);
    // The dashboard does not exist on this listener.
    expect((await pinnedRequest({ port, pin, method: 'GET', path: '/dashboard' })).status).toBe(404);

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    // A restart: the production start path reopens it on the allowed network, same address and key.
    const again = await boot(dir);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(again.mobilePairing!.sameNetwork!.listening()).toBe(true);
    expect(again.mobilePairing!.sameNetwork!.host()).toBe(host);
    const me2 = await pinnedRequest({ port, pin, method: 'GET', path: '/mobile/device', headers: signedHeaders(dev, String(r.json.deviceId), host, 'GET', '/mobile/device') });
    expect(me2.status).toBe(200);
  });

  it('A5: the app on the agent\'s own computer adds the first phone with the one-time credential its command makes, without the PIN', async () => {
    const dir = newDir();
    const stateDir = path.join(dir, '.instar');
    // This computer's identity for the agent, as `instar init` writes it.
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_e2e' }));
    const server = await boot(dir);
    const svc = server.mobilePairing!;
    const app = server.getApp();
    // The preferred port is reported before anything opens (production default unless a test port is set).
    expect((await bearer(request(app).get('/mobile/same-network'))).body.preferredPort).toBe(0);
    expect(defaultSameNetworkPort(4040)).toBe(24_040);
    // The Instar app the installer enrolled on this computer (its one-time ticket).
    expect(svc.devices.createActiveLocalOwner({ id: 'app-e2e', publicKey: makeDevice().publicKey, host: '127.0.0.1:0', label: 'Instar', machineId: 'm_e2e', approvedAt: new Date().toISOString() }).ok).toBe(true);
    // The app's command, run inside the agent's own system: the real CLI entry.
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { printed.push(String(line)); };
    try { ceremonyCredential({ dir, json: true }); } finally { console.log = log; }
    const made = JSON.parse(printed[0]!) as { credential: string; for: string };
    expect(made.for).toBe('phone-setup');
    expect(fs.existsSync(ceremonyCredentialPath(stateDir))).toBe(true);
    // A credential is never accepted through a forwarded request.
    const fwd = await bearer(request(app).post('/mobile/phone-setup')).set('Host', '127.0.0.1:0').set('X-Forwarded-For', '198.51.100.4').send({ ceremonyCredential: made.credential });
    expect(fwd.status).toBe(403);
    const s = await bearer(request(app).post('/mobile/phone-setup')).set('Host', '127.0.0.1:0').send({ ceremonyCredential: made.credential });
    expect(s.status).toBe(200);
    expect(s.body.linkVersion).toBe(2);
    expect(fs.existsSync(ceremonyCredentialPath(stateDir))).toBe(false);
    expect(svc.sameNetwork!.listening()).toBe(true);
    // Spent: the same credential opens nothing again.
    expect((await bearer(request(app).post('/mobile/phone-setup')).set('Host', '127.0.0.1:0').send({ ceremonyCredential: made.credential })).status).toBe(403);
  });

  it('a second machine of the agent that was not asked keeps its listener closed', async () => {
    const asked = await boot(newDir());
    const other = await boot(newDir());
    expect((await bearer(request(asked.getApp()).post('/mobile/phone-setup')).send({ pin: PIN })).status).toBe(200);
    expect(asked.mobilePairing!.sameNetwork!.listening()).toBe(true);
    expect(other.mobilePairing!.sameNetwork!.listening()).toBe(false);
  });
});
