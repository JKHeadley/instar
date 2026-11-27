/**
 * HTTP pipeline for Work Board slice 3 (docs/specs/work-front-doors.md §6, decision 3), through the production
 * authMiddleware, device authenticator and phone permission write gate over a real WorkBoardService:
 *   - the owner's phone closes a card as Done / Not important with Face ID over a line that carries the note;
 *     a missing note is refused before any challenge, and a signature over another note is refused;
 *   - the console closes with the PIN; the agent (bearer, no PIN) cannot;
 *   - the agent reads the dismissal lessons, and sees them in its create answer; a phone cannot read them;
 *   - a card read carries whose turn it is, whether work started, and its conversation's read and send routes.
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
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/work-card-closeout-routes.test.ts' });
});

const CARD = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false, recommendation: 'Book Hall A: it fits 40 and is near the station.', whyYou: 'Only you can choose where the launch is held.' };

function setup(opts: { testCaller?: (req: express.Request) => ResolvedCaller | null; specApprovalJudge?: WorkBoardRouteDeps['specApprovalJudge'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-card-closeout-int-'));
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
    ...(opts.specApprovalJudge ? { specApprovalJudge: opts.specApprovalJudge } : {}),
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

async function tapFlow(c: ReturnType<typeof setup>, phone: Phone, cardId: string, fields: Record<string, string>, signOver?: Record<string, string>) {
  const ch = await send(c.app, phone, 'POST', '/mobile/permissions/challenge', { action: 'work-card-tap', target: cardId, tapAction: fields.action, ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'action')) });
  if (ch.status !== 200) return ch;
  const line = tapActionLine({ cardId, ...(signOver ?? fields) } as Parameters<typeof tapActionLine>[0]);
  const presenceSig = phone.presence.sign(permissionPresenceMessage(phone.id, HOST, ch.body.challenge, line));
  return send(c.app, phone, 'POST', `/mobile/work-board/cards/${cardId}/tap`, { ...fields, challenge: ch.body.challenge, presenceSig });
}

describe('closing a card from the owner\'s phone (Face ID)', () => {
  it('Done with a note: the card moves to Done, the line names the note, the audit records the tap', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    const r = await tapFlow(c, owner, card.id, { action: 'archive', closeAs: 'done', note: 'Booked the Hall' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.card).toMatchObject({ lane: 'done', turn: 'nobody', closeout: { as: 'done', note: 'Booked the Hall', by: { proof: 'phone' } } });
    expect(c.lines).toContain('Work board: Justin closed this as done: "Booked the Hall" · ' + c.svc.view(card.id)!.card.closeout!.at);
  });
  it('a missing note is refused before a challenge is issued, so no Face ID is spent', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    const ch = await send(c.app, owner, 'POST', '/mobile/permissions/challenge', { action: 'work-card-tap', target: card.id, tapAction: 'archive', closeAs: 'not-important' });
    expect(ch.status).toBe(400); expect(ch.body.error).toBe('reason-required');
  });
  it('a signature over a different note is refused, and the card stays open', async () => {
    const c = setup(); const owner = c.pair(); const card = agentCard(c.svc);
    const r = await tapFlow(c, owner, card.id, { action: 'archive', closeAs: 'not-important', note: 'what the app sent' }, { action: 'archive', closeAs: 'not-important', note: 'what the person saw' });
    expect(r.status).toBe(401); expect(r.body.error).toBe('presence-invalid');
    expect(c.svc.view(card.id)!.card.archives).toEqual([]);
  });
});

describe('closing from the console, and the agent\'s lessons', () => {
  it('the console closes Not important with the PIN; the agent cannot; the reason becomes a lesson', async () => {
    const c = setup(); const card = agentCard(c.svc);
    const agentTry = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'archive', closeAs: 'not-important', note: 'x' });
    expect(agentTry.status).toBe(403); expect(agentTry.body.error).toBe('person-required');
    const noReason = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'archive', closeAs: 'not-important', note: '', pin: PIN });
    expect(noReason.status).toBe(400); expect(noReason.body.error).toBe('reason-required');
    const ok = await request(c.app).post(`/work-board/cards/${card.id}/tap`).set(bearer()).send({ action: 'archive', closeAs: 'not-important', note: 'We never use that venue', pin: PIN });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.card).toMatchObject({ lane: 'archived', closeout: { as: 'not-important', note: 'We never use that venue' } });
    const lessons = await request(c.app).get('/work-board/lessons').set(bearer());
    expect(lessons.status).toBe(200);
    expect(lessons.body.lessons).toEqual([expect.objectContaining({ reason: 'We never use that venue', cardId: card.id, cardTitle: 'Pick a venue', by: { personKey: 'justin', name: 'Justin' } })]);
    // The agent sees them again the moment it raises a new card.
    const made = await request(c.app).post('/work-board/cards').set(bearer()).send({ ...CARD, title: 'Another venue' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.lessons.map((l: { reason: string }) => l.reason)).toEqual(['We never use that venue']);
  });
  it('a phone cannot read the lessons', async () => {
    const c = setup(); const owner = c.pair();
    const r = await send(c.app, owner, 'GET', '/work-board/lessons');
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the card read: whose turn, started, and its conversation', () => {
  it('names the turn, untouched state and the existing conversation routes', async () => {
    const c = setup(); const card = agentCard(c.svc, { outward: true });
    const r = await request(c.app).get(`/work-board/cards/${card.id}`).set(bearer());
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ turn: 'you', started: false, startedAt: null,
      conversation: { kind: 'app', key: card.conversationKey, messagesPath: `/mobile/chat/app/${card.conversationKey}/messages`, sendPath: `/mobile/chat/app/${card.conversationKey}` } });
  });
});
