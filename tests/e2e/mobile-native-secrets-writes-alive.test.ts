/**
 * Feature-is-alive proof for asking for a key and cancelling a request from the phone
 * (docs/specs/mobile-native-secrets-writes.md): an AgentServer on its production path, a phone paired
 * through the real path, its presence key enrolled, and a real ask and cancel on the real SecretDrop,
 * each with a real presence signature. The routes are on the device allowlist (not 403), mounted (not
 * 404) and live (not 503), and no answer carries the token.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';

const HOST = 'echo-secrets-writes-e2e.example.dev';
const PIN = '424242';
const MIA = 'U0B9SFJ7QAK';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-secrets-writes-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'secrets-writes-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'secrets-writes-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    users: [{ id: 'mia', name: 'Mia', slackUserId: MIA, channels: [{ type: 'slack', identifier: MIA }], permissions: [] }],
    monitoring: { authorizationRequests: { enabled: true } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, getExternalUrl: (p: string) => `https://${HOST}${p}`, on: () => undefined } as any;
  // As server.ts builds it: open, register the built-ins, bootstrap from config.
  const featureRegistry = new FeatureRegistry(stateDir);
  await featureRegistry.open();
  for (const def of BUILTIN_FEATURES) featureRegistry.register(def);
  featureRegistry.bootstrap(config as unknown as Record<string, unknown>);
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, featureRegistry } as never);
  servers.push(server);
  return { server, stateDir };
}

describe('phone ask and cancel — production wiring', () => {
  it('is alive: a real ask and cancel from an owner phone with fresh presence proofs', async () => {
    const { server, stateDir } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'secrets-writes-e2e');

    // Pair a phone through the real path.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const presence = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(redeemed.status).toBe(200);
    const deviceId = redeemed.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const signed = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      r = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? r.send(raw.toString()) : r;
    };
    expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    // Before the key: read-only lists say the phone can enrol, and a write is refused for the missing key.
    const before = await signed('GET', '/mobile/permissions/slips');
    expect(before.status).toBe(200);
    expect(before.body.actions).toEqual({ state: 'available', reason: null, presenceKey: false });
    expect((await signed('POST', '/mobile/permissions/challenge', { action: 'set-feature', target: 'dashboard-file-viewer', value: 'disabled' })).status).toBe(409);
    expect((await signed('POST', '/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);

    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>, line: string) => {
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, line)) });
    };

    // Ask for a key and cancel it (docs/specs/mobile-native-secrets-writes.md): the real SecretDrop.
    const askFor = { label: 'E2E vendor key', note: 'For the proof', topicId: null };
    const askLine = actionLine({ kind: 'request-secret', target: 'new', label: askFor.label, note: askFor.note, topicId: null });
    const asked = await act({ action: 'request-secret', target: 'new', ...askFor }, '/mobile/secrets/requests', askFor, askLine);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const pendingRaw = await bearer(request(app).get('/secrets/pending'));
    expect(pendingRaw.status, JSON.stringify(pendingRaw.body)).toBe(200);
    const held = (pendingRaw.body.pending as Array<{ label: string; token: string }>).find((p) => p.label === askFor.label)!;
    expect(held).toBeTruthy();
    expect(JSON.stringify(asked.body)).not.toContain(held.token);
    const read = await signed('GET', '/mobile/secrets');
    expect(read.status).toBe(200);
    expect(read.body.actions).toEqual({ state: 'available', reason: null, presenceKey: true });
    expect(read.body.requests.waiting.map((w: { key: string }) => w.key)).toContain(asked.body.key);
    expect(JSON.stringify(read.body)).not.toContain(held.token);
    const dup = await signed('POST', '/mobile/permissions/challenge', { action: 'request-secret', target: 'new', ...askFor });
    const twice = await signed('POST', '/mobile/secrets/requests', { ...askFor, challenge: dup.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, dup.body.challenge, askLine)) });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('already-waiting');
    const key = asked.body.key as string;
    const cancelled = await act({ action: 'cancel-secret', target: key }, `/mobile/secrets/requests/${key}/cancel`, {}, actionLine({ kind: 'cancel-secret', target: key }));
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await bearer(request(app).get('/secrets/pending'))).body.pending.some((p: { label: string }) => p.label === askFor.label)).toBe(false);

    const rows = fs.readFileSync(path.join(stateDir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => x.event)).toEqual(expect.arrayContaining(['secret-requested', 'secret-cancelled']));
    expect(JSON.stringify(rows)).not.toContain(askFor.label);
    expect(JSON.stringify(rows)).not.toContain(held.token);
    expect((await signed('GET', '/secrets/pending')).status).toBe(403);
  });
});
