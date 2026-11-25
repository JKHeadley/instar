/**
 * Work cards from the owner's phone (docs/specs/phone-work-cards.md), through the production authMiddleware,
 * the device authenticator with its allowlist and the real MobilePairingService, with REAL device and presence
 * signatures, over a real WorkBoardService:
 *   - GET /mobile/work-board/cards/:id: the owner's phone reads one card (the board's card JSON); a member's
 *     phone and a scoped session are refused; an unknown card is a 404;
 *   - POST /mobile/work-board/cards: the owner's phone makes a card from a Telegram and an app message with
 *     Face ID over `work-card-create <requestId> <draftHash>`, storing `source` exactly; another device, the
 *     bearer, a missing, forged or wrong-draft presence signature are refused; an unknown source and an
 *     over-limit card are refused before the challenge is consumed; preflight writes nothing; a retry returns
 *     the same card and writes nothing; a reused request id with a different draft is refused.
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
import { registerWorkBoardRoutes, type WorkBoardRouteDeps } from '../../src/server/workBoardRoutes.js';
import { answerPhoneCardCreate, phoneCardPrecheck, phoneCardDraftHash, phoneCardId, parsePhoneCardDraft } from '../../src/server/phoneWorkCards.js';
import { WorkBoardService, resolveWorkBoardSettings } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const PIN = '424242';
const TOKEN = 'tok-1';
const APP_KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/phone-work-cards.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-work-cards-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }, { id: 'adriana', name: 'Adriana', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, dashboardPin: PIN, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pairing = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(pairing);
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-17T20:00:00Z'); let logical = 0;
  const settings = resolveWorkBoardSettings({});
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
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }), displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  const sessions = new Map<string, { sessionId: string; audience: never; placeKey: string | null }>();
  const requirePin = createMandatePinCheck({ dashboardPin: () => PIN });
  const conversations = new Set<string>();
  const known = new Set<string>(['telegram:4242', `app:${APP_KEY}`]);
  const routeDeps: WorkBoardRouteDeps = {
    enabled: () => true, svc: () => svc, controller: () => null, settings: () => settings,
    caller: (req) => {
      const session = (req.res?.locals as { memorySession?: { placeKey: string | null } } | undefined)?.memorySession;
      if (session) return { kind: 'session', conversationKey: session.placeKey?.startsWith('app:') ? session.placeKey.slice(4) : null };
      const person = devicePersonOf(req);
      if (person) return { kind: 'device', personKey: person.role === 'owner' ? 'justin' : (person.userId ?? null), isOwner: person.role === 'owner', mayRead: (ck) => deviceMayUse(pairing, req, `app:${ck}`, 'read') };
      return { kind: 'bearer' };
    },
    ownerPersonKey: () => 'justin',
    requirePin: (req, res, message) => requirePin(req, res, { message }),
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
    appendLine: async () => {}, ensureConversation: async (_id, key) => { conversations.add(key); }, removeConversation: async () => {},
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
    // The production wiring's shape (routes.ts): the shared source rule, then the shared conversation check.
    workCardCreate: {
      precheck: (requestId, draft, req) => phoneCardPrecheck(routeDeps, requestId, draft, () => known.has(draft.source.conversationKey) && deviceMayUse(pairing, req, draft.source.conversationKey, 'read')),
      create: (requestId, draft, draftHash) => answerPhoneCardCreate(routeDeps, requestId, draft, draftHash),
    },
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
  return { app, svc, pair, journal, sessions, conversations, dir, known };
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

let reqN = 0;
const freshId = () => `6f1c2a40-0b1e-4c8e-9a51-${String(100000000000 + (reqN++)).padStart(12, '0')}`;
function cardBody(over: Record<string, unknown> = {}) {
  return { requestId: freshId(), title: 'Book the venue', need: 'Adriana asked us to book the venue for Friday.', doneWhen: [{ id: 'd1', text: 'The venue is booked' }], source: { conversationKey: 'telegram:4242', messageId: '991' }, ...over };
}
const hashOf = (b: Record<string, unknown>) => { const p = parsePhoneCardDraft(b); if (!p.ok) throw new Error(p.error); return phoneCardDraftHash(p.draft); };

/** The phone's whole flow: challenge for the line, Face ID over it, then the create. `signHash` signs a different draft. */
async function make(c: ReturnType<typeof setup>, phone: Phone, body: Record<string, unknown>, opts: { signHash?: string; presence?: 'missing' | 'forged' } = {}) {
  const h = hashOf(body);
  const ch = await send(c.app, phone, 'POST', '/mobile/permissions/challenge', { action: 'work-card-create', target: body.requestId, proposalHash: opts.signHash ?? h });
  if (ch.status !== 200) return ch;
  const line = `work-card-create ${body.requestId} ${opts.signHash ?? h}`;
  const signer = opts.presence === 'forged' ? makeDevice() : phone.presence;
  const presenceSig = opts.presence === 'missing' ? undefined : signer.sign(permissionPresenceMessage(phone.id, HOST, ch.body.challenge, line));
  return send(c.app, phone, 'POST', '/mobile/work-board/cards', { ...body, challenge: ch.body.challenge, ...(presenceSig ? { presenceSig } : {}) });
}

describe('GET /mobile/work-board/cards/:id (owner phone)', () => {
  it('the owner\'s phone reads one card as the board shows it; unknown is 404; a member\'s phone and a scoped session are refused', async () => {
    const c = setup(); const owner = c.pair(); const member = c.pair({ userId: 'adriana', role: 'team' });
    const made = c.svc.createCard({ kind: 'agent' }, { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false });
    if (!made.ok) throw new Error('create');
    const r = await send(c.app, owner, 'GET', `/mobile/work-board/cards/${made.cardId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const board = await send(c.app, owner, 'GET', '/mobile/work-board');
    const onBoard = board.body.lanes.flatMap((l: { cards: Array<{ id: string }> }) => l.cards).find((x: { id: string }) => x.id === made.cardId);
    expect(r.body.card).toEqual(onBoard);
    expect((await send(c.app, owner, 'GET', '/mobile/work-board/cards/wc_0123456789abcdef')).status).toBe(404);
    const m = await send(c.app, member, 'GET', `/mobile/work-board/cards/${made.cardId}`);
    expect([403, 404]).toContain(m.status); expect(m.body.card).toBeUndefined();
    c.sessions.set('mps_test', { sessionId: 's1', audience: 'x' as never, placeKey: `app:${made.conversationKey}` });
    const s = await request(c.app).get(`/mobile/work-board/cards/${made.cardId}`).set({ Authorization: 'Bearer mps_test' });
    expect(s.status).toBe(403); expect(s.body.card).toBeUndefined();
  });
});

describe('POST /mobile/work-board/cards (owner phone, Face ID)', () => {
  it('makes a card from a Telegram message and from an app message, storing source exactly; audited', async () => {
    const c = setup(); const owner = c.pair();
    const tg = cardBody();
    const r = await make(c, owner, tg);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.cardId).toBe(phoneCardId('justin', tg.requestId));
    expect(r.body.card.source).toEqual(tg.source);
    expect(c.conversations.has(r.body.conversationKey)).toBe(true);
    const created = c.journal.find((e) => e.data.recordType === 'created' && e.data.cardId === r.body.cardId)!.data;
    expect(created.by).toEqual({ kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true });
    expect(created.source).toEqual(tg.source);
    const app = cardBody({ source: { conversationKey: `app:${APP_KEY}`, messageId: 'evt-77' } });
    const a = await make(c, owner, app);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.card.source).toEqual({ conversationKey: `app:${APP_KEY}`, messageId: 'evt-77' });
    const audit = fs.readFileSync(path.join(c.dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.filter((x) => x.event === 'work-card-created')).toHaveLength(2);
    expect(audit.find((x) => x.event === 'work-card-created')).toMatchObject({ deviceId: owner.id, action: 'work-card-create', target: tg.requestId, status: 201 });
  });

  it('another person\'s phone and the bearer cannot make a card; nothing is written', async () => {
    const c = setup(); c.pair(); const member = c.pair({ userId: 'adriana', role: 'team' }); const helper = c.pair({ userId: 'adriana', role: 'msp' });
    for (const phone of [member, helper]) {
      const body = cardBody();
      const ch = await send(c.app, phone, 'POST', '/mobile/permissions/challenge', { action: 'work-card-create', target: body.requestId, proposalHash: hashOf(body) });
      expect(ch.status).toBe(403);
      const direct = await send(c.app, phone, 'POST', '/mobile/work-board/cards', { ...body, challenge: 'x', presenceSig: 'y' });
      expect(direct.status).toBe(403);
    }
    const b = await request(c.app).post('/mobile/work-board/cards').set(bearer()).send({ ...cardBody(), pin: PIN });
    expect(b.status).toBe(403); expect(b.body.error).toBe('device-signature-required');
    expect(c.journal).toHaveLength(0);
  });

  it('a missing, forged or other-draft presence signature is refused; a body changed after Face ID finds no challenge', async () => {
    const c = setup(); const owner = c.pair();
    const missing = await make(c, owner, cardBody(), { presence: 'missing' });
    expect(missing.status).toBe(401); expect(missing.body.error).toBe('presence-invalid');
    const forged = await make(c, owner, cardBody(), { presence: 'forged' });
    expect(forged.status).toBe(401); expect(forged.body.error).toBe('presence-invalid');
    // Face ID over one draft, a different draft sent: the challenge was issued for the other line.
    const body = cardBody();
    const swapped = await make(c, owner, { ...body, title: 'Something the owner never saw' }, { signHash: hashOf(body) });
    expect(swapped.status).toBe(401); expect(swapped.body.error).toBe('challenge-invalid');
    expect(c.journal).toHaveLength(0);
  });

  it('an unknown source and an over-limit card are refused before the challenge is consumed; preflight answers the line and writes nothing', async () => {
    const c = setup(); const owner = c.pair();
    const body = cardBody({ source: { conversationKey: 'telegram:777', messageId: '1' } });
    const h = hashOf(body);
    const ch = await send(c.app, owner, 'POST', '/mobile/permissions/challenge', { action: 'work-card-create', target: body.requestId, proposalHash: h });
    const presenceSig = owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ch.body.challenge, `work-card-create ${body.requestId} ${h}`));
    const r = await send(c.app, owner, 'POST', '/mobile/work-board/cards', { ...body, challenge: ch.body.challenge, presenceSig });
    expect(r.status).toBe(404); expect(r.body.error).toBe('source-conversation-not-found'); expect(r.body.message).toBeTruthy();
    // The conversation appears; the SAME challenge still works (it was not consumed by the refusal).
    c.known.add('telegram:777');
    const ok = await send(c.app, owner, 'POST', '/mobile/work-board/cards', { ...body, challenge: ch.body.challenge, presenceSig });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const long = cardBody({ title: 'x'.repeat(5000) });
    const pre = await send(c.app, owner, 'POST', '/mobile/work-board/cards', { ...long, preflight: true });
    expect(pre.status).toBe(413); expect(pre.body.error).toBe('over-limit');
    const good = cardBody();
    const count = c.journal.length;
    const p = await send(c.app, owner, 'POST', '/mobile/work-board/cards', { ...good, preflight: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toEqual({ draft: { title: good.title, need: good.need, doneWhen: good.doneWhen, source: good.source }, draftHash: hashOf(good), confirm: { action: 'work-card-create', target: good.requestId, proposalHash: hashOf(good), actionLine: `work-card-create ${good.requestId} ${hashOf(good)}` } });
    expect(c.journal.length).toBe(count);
  });

  it('a retry returns the same card and writes nothing; a reused request id with a different draft is refused', async () => {
    const c = setup(); const owner = c.pair();
    const body = cardBody();
    const first = await make(c, owner, body);
    expect(first.status).toBe(201);
    const count = c.journal.length;
    const again = await make(c, owner, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ cardId: first.body.cardId, replayed: true });
    expect(c.journal.length).toBe(count);
    const reused = await make(c, owner, { ...body, title: 'A different card' });
    expect(reused.status).toBe(409); expect(reused.body.error).toBe('request-id-reused');
    expect(c.journal.length).toBe(count);
    const audit = fs.readFileSync(path.join(c.dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8');
    expect(audit).toContain('"event":"work-card-replayed"');
  });
});
