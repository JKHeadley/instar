/**
 * Feature-is-alive proof for the stand-in owner chat (docs/specs/throwaway-owner-chat.md) on the
 * production AgentServer boot path: a temp-folder throwaway with the switch on builds it, serves its
 * routes, and a phone pairs through the Approve tap with the production pairing code
 * (`approvedVia: 'telegram-dm'`); the same throwaway with a Telegram adapter refuses it, answers 404,
 * and keeps the handlers on the adapter. Wiring: the stand-in's handler slots are the real funnel.
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
import { standInEverUsed } from '../../src/server/throwawayOwnerChat.js';

const HOST = 'toc-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/throwaway-owner-chat-alive.test.ts' });
});

async function boot(telegram?: unknown) {
  // os.tmpdir() is under /var/folders on macOS and /tmp on Linux: both fixed temp roots.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const now = Date.now();
  // What the stand-in reads is the config on disk.
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    messaging: [], liveTest: { throwawayOwnerChat: { enabled: true } },
    throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() },
  }));
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'toc e2e machine' });
  const config = {
    projectName: 'toc-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
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
  return { app, mp, stateDir, server };
}

const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'toc-e2e');
/** The stand-in routes: the master token on the server's own localhost port (port 0 here). */
const local = (q: request.Test) => q.set('Host', 'localhost:0').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'toc-e2e');

async function redeemNew(app: ReturnType<AgentServer['getApp']>) {
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, body: r.body };
}
let lastTime = 0;
function signedGet(app: ReturnType<AgentServer['getApp']>, dev: ReturnType<typeof makeDevice>, deviceId: string, p: string) {
  lastTime = Math.max(Date.now(), lastTime + 1);
  const time = String(lastTime);
  return request(app).get(p).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', dev.sign(canonicalString(deviceId, HOST, 'GET', p, time, undefined)));
}

describe('stand-in owner chat — production wiring', () => {
  it('a temp-folder throwaway builds it; a phone pairs through the Approve tap; a second is declined', async () => {
    const { app, mp, stateDir, server } = await boot();
    const chat = server.throwawayOwnerChat!;
    expect(chat.builtLive).toBe(true);
    // Wiring integrity: the stand-in's handler slots are the real pairing funnel, not left null.
    expect(chat.mobileApproveHandler).toBeTypeOf('function');
    expect(chat.mobileDeclineHandler).toBeTypeOf('function');
    expect(standInEverUsed(stateDir)).toBe(true);
    expect(mp.approvalPath()).toBe('telegram');

    const first = await redeemNew(app);
    expect(first.body).toMatchObject({ status: 'pending', approval: 'telegram' });
    const page = await local(request(app).get('/throwaway/owner-chat/messages'));
    expect(page.status).toBe(200);
    const msg = (page.body.entries as Array<{ kind: string; id: number; text: string; buttons: Array<{ index: number; data: string }> }>).find((e) => e.kind === 'message')!;
    expect(msg.buttons.map((b) => b.data.slice(0, 5))).toEqual(['md:a:', 'md:d:']);
    expect(msg.text).toMatch(/\d{3} \d{3}/);

    // The phone itself (device-signed) can never reach the stand-in routes: the device allowlist refuses
    // it first (403), and the route's own gate would refuse it too (404).
    expect([403, 404]).toContain((await signedGet(app, first.dev, first.deviceId, '/throwaway/owner-chat/messages')).status);

    const tap = await local(request(app).post('/throwaway/owner-chat/tap')).send({ messageId: msg.id, button: 0 });
    expect(tap.status).toBe(200);
    expect(tap.body).toMatchObject({ outcome: 'approved', buttonsRemoved: true });
    expect((await signedGet(app, first.dev, first.deviceId, '/mobile/device')).body).toMatchObject({ status: 'active', approvedVia: 'telegram-dm' });

    const second = await redeemNew(app);
    const entries = (await local(request(app).get(`/throwaway/owner-chat/messages?after=${msg.id}`))).body.entries as Array<{ kind: string; id: number; buttons?: Array<{ data: string }> }>;
    const msg2 = entries.filter((e) => e.kind === 'message' && e.buttons && e.buttons.length === 2).pop()!;
    const dec = await local(request(app).post('/throwaway/owner-chat/tap')).send({ messageId: msg2.id, button: 1 });
    expect(dec.body).toMatchObject({ outcome: 'declined', toast: 'Declined. That phone will not be paired.' });
    expect(mp.devices.get(second.deviceId)?.status ?? 'removed').not.toBe('active');
  });

  it('the same throwaway with a Telegram adapter refuses the stand-in: routes 404, handlers on the adapter', async () => {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, { getOwnerUserId: () => 4242, createAttentionItem: async () => undefined, answerCallback: async () => undefined, apiCall: async () => ({ message_id: 1 }) });
    const { app, server } = await boot(adapter);
    expect(server.throwawayOwnerChat?.builtLive ?? false).toBe(false);
    expect(adapter.mobileApproveHandler).toBeTypeOf('function');
    expect((await local(request(app).get('/throwaway/owner-chat/messages'))).status).toBe(404);
  });
});
