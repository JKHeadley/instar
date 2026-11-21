/**
 * Pieces 3a and 3d through the stand-in owner chat only (docs/specs/throwaway-owner-chat.md §1, "What 3a and
 * 3d wire"): on a temp-folder throwaway server, every owner step goes through the stand-in routes. A phone is
 * paired by the stand-in's Approve tap; it claims first approver and the word code is read from
 * GET /throwaway/owner-chat/messages and typed through the phone route (3a); a second phone asks, and the owner's
 * `/approver_reset <code>` goes through POST /throwaway/owner-chat/command and Start through the stand-in tap (3d).
 * Then a real owner channel appears: the stand-in shuts off and its registered hooks stop the recovery it carried,
 * and a live first-approver claim it carried is dropped.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
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
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { mayApprove, resetApproverStateCacheForTests } from '../../src/server/mobileApprover.js';
import { approverClaimLive, resetApproverClaimForTests } from '../../src/server/mobileApproverClaim.js';
import { resetApproverGrantForTests } from '../../src/server/mobileApproverGrant.js';
import { resetApproverRecoveryForTests, setRecoveryChat } from '../../src/server/mobileApproverRecovery.js';
import { readRecovery, resetRecoveryCacheForTests } from '../../src/core/approverRecovery.js';
import { wireOwnerRecordStore, resetOwnerRecordWiringForTests } from '../../src/core/ownerRecordWiring.js';

const HOST = 'toc-appr.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterEach(() => {
  resetOwnerRecordWiringForTests(); resetApproverClaimForTests(); resetApproverGrantForTests(); resetApproverStateCacheForTests();
  resetApproverRecoveryForTests(); resetRecoveryCacheForTests(); setRecoveryChat(null);
});
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/throwaway-owner-chat-approver.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-appr-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const now = Date.now();
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    messaging: [], liveTest: { throwawayOwnerChat: { enabled: true } },
    throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() },
  }));
  const config = {
    projectName: 'toc-appr', projectDir: dir, stateDir, port: 0, authToken: 'appr-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  // What commands/server.ts does before the server is built: the owner record on this (lone) machine.
  wireOwnerRecordStore(config as never, new MachineIdentityManager(stateDir));
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { app, mp, stateDir, configFile, server };
}
type App = Awaited<ReturnType<typeof boot>>['app'];
type Entry = { kind: string; id: number; text?: string; buttons?: Array<{ index: number; text: string; data: string; removed?: boolean }> };

const auth = (q: request.Test) => q.set('Authorization', 'Bearer appr-token').set('X-Instar-AgentId', 'toc-appr');
/** The stand-in routes: master token, the server's own localhost Host, no device or Origin header. */
const local = (q: request.Test) => auth(q).set('Host', 'localhost:0');
const chat = async (app: App, after = 0): Promise<Entry[]> => {
  const r = await local(request(app).get(`/throwaway/owner-chat/messages?after=${after}`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.entries as Entry[];
};
const lastMessage = async (app: App): Promise<Entry> => (await chat(app)).filter((e) => e.kind === 'message').pop()!;

let tick = 0;
type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
function post(app: App, p: Phone, url: string, body: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = Buffer.from(JSON.stringify(body));
  return request(app).post(url).set('Content-Type', 'application/json').set('Host', HOST)
    .set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', p.dev.sign(canonicalString(p.id, HOST, 'POST', url, time, raw)))
    .send(raw.toString());
}
const presenceBody = (p: Phone) => ({ presenceKey: p.presence.publicKey, presenceProof: p.presence.sign(presenceEnrollMessage(p.id, HOST, p.presence.publicKey)) });

/** A phone paired the way the app pairs: redeem, then the owner's Approve tap — in the stand-in. */
async function pairPhone(app: App): Promise<Phone> {
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'sim phone', devicePublicKey: dev.publicKey });
  expect(r.body).toMatchObject({ status: 'pending', approval: 'telegram' });
  const msg = (await chat(app)).filter((e) => e.kind === 'message' && e.buttons?.[0]?.data.startsWith('md:a:')).pop()!;
  const tap = await local(request(app).post('/throwaway/owner-chat/tap')).send({ messageId: msg.id, button: 0 });
  expect(tap.body, JSON.stringify(tap.body)).toMatchObject({ outcome: 'approved' });
  return { dev, presence: makeDevice(), id: r.body.deviceId as string };
}

describe('pieces 3a and 3d through the stand-in owner chat', () => {
  it('first approver by the stand-in code, then a recovery started by the stand-in command, stopped when it shuts off', async () => {
    const { app, mp, stateDir, configFile } = await boot();
    const a = await pairPhone(app);
    expect(mayApprove(mp, a.id)).toBe(false);

    // 3a: the claim; its code is read from the stand-in log and typed through the phone route.
    const claim = await post(app, a, '/mobile/approver/first', presenceBody(a));
    expect(claim.body, JSON.stringify(claim.body)).toMatchObject({ eligible: true });
    const codeMsg = await lastMessage(app);
    const code = /type this code on it: ([A-Z]+-\d{4})/.exec(codeMsg.text ?? '')?.[1];
    expect(code, codeMsg.text).toBeTruthy();
    const conf = await post(app, a, '/mobile/approver/first/confirm', { code });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const signed = await post(app, a, '/mobile/approver/first/sign', { entry: conf.body.entry, sig: a.presence.sign(conf.body.sign) });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(mayApprove(mp, a.id)).toBe(true);

    // 3d: a second phone asks; the owner sends /approver_reset <code> and taps Start, both in the stand-in.
    const b = await pairPhone(app);
    const ask = await post(app, b, '/mobile/approver/request', presenceBody(b));
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const bare = await local(request(app).post('/throwaway/owner-chat/command')).send({ text: '/approver_reset' });
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    expect((await lastMessage(app)).text).toContain('Ask to approve on this device');
    const cmd = await local(request(app).post('/throwaway/owner-chat/command')).send({ text: `/approver_reset ${ask.body.matchCode}` });
    expect(cmd.status, JSON.stringify(cmd.body)).toBe(200);
    const card = await lastMessage(app);
    expect(card.buttons?.map((x) => x.text)).toEqual(['Start', 'Never mind']);
    const start = await local(request(app).post('/throwaway/owner-chat/tap')).send({ messageId: card.id, button: 0 });
    expect(start.body, JSON.stringify(start.body)).toMatchObject({ outcome: 'other' });
    expect(String(start.body.toast)).toContain('Started');
    expect(readRecovery(stateDir).home?.state).toBe('waiting');
    // The first notice ("Stop it") reached the owner through the stand-in.
    await new Promise((r) => setTimeout(r, 50));
    expect((await chat(app)).some((e) => e.kind === 'message' && e.buttons?.some((x) => x.text === 'Stop it'))).toBe(true);
    expect(mayApprove(mp, b.id)).toBe(false);

    // A real owner channel appears: the stand-in shuts off, and the recovery it carried is stopped.
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    cfg.messaging = [{ type: 'telegram', config: {} }];
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect((await local(request(app).get('/throwaway/owner-chat/messages'))).status).toBe(410);
    expect(readRecovery(stateDir).home).toMatchObject({ state: 'stopped', endedReason: 'stopped by stand-in-off' });
    expect(mayApprove(mp, b.id)).toBe(false);
  });

  it('a first-approver claim the stand-in carried ends when it shuts off', async () => {
    const { app, configFile } = await boot();
    const a = await pairPhone(app);
    expect((await post(app, a, '/mobile/approver/first', presenceBody(a))).body).toMatchObject({ eligible: true });
    expect(approverClaimLive()).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    cfg.messaging = [{ type: 'telegram', config: {} }];
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect((await local(request(app).get('/throwaway/owner-chat/messages'))).status).toBe(410);
    expect(approverClaimLive()).toBe(false);
  });
});
