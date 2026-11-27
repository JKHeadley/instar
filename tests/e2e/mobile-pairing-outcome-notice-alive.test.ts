/** Production-path proof (docs/specs/mobile-pairing-outcome-notice.md): AgentServer wires the
 * pairing outcome notice into the pairing service from its `mobilePairingAutomationReply` option
 * (a real, non-no-op sender), a link minted with a topicId is watched, and when the phone pairs
 * exactly one line reaches that sender for that topic and `GET /mobile/devices` reports it sent.
 * Without the option, nothing is watched and the mint says why. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const CF = 'outcome-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

function boot(opts: { withSender: boolean }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mpo-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'outcome-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: CF },
    mobilePairing: { multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${CF}`, on: () => undefined } as any;
  let app: express.Express | null = null;
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app!).get(u.pathname + u.search).set('Host', u.hostname);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const posts: Array<{ topicId: number; body: Record<string, unknown>; logicalSendId: string; headers: Record<string, string> }> = [];
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    mobileRoutes: { fetchFn, start: false },
    ...(opts.withSender ? {
      mobilePairingAutomationReply: async (topicId: number, body: Record<string, unknown>, logicalSendId: string, o: { headers: Record<string, string> }) => {
        posts.push({ topicId, body, logicalSendId, headers: o.headers });
        return new Response(JSON.stringify({ ok: true, topicId }), { status: 200 });
      },
    } : {}),
  } as ConstructorParameters<typeof AgentServer>[0]);
  app = server.getApp() as express.Express;
  servers.push(server);
  return { server, app, posts };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-pairing-outcome-notice-alive.test.ts' });
});

const auth = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'outcome-e2e');

describe('pairing outcome notice — production wiring', () => {
  it('the server wires a real sender; a paired phone produces exactly one line in the asking topic', async () => {
    const { server, app, posts } = boot({ withSender: true });
    const mp = server.mobilePairing!;
    expect(mp.outcomes).not.toBeNull();
    expect(mp.deps.outcomeNotice).toBeDefined();
    // No Telegram adapter or origin service in this harness: the real availability check says no.
    expect(mp.deps.outcomeNotice!.available()).toBe(false);
    const unavailable = await auth(request(app).post('/mobile/pairing-codes')).send({ topicId: 321 });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.outcomeNotice).toBeNull();
    expect(unavailable.body.outcomeNoticeReason).toMatch(/cannot post in Telegram/);
    // Stand in for a running Telegram + origin service, and an operator message in the topic.
    const dms: string[] = [];
    mp.deps.outcomeNotice!.available = () => true;
    mp.deps.outcomeNotice!.recentOperatorInbound = () => '777';
    mp.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    mp.deps.telegramOwnerPresent = () => true;
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({ label: 'E2E phone', topicId: 321 });
    expect(m.status).toBe(200);
    expect(m.body.outcomeNotice).toMatchObject({ topicId: 321 });
    const dev = makeDevice();
    const red = await request(app).post('/mobile/pairing-codes/redeem').set('Host', CF).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(red.status).toBe(200);
    const id = red.body.deviceId as string;
    const raw = Buffer.from(JSON.stringify({ code: /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('') }));
    const time = String(Date.now());
    const sig = dev.sign(canonicalString(id, CF, 'POST', '/mobile/device/confirm', time, raw));
    const ok = await request(app).post('/mobile/device/confirm').set('Content-Type', 'application/json').set('Host', CF)
      .set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
    expect(ok.body.status).toBe('active');
    await mp.outcomes!.pass();
    await mp.outcomes!.pass();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.topicId).toBe(321);
    expect(String(posts[0]!.body.text)).toMatch(/^A phone named "e2e phone" was paired with outcome-e2e \(key /);
    expect(posts[0]!.headers['X-Instar-System']).toBe('true');
    expect((posts[0]!.body.metadata as Record<string, unknown>).inboundMessageId).toBe('777');
    const devices = await auth(request(app).get('/mobile/devices'));
    expect(devices.status).toBe(200);
    expect(devices.body.pairingOutcomes.find((o: { watchId: string }) => o.watchId === m.body.outcomeNotice.watchId)).toMatchObject({ outcome: 'paired', state: 'sent' });
  });

  it('without the sender option nothing is watched, and the link is still minted', async () => {
    const { server, app } = boot({ withSender: false });
    expect(server.mobilePairing!.outcomes).toBeNull();
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({ topicId: 5 });
    expect(m.status).toBe(200);
    expect(m.body.link).toMatch(/^https:\/\/instar\.sh\/pair#/);
    expect(m.body.outcomeNotice).toBeNull();
  });
});
