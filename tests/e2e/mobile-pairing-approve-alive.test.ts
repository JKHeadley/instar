/**
 * Feature-is-alive proof for Approve instead of a code (docs/specs/mobile-pairing-approve.md) on the
 * production AgentServer boot path: with no Telegram, a PIN session approves a waiting phone and the
 * phone's own signed status poll carries it to a working signed route; with a Telegram owner, the
 * Approve tap travels /internal/telegram-callback → handleMobileApprove → the real service, and an
 * owner phone approves another phone with its presence key. Wiring: the adapter handler delegates to
 * the real funnel, no stub in between.
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
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { pairingApproveLine, pairingApproveMessage } from '../../src/server/mobilePairingApproval.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';

const HOST = 'echo-approve-e2e.example.dev';
const PIN = '482913';
const OWNER = 4242;
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-pairing-approve-alive.test.ts' });
});

async function boot(telegram?: unknown) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'approve-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'approve-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, ...(telegram ? { telegram: telegram as any } : {}) });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { app, mp, stateDir };
}

const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'approve-e2e');
async function redeemNew(app: ReturnType<AgentServer['getApp']>) {
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, body: r.body };
}
let lastTime = 0;
function send(app: ReturnType<AgentServer['getApp']>, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastTime = Math.max(Date.now(), lastTime + 1);
  const time = String(lastTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
  const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}

describe('Approve instead of a code — production wiring', () => {
  it('no Telegram: a PIN session approves; the waiting phone sees it and works; the bearer alone cannot', async () => {
    const { app, mp } = await boot();
    expect(mp.approvalPath()).toBe('dashboard');
    const w = await redeemNew(app);
    expect(w.body).toMatchObject({ status: 'pending', approval: 'dashboard', confirmWith: ['dashboard', 'code'] });
    expect(w.body.fingerprint).toBe(mp.devices.get(w.deviceId)!.fingerprint);
    expect((await send(app, w.dev, w.deviceId, 'GET', '/mobile/device')).body.status).toBe('pending');
    expect((await auth(request(app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({})).status).toBe(403);

    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(unlock.status).toBe(200);
    const list = await auth(request(app).get('/mobile/pairing-approvals')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
    expect(list.body.approvals[0]).toMatchObject({ deviceId: w.deviceId, canApprove: true });
    const a = await auth(request(app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({});
    expect(a.status).toBe(200);

    const s = await send(app, w.dev, w.deviceId, 'GET', '/mobile/device');
    expect(s.body).toMatchObject({ status: 'active', approvedVia: 'dashboard-pin' });
    expect((await send(app, w.dev, w.deviceId, 'GET', '/mobile/routes')).status).toBe(200);
    expect(mp.keyLedger!.rows().find((row) => row.type === 'activation')).toMatchObject({ approvedVia: 'dashboard-pin' });
  });

  it('Telegram owner: the tap through the real internal route activates; an owner phone then approves the next phone', async () => {
    const sent: Array<{ text: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }> = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, {
      getOwnerUserId: () => OWNER,
      createAttentionItem: async () => undefined,
      answerCallback: async () => undefined,
      apiCall: async (method: string, p: { text: string }) => { if (method === 'sendMessage') sent.push(p as never); return { message_id: sent.length }; },
    });
    const { app, mp, stateDir } = await boot(adapter);
    // Wiring integrity: the adapter handler is the real funnel, not left null.
    expect(adapter.mobileApproveHandler).toBeTypeOf('function');
    expect(mp.approvalPath()).toBe('telegram');
    const first = await redeemNew(app);
    expect(first.body.confirmWith).toEqual(['telegram', 'code']);
    const row = sent[0]!.reply_markup!.inline_keyboard[0]!;
    expect(row.map((b) => b.callback_data.slice(0, 5))).toEqual(['md:a:', 'md:d:']);

    // The lifeline's own path: the route, with the secret only the lifeline holds.
    const tap = await auth(request(app).post('/internal/telegram-callback')).set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(stateDir))
      .send({ callbackQueryId: 'q1', data: row[0]!.callback_data, fromUserId: OWNER, chatId: OWNER, messageId: 1 });
    expect(tap.status).toBe(200);
    expect(tap.body.mobileApprove).toBe(true);
    expect((await send(app, first.dev, first.deviceId, 'GET', '/mobile/device')).body).toMatchObject({ status: 'active', approvedVia: 'telegram-dm' });

    const presence = makeDevice();
    expect(mp.devices.setPresenceKey(first.deviceId, presence.publicKey)).toBe('set');
    const second = await redeemNew(app);
    expect(second.body.confirmWith).toEqual(['telegram', 'owner-phone', 'code']);
    const fp = mp.devices.get(second.deviceId)!.fingerprint!;
    const c = await send(app, first.dev, first.deviceId, 'POST', `/mobile/pairing-requests/${second.deviceId}/challenge`, { action: 'approve' });
    expect(c.status).toBe(200);
    const presenceSig = presence.sign(pairingApproveMessage(first.deviceId, HOST, c.body.challenge, pairingApproveLine('approve', second.deviceId, fp)));
    const a = await send(app, first.dev, first.deviceId, 'POST', `/mobile/pairing-requests/${second.deviceId}/approve`, { challenge: c.body.challenge, presenceSig });
    expect(a.status).toBe(200);
    expect(mp.devices.get(second.deviceId)).toMatchObject({ status: 'active', approvedVia: 'owner-phone', approvedBy: first.deviceId });
    expect(mp.keyLedger!.rows().filter((r) => r.type === 'activation').map((r) => (r as { approvedVia: string }).approvedVia)).toEqual(['telegram-dm', 'owner-phone']);
  });

  it('an unproven tap on the real internal route never approves', async () => {
    const sent: Array<{ reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }> = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, {
      getOwnerUserId: () => OWNER, createAttentionItem: async () => undefined,
      answerCallback: async () => undefined,
      apiCall: async (method: string, p: unknown) => { if (method === 'sendMessage') sent.push(p as never); return { message_id: 1 }; },
    });
    const { app, mp } = await boot(adapter);
    const w = await redeemNew(app);
    const data = sent[0]!.reply_markup!.inline_keyboard[0]![0]!.callback_data;
    // The ordinary API token, no lifeline secret, claiming to be the owner.
    const r = await auth(request(app).post('/internal/telegram-callback')).send({ callbackQueryId: 'forged-1', data, fromUserId: OWNER, chatId: OWNER, messageId: 1 });
    // Refused outright, or accepted unproven before the guard arms; either way it approves nothing.
    expect([200, 401]).toContain(r.status);
    expect(mp.devices.get(w.deviceId)!.status).toBe('pending');
  });
});
