/**
 * HTTP pipeline for the pairing outcome notice (docs/specs/mobile-pairing-outcome-notice.md):
 * mint with topicId → redeem → approve/decline/undeliverable → exactly one line to that topic,
 * through the real routes and a real watch store. The automation reply transport is a stub that
 * records what would reach `/telegram/reply`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createPairingOutcomeNotice } from '../../src/server/pairingOutcomeNotice.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { matchesSystemTemplate } from '../../src/messaging/system-templates.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-outcome-notice.test.ts' });
});

interface Posted { topicId: number; body: { text: string; metadata: Record<string, unknown> }; logicalSendId: string; headers: Record<string, string> }

function setup(opts: { dmFails?: boolean; anchor?: string | null; telegram?: boolean; outcomeOff?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-outcome-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.outcomeOff ? { outcomeNotice: { enabled: false } } : {}) },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const dms: Array<{ text: string }> = [];
  const posted: Posted[] = [];
  const attention: Array<{ id: string; summary: string }> = [];
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const outcomeNotice = createPairingOutcomeNotice({
    post: async (topicId, body, logicalSendId, o) => {
      posted.push({ topicId, body: body as Posted['body'], logicalSendId, headers: o.headers });
      return new Response(JSON.stringify({ ok: true, topicId }), { status: 200 });
    },
    port: 0, authToken: 'tok-1',
    available: () => opts.telegram !== false,
    recentOperatorInbound: () => (opts.anchor === undefined ? '9001' : opts.anchor),
    upsertAttention: async (item) => { attention.push(item); return {}; },
  });
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_self', fetchFn,
    ownerDM: async (text) => { if (opts.dmFails) return null; dms.push({ text }); return 4242; },
    holdsLease: () => true,
    outcomeNotice,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.outcomes?.stop(); // passes are driven by the test
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  return { app, svc, dms, posted, attention };
}

const mint = (app: express.Express, extra: Record<string, unknown> = {}) =>
  request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer tok-1').send({ label: 'Justin iPhone', ...extra });
const redeem = (app: express.Express, code: string, dev = makeDevice()) =>
  request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code, deviceName: "Justin's iPhone", devicePublicKey: dev.publicKey });

let lastSignTime = 0;
function signed(app: express.Express, dev: ReturnType<typeof makeDevice>, deviceId: string, p: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  lastSignTime = Math.max(Date.now(), lastSignTime + 1);
  const time = String(lastSignTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, 'POST', p, time, raw));
  return request(app).post(p).set('Content-Type', 'application/json')
    .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
}
const codeFrom = (dm: { text: string }) => /is (\d{3}) (\d{3})\./.exec(dm.text)!.slice(1).join('');

describe('pairing outcome notice over HTTP', () => {
  it('mint with topicId → redeem → confirm → exactly one paired line in that topic, as a system template', async () => {
    const ctx = setup();
    const m = await mint(ctx.app, { topicId: '143125' });
    expect(m.status).toBe(200);
    expect(m.body.outcomeNotice).toEqual({ topicId: 143125, watchId: expect.any(String) });
    expect(m.body.outcomeNoticeReason).toBeUndefined();
    const dev = makeDevice();
    const r = await redeem(ctx.app, m.body.code, dev);
    expect(r.status).toBe(200);
    await ctx.svc.outcomes!.pass();
    expect(ctx.posted).toHaveLength(0); // still pending
    const ok = await signed(ctx.app, dev, r.body.deviceId, '/mobile/device/confirm', { code: codeFrom(ctx.dms[0]!) });
    expect(ok.body.status).toBe('active');
    await ctx.svc.outcomes!.pass();
    await ctx.svc.outcomes!.pass();
    expect(ctx.posted).toHaveLength(1);
    const p = ctx.posted[0]!;
    expect(p.topicId).toBe(143125);
    expect(p.body.text).toMatch(/^A phone named "Justin's iPhone" was paired with echo \(key [0-9A-F-]{19}\)\.$/);
    expect(matchesSystemTemplate(p.body.text)).toBe(true);
    expect(p.headers['X-Instar-System']).toBe('true');
    expect(p.body.metadata).toEqual({ source: 'mobile-pairing-outcome', inboundMessageId: '9001' });
    expect(p.logicalSendId).toBe(`mobile-pairing-outcome:${m.body.outcomeNotice.watchId}`);
    // The agent's structured read.
    const devices = await request(ctx.app).get('/mobile/devices').set('Authorization', 'Bearer tok-1');
    expect(devices.body.pairingOutcomes[0]).toMatchObject({ watchId: m.body.outcomeNotice.watchId, topicId: 143125, outcome: 'paired', state: 'sent' });
  });

  it('a declined phone gets the declined line', async () => {
    const ctx = setup();
    const m = await mint(ctx.app, { topicId: 77 });
    const r = await redeem(ctx.app, m.body.code);
    expect(ctx.svc.devices.decline(r.body.deviceId)).toBe('declined');
    await ctx.svc.outcomes!.pass();
    expect(ctx.posted.map((x) => x.body.text)).toEqual(['A phone named "Justin\'s iPhone" was not paired with echo: the request was declined or cancelled.']);
  });

  it('an owner message that cannot be sent gives the not-delivered line', async () => {
    const ctx = setup({ dmFails: true });
    const m = await mint(ctx.app, { topicId: 77 });
    expect((await redeem(ctx.app, m.body.code)).status).toBe(409);
    await ctx.svc.outcomes!.pass();
    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0]!.body.text).toBe('A phone tried to pair with echo, but I could not send you the approval message. Open a private chat with echo in Telegram and send it any message, then ask for a new link.');
  });

  it('never refuses the link: negative ids, unexpanded variables, no Telegram and the kill switch all mint with a reason', async () => {
    for (const [ctx, extra] of [
      [setup(), { topicId: -129091233340 }],
      [setup(), { topicId: '$INSTAR_TOPIC_ID' }],
      [setup({ telegram: false }), { topicId: 5 }],
      [setup({ outcomeOff: true }), { topicId: 5 }],
    ] as const) {
      const m = await mint(ctx.app, extra as Record<string, unknown>);
      expect(m.status).toBe(200);
      expect(m.body.link).toMatch(/^https:\/\/instar\.sh\/pair#/);
      expect(m.body.outcomeNotice).toBeNull();
      expect(typeof m.body.outcomeNoticeReason).toBe('string');
    }
  });

  it('no recent operator message: watched, but the line is sent unanchored (quiet feed) and the response says so', async () => {
    const ctx = setup({ anchor: null });
    const m = await mint(ctx.app, { topicId: 8 });
    expect(m.body.outcomeNotice).toMatchObject({ topicId: 8 });
    expect(m.body.outcomeNoticeReason).toMatch(/quiet feed/);
    const r = await redeem(ctx.app, m.body.code);
    ctx.svc.devices.decline(r.body.deviceId);
    await ctx.svc.outcomes!.pass();
    expect(ctx.posted[0]!.body.metadata.inboundMessageId).toBeUndefined();
  });

  it('without topicId the response is unchanged and nothing is watched', async () => {
    const ctx = setup();
    const m = await mint(ctx.app);
    expect(Object.keys(m.body).sort()).toEqual(['code', 'expiresAt', 'link', 'originKind', 'person']);
    expect(ctx.svc.outcomes!.list()).toHaveLength(0);
  });
});
