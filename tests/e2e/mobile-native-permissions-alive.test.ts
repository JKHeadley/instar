/**
 * Feature-is-alive proof for the phone's native Permission slips and What I'm allowed to do
 * (docs/specs/mobile-native-permissions.md): an AgentServer booted on its production path
 * (development agent, mobile pairing on, a dashboard PIN, authorization requests on), a phone paired
 * through the real redeem/confirm path, its presence key enrolled through the real route, both lists
 * 200, one approve (a real signed carrier mandate and its audit row naming the phone), one decline,
 * and one switch round-trip (discovery event `operator-switch`), each with a real P-256 presence
 * signature over a single-use challenge. Wiring integrity: the routes are on the production device
 * allowlist (not 403 device-not-allowed), mounted (not 404) and live (not 503), the raw routes stay
 * refused for the phone, and the console's own PIN approve still works.
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

const HOST = 'echo-permissions-e2e.example.dev';
const PIN = '424242';
const MIA = 'U0B9SFJ7QAK';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-permissions-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'permissions-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'permissions-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
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
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir };
}

describe('native permissions — production wiring', () => {
  it('is alive: lists, approve, decline and a switch from an owner phone with fresh presence proofs', async () => {
    const { server, stateDir } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'permissions-e2e');

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

    // Two waiting requests from the agent (bearer; inert until approved).
    const propose = async () => {
      const r = await bearer(request(app).post('/authorization-requests')).send({ createdByAgent: 'echo', proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 }, reason: 'release' });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    const a = await propose();
    const slips = await signed('GET', '/mobile/permissions/slips');
    expect(slips.status).toBe(200);
    expect(slips.body.actions).toEqual({ state: 'available', reason: null, presenceKey: true });
    const row = slips.body.approvals.rows.find((r: { id: string }) => r.id === a);
    expect(row).toMatchObject({ headline: 'Let Mia deploy to production for 1 hour.', here: true });
    expect(row.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(slips.body)).not.toContain(MIA);

    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>, line: string) => {
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, line)) });
    };

    // Approve: a real signed carrier mandate, its audit row names the phone.
    const ok = await act({ action: 'approve-request', target: a, proposalHash: row.proposalHash }, `/mobile/permissions/requests/${a}/approve`, { proposalHash: row.proposalHash }, `approve-request ${a} ${row.proposalHash}`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ approved: true, request: { status: 'approved' } });
    const mandates = await bearer(request(app).get('/mandate'));
    const carrier = mandates.body.mandates.find((x: { id: string }) => x.id === ok.body.request.resultMandateId);
    expect(carrier).toMatchObject({ scope: 'user-authority-grant', authorshipValid: true });
    const audit = await bearer(request(app).get('/mandate/audit?limit=20'));
    expect(JSON.stringify(audit.body)).toContain(`device ${deviceId}`);
    const after = await signed('GET', '/mobile/permissions/slips');
    expect(after.body.slips.active.some((s: { summary: string }) => s.summary === 'Mia may deploy to production')).toBe(true);

    // Decline another.
    const b = await propose();
    const bRow = (await signed('GET', '/mobile/permissions/slips')).body.approvals.rows.find((r: { id: string }) => r.id === b);
    expect(bRow).toBeTruthy();
    const reason = 'Not this week.';
    const no = await act({ action: 'decline-request', target: b, reason }, `/mobile/permissions/requests/${b}/decline`, { reason }, actionLine({ kind: 'decline-request', target: b, reason }));
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.request).toMatchObject({ status: 'denied', denyReason: reason });

    // A switch, off from the phone: the operator path, recorded as such.
    const feats = await signed('GET', '/mobile/permissions/features');
    expect(feats.status).toBe(200);
    expect(feats.body.features.some((f: { id: string }) => f.id === 'dashboard-file-viewer')).toBe(true);
    const sw = await act({ action: 'set-feature', target: 'dashboard-file-viewer', value: 'disabled' }, '/mobile/permissions/features/dashboard-file-viewer', { to: 'disabled' }, 'set-feature dashboard-file-viewer disabled none');
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body).toMatchObject({ success: true, viaOperatorSwitch: true, newState: 'disabled' });
    const events = await bearer(request(app).get('/features/events?featureId=dashboard-file-viewer&limit=5'));
    expect(events.body.events[0]).toMatchObject({ trigger: 'operator-switch', newState: 'disabled' });
    expect(events.body.events[0].context).toContain(deviceId);

    // The phone audit file records each one.
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.event !== 'challenge').map((x) => x.event)).toEqual(expect.arrayContaining(['approved', 'declined', 'feature-set']));

    // The raw routes stay refused for the phone; the bearer cannot write here; the console's PIN path still works.
    for (const [method, p] of [['GET', '/mandate'], ['GET', '/authorization-requests'], ['GET', '/features']] as const) {
      expect((await signed(method, p)).status, p).toBe(403);
    }
    expect((await bearer(request(app).post('/mobile/permissions/challenge')).send({ action: 'approve-request', target: a, proposalHash: row.proposalHash })).status).toBe(403);
    const c = await propose();
    const viaPin = await bearer(request(app).post(`/authorization-requests/${c}/approve`)).send({ pin: PIN });
    expect(viaPin.status).toBe(201);
  });
});
