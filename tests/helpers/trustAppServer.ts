/**
 * Test helper for docs/specs/app-trust-approval.md: a real AgentServer with no Telegram or Slack owner
 * chat, the trust journey runtime wired in, and a device paired through the real redeem/confirm path
 * (optionally marked as the Mac app's local pairing, as mac-app-creates-agent §A records it).
 */
import { expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from './setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString, deviceFingerprint } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { createTrustJourneyRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { makeDevice } from './mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from './allow-test-identities.js';
import { markApproverForTest } from '../../src/server/mobileApprover.js';

const HOST = 'echo-trust-app.example.dev';
/** The loopback address a local (Mac app) device is bound to. */
const LOCAL_HOST = '127.0.0.1:4040';
const servers: AgentServer[] = [];
const dirs: string[] = [];
/** Stops every server and removes every directory this helper made. */
export async function cleanupTrustAppServers(operation: string): Promise<void> {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation });
}

export async function bootTrustAppServer(prefix: string, sink?: Parameters<typeof createTrustJourneyRuntime>[0]['sink'], telegram: Parameters<typeof createTrustJourneyRuntime>[0]['telegram'] = null) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), prefix));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'trust app machine' });
  const config = {
    projectName: 'trust-app', projectDir: dir, stateDir, port: 0, authToken: 'tok', developmentAgent: true, dashboardPin: '424242',
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const trust = new AdaptiveTrust({ stateDir });
  // No Telegram, no Slack: the app is the only way to reach the person.
  const runtime = createTrustJourneyRuntime({
    stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: config as never, installationId: 'trust-app', sink,
    adaptiveTrust: trust, autonomyManager: null, trustRecovery: null, telegram, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
  });
  const sessionManager = createMockSessionManager() as never as { on: () => void };
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as never;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel, adaptiveTrust: trust, trustAccountPath: runtime } as never);
  servers.push(server);
  const app = server.getApp();
  const bearer = (r: request.Test) => r.set('Authorization', 'Bearer tok').set('X-Instar-AgentId', 'trust-app');

  /** Pairs a device through the real redeem/confirm path, enrols its presence key, and (optionally) marks it as the Mac app's local pairing. */
  const pair = async (opts: { local: boolean; name: string }) => {
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const presence = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: opts.name, devicePublicKey: dev.publicKey });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    const id = redeemed.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    // A local device (the Mac that created the agent) is bound to this machine's loopback address
    // (mac-app-creates-agent §A): once marked, it signs and arrives on that address.
    let host = HOST;
    const signed = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(id, host, method, p, time, raw));
      let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      r = r.set('Host', host).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? r.send(raw.toString()) : r;
    };
    expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    markApproverForTest(server.mobilePairing!, id, presence.publicKey); // piece 3a: the route stores a key only for an approver
    expect((await signed('POST', '/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(id, HOST, presence.publicKey)) })).status).toBe(200);
    if (opts.local) {
      // As the Mac app's local pairing records it (mac-app-creates-agent §A).
      const file = path.join(stateDir, 'state', 'mobile-devices.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const d of reg.devices) if (d.id === id) { d.approvedVia = 'local-install'; d.localBinding = { machineId: null }; d.deviceKind = 'computer'; d.host = LOCAL_HOST; }
      fs.writeFileSync(file, JSON.stringify(reg));
      host = LOCAL_HOST;
    }
    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>, line: string) => {
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(id, host, ch.body.challenge, line)) });
    };
    return { id, fp: deviceFingerprint(dev.publicKey), signed, act };
  };
  return { server, app, stateDir, config, trust, runtime, bearer, pair };
}

export const DISCLOSURE = 'Let this Mac approve changes to what your agent may do? Approved with Touch ID. The list of paired devices is kept on the agent\'s own computer, so this is not independently verified.';
export const DHASH = crypto.createHash('sha256').update(DISCLOSURE).digest('hex');

