/**
 * Feature-is-alive proof for the Needs-you read (docs/specs/work-front-doors.md decision 2, §7 stage 1):
 * an AgentServer booted on its production path and listening; the console (bearer) and an owner phone
 * (device signature, through its own device rule) both get the same answer, built over this server's own
 * loopback from Home's sources; a source that cannot be read is named instead of reading as zero; and a
 * synthetic need (an attention item raised for the owner) travels the real read and shows up.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { OwnerNeedsWithdrawal } from '../../src/core/OwnerNeedsWithdrawal.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { LocalAttentionItems } from '../../src/core/LocalAttentionItems.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-needs-e2e.example.dev';
const servers: AgentServer[] = [];
const closers: Array<{ close(): void }> = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const c of closers) c.close();
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/needs-read-alive.test.ts' });
});

async function boot(
  ownerNeedsCandidate?: ConstructorParameters<typeof AgentServer>[0]['ownerNeedsCandidate'],
  ownerNeedsWithdrawalJournalFor?: ConstructorParameters<typeof AgentServer>[0]['ownerNeedsWithdrawalJournalFor'],
) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'needs-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'needs-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    needsYou: { ownerAdmission: { enabled: false } },
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  // Capacity is full, but this ordinary wait requires no person to intervene.
  sessionManager.getCachedRunningSessions = () => ({count:1,sessions:[]});
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel, ownerNeedsCandidate, ownerNeedsWithdrawalJournalFor });
  servers.push(server);
  return { server, config };
}

describe('Needs-you read — production wiring', () => {
  it('is alive for the console and an owner phone, honest about what it could not check', async () => {
    const { server, config } = await boot();
    const app = server.getApp();
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'needs-e2e');
    expect((await request(app).get('/needs')).status).toBe(401);

    // Real wiring: the route reads Home's sources over this server's own loopback.
    const listener = app.listen(0);
    closers.push(listener);
    config.port = (listener.address() as { port: number }).port;

    // Seed the production attention store before the first read populates the owner cache.
    const attention = new LocalAttentionItems(config.stateDir);
    for (let n = 1; n <= 105; n++) {
      expect(attention.raise({
        id: `desktop-${n}`, title: `Review desktop request ${n}`, summary: 'Review the request on the Desktop page.',
        category: 'desktop', priority: 'HIGH', source: 'agent',
      })).toBe(true);
    }

    const first = await auth(request(app).get('/needs'));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ schemaVersion: 1, viewer: { role: 'owner' }, agent: { name: 'needs-e2e' } });
    expect(Array.isArray(first.body.items)).toBe(true);
    expect(Array.isArray(first.body.sources)).toBe(true);
    // Every source this agent reads is accounted for: ok, off or named as could-not-check. Never silently absent.
    for (const s of first.body.sources) expect(['ok', 'off', 'failed']).toContain(s.state);
    expect(first.body.complete).toBe(first.body.couldNotCheck.length === 0);
    for (const s of first.body.sources.filter((x: { state: string }) => x.state === 'failed')) expect(first.body.couldNotCheck).toContain(s.label);
    expect(first.body.count === 0 && first.body.complete).toBe(first.body.items.length === 0 && first.body.couldNotCheck.length === 0);
    // A feature switched off on this agent (here: plan tracking and the blocker list) is off, never
    // "could not check", even when its 503 also says "not initialized".
    expect(first.body.couldNotCheck).not.toContain('plans');
    const health = await auth(request(app).get('/mobile/health-issues'));
    expect(health.status).toBe(200);
    expect(health.body.issues).toContainEqual(expect.objectContaining({id:'health:sessions-full',requiresUserAction:false}));
    expect(first.body.sources.find((s: {id:string}) => s.id === 'health').state).toBe('ok');
    expect(first.body.items.some((i: {title:string}) => i.title === 'All session slots are in use')).toBe(false);
    // Each thing once (work-board-cards-appear §3, amended 2026-11-18): an item that IS its card opens the card and
    // keeps its own conversation in alsoOpens, and no card stands behind two items.
    const cardIds: string[] = [];
    for (const i of first.body.items as Array<{ action: { kind: string; href?: string }; card?: { id: string }; alsoOpens?: { href: string } }>) {
      if (i.alsoOpens) { expect(i.action.href).toMatch(/^#\/work\/board\?card=wc_/); expect(i.alsoOpens.href).toMatch(/^#\/work\/chats\?c=/); }
      if (i.card) cardIds.push(i.card.id);
    }
    expect(new Set(cardIds).size).toBe(cardIds.length);

    // An owner phone, paired through the existing path, gets the same list through its own device rule.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    let t = Date.now();
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    const code = /is (\d{3}) (\d{3})\./.exec(dms[dms.length - 1]!)!.slice(1).join('');
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    const phone = await send('GET', '/mobile/needs');
    expect(phone.status, JSON.stringify(phone.body)).toBe(200);
    expect(phone.body.viewer.role).toBe('owner');
    expect(phone.body.sources.find((s: {id:string}) => s.id === 'health').state).toBe('ok');
    expect(phone.body.items.some((i: {title:string}) => i.title === 'All session slots are in use')).toBe(false);
    expect(phone.body.sources.map((s: { id: string }) => s.id)).toEqual(first.body.sources.map((s: { id: string }) => s.id));
    // The phone still cannot reach the raw sources it was built from.
    expect((await send('GET', '/green-pr-automerge')).status).toBe(403);

    // Each caller obtains its own continuation through the public route and opens it
    // through the same authenticated entry point. The two pages cover every seeded need.
    for (const [firstPage, next] of [
      [first.body, (cursor: string) => auth(request(app).get('/needs?cursor=' + encodeURIComponent(cursor)))],
      [phone.body, (cursor: string) => send('GET', '/mobile/needs?cursor=' + encodeURIComponent(cursor))],
    ] as const) {
      expect(firstPage.items).toHaveLength(100);
      expect(firstPage.continuation.start).toBe(0);
      expect(typeof firstPage.continuation.nextCursor).toBe('string');
      const more = await next(firstPage.continuation.nextCursor);
      expect(more.status).toBe(200);
      expect(more.body.continuation.start).toBe(100);
      const all = [...firstPage.items, ...more.body.items];
      expect(new Set(all.map(i => i.id)).size).toBe(all.length);
      expect(all.filter(i => i.title.startsWith('Review desktop request '))).toHaveLength(105);
      const desktop = more.body.items.find((i: { title: string }) => i.title.startsWith('Review desktop request '));
      expect(desktop?.action).toMatchObject({ kind: 'href', href: expect.stringMatching(/^\/dashboard\/desktop\.html(?:\?|$)/) });
    }
    // A closed item changes the current list before the owner's first-page cache expires.
    expect(attention.setStatus('desktop-1', 'DONE')).toBeDefined();
    const stale = await send('GET', '/mobile/needs?cursor=' + encodeURIComponent(phone.body.continuation.nextCursor));
    expect(stale.status).toBe(409);
    expect(stale.body.items).toBeUndefined();

    // The canary's synthetic row exists only for its own single-use nonce: a guessed one adds nothing.
    const guessed = await auth(request(app).get('/needs?canary=cguess'));
    expect(guessed.status).toBe(200);
    expect(guessed.body.items.some((i: { source: string }) => i.source === 'canary')).toBe(false);
    const canary = await auth(request(app).get('/needs/canary'));
    expect(canary.status).toBe(200);
    expect(canary.body).toHaveProperty('consecutiveMisses');
    // A phone cannot read the canary's state (device rule: not allowed).
    expect((await send('GET', '/needs/canary')).status).toBe(403);
  }, 60_000);
});

describe('Needs-you in-place action floor — dark runtime', () => {
  it('projects verified owner actions in place and leaves agent work out of owner counts', async () => {
    let ask = { project: 'telegram:123', bindingVersion: 'v1', episode: 'episode-1', requestVersion: 'r1' };
    const withdrawals = new Map<string, OwnerNeedsWithdrawal>();
    const { server, config } = await boot(item => {
      if (item.title === 'Disk cleanup is ready') {
        return { responsibility: 'agent', actions: [], handoffs: [] };
      }
      if (item.title === 'Update Instar on your phone') {
        return { responsibility: 'owner-required', ownerAction: 'physical', presentation: 'update-instar-phone', actions: [{ kind: 'instructions', template: 'update-instar-phone' }], handoffs: [],
          withdrawal: { ask, record: [...withdrawals.values()][0] ?? null } };
      }
      return null;
    }, async req => req.get('X-Test-Coordinator') === 'test' ? {
      withAskLock: (_project, run) => run({
        authority: () => ({ principal: 'coordinator', leaseEpoch: 1 }),
        activeAsk: () => ({ identity: ask, state: 'pending' }),
        findWithdrawal: key => withdrawals.get(key) ?? null,
        appendIfCurrent: async record => { withdrawals.set(record.key, record); return true; },
      }),
    } : null);
    const app = server.getApp();
    const listener = app.listen(0);
    closers.push(listener);
    config.port = (listener.address() as { port: number }).port;
    const ownerRead = () => request(app).get('/needs').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'needs-e2e');
    const baseline = await ownerRead().set('X-Instar-Needs-Contract', 'in-place-v1').expect(200);
    const attention = new LocalAttentionItems(config.stateDir);
    for (const [id, title] of [['agent-cleanup', 'Disk cleanup is ready'], ['owner-phone-update', 'Update Instar on your phone']]) {
      expect(attention.raise({ id, title, summary: 'A test observation.', category: 'desktop', priority: 'HIGH', source: 'agent' })).toBe(true);
    }

    const older = await ownerRead().expect(426);
    expect(older.body).not.toHaveProperty('items');
    const result = await ownerRead().set('X-Instar-Needs-Contract', 'in-place-v1').expect(200);
    expect(result.body.schemaVersion).toBe(2);
    expect(result.body.items).toEqual([expect.objectContaining({
      title: 'Update Instar on your phone', ownerAction: 'physical', action: { kind: 'instructions', steps: expect.arrayContaining(['Open Instar again.']) },
    })]);
    expect(result.body.count).toBe(1);
    expect(result.body.divertedCount).toBe(baseline.body.divertedCount + 1);
    expect(JSON.stringify(result.body.items)).not.toContain('#/');
    const retire = () => request(app).post('/needs/withdrawals').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'needs-e2e');
    await retire().send(ask).expect(403);
    for (let n = 0; n < 2; n++) await retire().set('X-Test-Coordinator', 'test').send(ask).expect(200);
    expect(withdrawals.size).toBe(1);
    const hidden = await ownerRead().set('X-Instar-Needs-Contract', 'in-place-v1').expect(200);
    expect(hidden.body.items).toEqual([]);
    ask = { ...ask, episode: 'episode-2' };
    const next = await ownerRead().set('X-Instar-Needs-Contract', 'in-place-v1').expect(200);
    expect(next.body.items.map((item: { title: string }) => item.title)).toEqual(['Update Instar on your phone']);
  });
});
