/**
 * HTTP pipeline for the Work Board (docs/specs/work-board-asks.md §4, §7) through the production
 * authMiddleware, the device authenticator with its allowlist, the memory-session guard and the
 * real MobilePairingService, over a real WorkBoardService:
 *   - the owner's phone taps with a Face ID signature over the exact action line; a signature
 *     over a different card state, a replay, a member's phone and the bearer are refused;
 *   - a member's phone reads the board and sees no card whose conversation it may not read;
 *   - a scoped session (mps_ token) reads and writes records on the ONE card whose conversation
 *     is its own, and reaches nothing else;
 *   - the console's PIN tap is bound to the card as shown (stale refused);
 *   - visibility by the shared conversation check: an unshared card is a 404, a shared one omits
 *     `source` and `projectKey`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, devicePersonOf, deviceMayUse, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { createMandatePinCheck } from '../../src/server/mandatePin.js';
import { registerWorkBoardRoutes, performOwnerTap, type WorkBoardRouteDeps, type ResolvedCaller } from '../../src/server/workBoardRoutes.js';
import { WorkBoardService, resolveWorkBoardSettings } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, tapActionLine, sha256Hex, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const PIN = '424242';
const TOKEN = 'tok-1';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/work-board-routes.test.ts' });
});

const CARD = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false };

function setup(opts: { testCaller?: (req: express.Request) => ResolvedCaller | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-board-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }, { id: 'adriana', name: 'Adriana', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, dashboardPin: PIN, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pairing = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(pairing);

  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-12T20:00:00Z'); let logical = 0;
  const settings = resolveWorkBoardSettings({});
  const lines: string[] = []; const removed: string[] = [];
  const svc = new WorkBoardService({
    machineId: 'm_self',
    emit: (_k, build) => {
      const hlc: HlcTimestamp = { physical: (clock += 1000), logical: logical++, node: 'm_self' };
      const data = build(hlc, 'm_self'); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_self' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: () => null, dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }), displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  const sessions = new Map<string, { sessionId: string; audience: never; placeKey: string | null }>();
  const requirePin = createMandatePinCheck({ dashboardPin: () => PIN });
  const shared = new Set<string>();
  const routeDeps: WorkBoardRouteDeps = {
    enabled: () => true, svc: () => svc, controller: () => null, settings: () => settings,
    caller: (req) => {
      const forced = opts.testCaller?.(req); if (forced) return forced;
      const session = (req.res?.locals as { memorySession?: { placeKey: string | null } } | undefined)?.memorySession;
      if (session) return { kind: 'session', conversationKey: session.placeKey?.startsWith('app:') ? session.placeKey.slice(4) : null };
      const person = devicePersonOf(req);
      if (person) return { kind: 'device', personKey: person.role === 'owner' ? 'justin' : (person.userId ?? null), isOwner: person.role === 'owner', mayRead: (ck) => deviceMayUse(pairing, req, `app:${ck}`, 'read') };
      return { kind: 'bearer' };
    },
    ownerPersonKey: () => 'justin',
    requirePin: (req, res, message) => requirePin(req, res, { message }),
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
    appendLine: async (_ck, _id, text) => { lines.push(text); },
    ensureConversation: async () => {}, removeConversation: async (ck) => { removed.push(ck); },
    behind: () => null, lastWrittenOn: () => null, repliedAfterQuestion: () => false, brokenAttachments: () => [], when: (iso) => iso,
    saveSettings: () => true,
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(pairing), (token) => sessions.get(token) ?? null));
  const router = express.Router();
  registerWorkBoardRoutes(router, routeDeps);
  mountMobilePermissionsRoutes(router, {
    pairing: () => pairing, config: () => config, stateDir: dir,
    bearerOk: (req: express.Request) => req.headers.authorization === `Bearer ${TOKEN}`,
    workCardTap: async (cardId: string, tap: Record<string, unknown>) => performOwnerTap(routeDeps, svc, cardId, tap, { kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true }),
  } as unknown as MobilePermissionsDeps);
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' | 'team' }) => {
    const dev = makeDevice(); const presence = makeDevice();
    const created = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    pairing.devices.applyConfirm(created.device.id, { ok: true });
    pairing.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { app, svc, pair, lines, removed, sessions, shared, dir };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'POST' | 'GET', p: string, body?: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw));
  const r = method === 'POST' ? request(app).post(p).set('Content-Type', 'application/json') : request(app).get(p);
  r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return method === 'POST' ? r.send(raw.toString()) : r;
}
const bearer = () => ({ Authorization: `Bearer ${TOKEN}` });

function agentCard(svc: WorkBoardService, over: Record<string, unknown> = {}) {
  const r = svc.createCard({ kind: 'agent' }, { ...CARD, ...over });
  if (!r.ok) throw new Error('create');
  const card = svc.view(r.cardId)!.card;
  return { id: r.cardId, conversationKey: r.conversationKey, materialHash: card.materialHash, titleHash: sha256Hex(card.title) };
}

describe('phone taps (Face ID over the exact action line)', () => {
  async function tapFlow(c: ReturnType<typeof setup>, phone: Phone, cardId: string, fields: Record<string, string>, signOver?: Record<string, string>) {
    const ch = await send(c.app, phone, 'POST', '/mobile/permissions/challenge', { action: 'work-card-tap', target: cardId, tapAction: fields.action, ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'action')) });
    if (ch.status !== 200) return ch;
    const over = signOver ?? fields;
    const line = tapActionLine({ cardId, ...over } as Parameters<typeof tapActionLine>[0]);
    const presenceSig = phone.presence.sign(permissionPresenceMessage(phone.id, HOST, ch.body.challenge, line));
    return send(c.app, phone, 'POST', `/mobile/work-board/cards/${cardId}/tap`, { ...fields, challenge: ch.body.challenge, presenceSig });
  }

  it('the owner\'s phone approves a card; the tap records the phone proof and leaves one transcript line', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    const r = await tapFlow(c, owner, card.id, { action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.card.approved).toBe(true);
    expect(r.body.card.taps.at(-1).by.proof).toBe('phone');
    expect(c.lines.filter((l) => l.startsWith('Work board: approved by Justin'))).toHaveLength(1);
    const audit = fs.readFileSync(path.join(c.dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.find((x) => x.event === 'work-card-tap')).toMatchObject({ deviceId: owner.id, action: 'work-card-tap', target: card.id, status: 200 });
  });

  it('a signature over a different card state is refused, and so is a replay', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    const wrong = await tapFlow(c, owner, card.id, { action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash }, { action: 'approve', materialHash: 'a'.repeat(64), titleHash: card.titleHash });
    expect(wrong.status).toBe(401); expect(wrong.body.error).toBe('presence-invalid');
    expect(c.svc.view(card.id)!.card.approvalValid).toBe(false);
    // A challenge issued for one action line cannot carry another.
    const ch = await send(c.app, owner, 'POST', '/mobile/permissions/challenge', { action: 'work-card-tap', target: card.id, tapAction: 'hold' });
    const line = tapActionLine({ cardId: card.id, action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash });
    const swapped = await send(c.app, owner, 'POST', `/mobile/work-board/cards/${card.id}/tap`, { action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash, challenge: ch.body.challenge, presenceSig: owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ch.body.challenge, line)) });
    expect(swapped.status).toBe(401); expect(swapped.body.error).toBe('challenge-invalid');
  });

  it('a stale approval that is correctly signed is still refused by the store', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    expect(c.svc.edit({ kind: 'agent' }, card.id, { need: 'Changed after the phone loaded the card' }).ok).toBe(true);
    const r = await tapFlow(c, owner, card.id, { action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash });
    expect(r.status).toBe(409); expect(r.body.error).toBe('stale-card');
  });

  it('a member\'s phone and the bearer cannot tap', async () => {
    const c = setup(); const member = c.pair({ userId: 'adriana', role: 'team' }); const card = agentCard(c.svc);
    const ch = await send(c.app, member, 'POST', '/mobile/permissions/challenge', { action: 'work-card-tap', target: card.id, tapAction: 'hold' });
    expect(ch.status).toBe(403);
    const direct = await send(c.app, member, 'POST', `/mobile/work-board/cards/${card.id}/tap`, { action: 'hold', challenge: 'x', presenceSig: 'y' });
    expect(direct.status).toBe(403);
    const b = await request(c.app).post(`/mobile/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'hold' });
    expect(b.status).toBe(403); expect(b.body.error).toBe('device-signature-required');
    expect(c.svc.view(card.id)!.card.holds).toHaveLength(0);
  });

  it('the owner\'s phone reads the board and may tap; another person\'s phone is never offered a tap or the pickup counts', async () => {
    const c = setup(); const owner = c.pair(); const helper = c.pair({ userId: 'adriana', role: 'msp' }); const card = agentCard(c.svc);
    const o = await send(c.app, owner, 'GET', '/mobile/work-board');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.lanes[0].cards.map((x: { id: string }) => x.id)).toEqual([card.id]);
    expect(o.body.viewer.canTap).toBe(true);
    // A phone of a person who is not the owner goes through the same shared conversation check per
    // card (both sides of that check are covered below with a controlled answer).
    const m = await send(c.app, helper, 'GET', '/mobile/work-board');
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.viewer.canTap).toBe(false);
    expect(m.body.pickups).toBeUndefined();
    expect(m.body.settings).toBeUndefined();
    for (const x of m.body.lanes.flatMap((l: { cards: Array<Record<string, unknown>> }) => l.cards)) { expect(x.source).toBeUndefined(); expect(x.projectKey).toBeUndefined(); }
  });
});

describe('scoped sessions (mps_ tokens)', () => {
  it('reads and writes records on its own card only; no lanes, no create, no tap', async () => {
    const c = setup();
    const mine = agentCard(c.svc); const other = agentCard(c.svc, { title: 'Other card' });
    c.sessions.set('mps_abc', { sessionId: 's1', audience: { kind: 'owner' } as never, placeKey: `app:${mine.conversationKey}` });
    const s = { Authorization: 'Bearer mps_abc' };
    const own = await request(c.app).get(`/work-board/cards/${mine.id}`).set(s);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const edit = await request(c.app).post(`/work-board/cards/${mine.id}/records`).set(s).send({ kind: 'edited', recommendation: 'Venue B' });
    expect(edit.status).toBe(200);
    expect((await request(c.app).get(`/work-board/cards/${other.id}`).set(s)).status).toBe(404);
    expect((await request(c.app).post(`/work-board/cards/${other.id}/records`).set(s).send({ kind: 'edited', recommendation: 'x' })).status).toBe(404);
    // The guard refuses every route it does not name, before any handler runs.
    for (const [m, p] of [['get', '/work-board'], ['post', '/work-board/cards'], ['post', `/work-board/cards/${mine.id}/tap`], ['post', '/work-board/settings']] as const) {
      const r = await (request(c.app) as unknown as Record<string, (p: string) => request.Test>)[m](p).set(s).send({});
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/waitingOnYou|softOpenCards/);
    }
  });

  it('a session bound to a non-app place reaches no card', async () => {
    const c = setup(); const card = agentCard(c.svc);
    c.sessions.set('mps_tg', { sessionId: 's2', audience: { kind: 'owner' } as never, placeKey: 'telegram:42' });
    expect((await request(c.app).get(`/work-board/cards/${card.id}`).set({ Authorization: 'Bearer mps_tg' })).status).toBe(404);
  });
});

describe('console PIN taps and the agent', () => {
  it('the PIN tap is bound to the card as shown; the agent\'s token alone is refused', async () => {
    const c = setup(); const card = agentCard(c.svc);
    const noPin = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'approve', materialHash: card.materialHash });
    expect(noPin.status).toBe(403); expect(noPin.body.error).toBe('person-required');
    const stale = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'approve', materialHash: card.materialHash, titleHash: sha256Hex('a different title'), pin: PIN });
    expect(stale.status).toBe(409); expect(stale.body.error).toBe('stale-card');
    const ok = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'approve', materialHash: card.materialHash, titleHash: card.titleHash, pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body.card.taps.at(-1).by.proof).toBe('console PIN');
  });

  it('a card written from the console with the PIN is person-written and needs no approval; without it, it is the agent\'s', async () => {
    const c = setup();
    const person = await request(c.app).post('/work-board/cards').set(bearer()).send({ ...CARD, pin: PIN });
    expect(person.status).toBe(201); expect(person.body.card.approvalRequired).toBe(false);
    const agent = await request(c.app).post('/work-board/cards').set(bearer()).send(CARD);
    expect(agent.status).toBe(201); expect(agent.body.card.approvalRequired).toBe(true);
    const wrong = await request(c.app).post('/work-board/cards').set(bearer()).send({ ...CARD, pin: '000000' });
    expect(wrong.status).toBe(403);
  });

  it('a redact removes the conversation and the text from every read', async () => {
    const c = setup(); const card = agentCard(c.svc, { title: 'Sensitive title', need: 'Sensitive need' });
    const r = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'redact', pin: PIN });
    expect(r.status).toBe(200);
    expect(c.removed).toEqual([card.conversationKey]);
    const read = await request(c.app).get(`/work-board/cards/${card.id}`).set(bearer());
    expect(JSON.stringify(read.body)).not.toMatch(/Sensitive/);
    expect(read.body.card.status).toBe('removed');
    const board = await request(c.app).get('/work-board').set(bearer());
    expect(JSON.stringify(board.body)).not.toMatch(/Sensitive/);
    const write = await request(c.app).post(`/work-board/cards/${card.id}/records`).set(bearer()).send({ kind: 'edited', recommendation: 'x' });
    expect(write.status).toBe(409); expect(write.body.error).toBe('card-removed');
  });
});

describe('visibility follows the card\'s conversation', () => {
  it('an unshared card is a 404 for a member; a shared one is readable without source or projectKey; an msp-style reader reads but cannot tap', async () => {
    const shared = new Set<string>();
    const c = setup({ testCaller: (req) => {
      const who = req.headers['x-test-person'];
      if (who === 'adriana') return { kind: 'device', personKey: 'adriana', isOwner: false, mayRead: (ck) => shared.has(ck) };
      if (who === 'msp') return { kind: 'device', personKey: 'helper', isOwner: false, mayRead: () => true };
      return null;
    } });
    const made = c.svc.createCard({ kind: 'agent' }, { ...CARD, projectKey: 'telegram:141014', source: { conversationKey: 'app:abc', messageId: 'm1' } });
    if (!made.ok) throw new Error('create');
    const h = { ...bearer(), 'x-test-person': 'adriana' };
    expect((await request(c.app).get(`/work-board/cards/${made.cardId}`).set(h)).status).toBe(404);
    expect((await request(c.app).get('/work-board').set(h)).body.lanes.flatMap((l: { cards: unknown[] }) => l.cards)).toEqual([]);
    shared.add(made.conversationKey);
    const seen = await request(c.app).get(`/work-board/cards/${made.cardId}`).set(h);
    expect(seen.status).toBe(200);
    expect(seen.body.card.title).toBe(CARD.title);
    expect(seen.body.card.source).toBeUndefined();
    expect(seen.body.card.projectKey).toBeUndefined();
    expect(seen.body.card.lane).toBe('waiting-on-others');
    // The owner (bearer) sees both fields.
    const own = await request(c.app).get(`/work-board/cards/${made.cardId}`).set(bearer());
    expect(own.body.card.projectKey).toBe('telegram:141014');
    // A reader acting for the owner reads every card and cannot tap.
    const msp = { ...bearer(), 'x-test-person': 'msp' };
    expect((await request(c.app).get(`/work-board/cards/${made.cardId}`).set(msp)).status).toBe(200);
    const tap = await request(c.app).post(`/work-board/cards/${made.cardId}/tap`).set(msp).send({ action: 'hold', pin: PIN });
    expect(tap.status).toBe(403); expect(tap.body.error).toBe('person-required');
  });
});
