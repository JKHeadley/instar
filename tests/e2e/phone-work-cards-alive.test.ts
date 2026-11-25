// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for work cards from the owner's phone (docs/specs/phone-work-cards.md).
 *
 * Boots the REAL AgentServer on the production init path with a REAL WorkBoardRuntime over a real
 * CoherenceJournal, pairs an owner phone in the server's own MobilePairingService, and drives both routes
 * with real device and presence signatures: the phone opens one card (200, the board's card), makes a card
 * from a Telegram message with Face ID over `work-card-create` (201, `source` stored), and reads it back.
 * The bearer reaches the create's write gate and is refused for having no device signature (the route is
 * mounted and wired: an unwired dependency answers 503 work-board-disabled).
 */
import Database from 'better-sqlite3';
import { WorkBoardSlipStore } from '../../src/core/WorkBoardSlipStore.js';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { WORK_CARD_KIND_REGISTRATION, WORK_CARD_RECORD_KIND, WORK_BOARD_STORE_KEY, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { readWorkBoardApprovalEvent } from '../../src/core/workBoardApprovalReadback.js';
import { lineIdFor } from '../../src/core/WorkBoardService.js';
import { WorkBoardRuntime, workBoardHistoryFingerprint } from '../../src/core/WorkBoardRuntime.js';
import type { MobilePairingService } from '../../src/server/mobilePairingRoutes.js';
import { workBoardSlipApprovalLine } from '../../src/core/workBoardSlipPresence.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { phoneCardDraftHash, parsePhoneCardDraft } from '../../src/server/phoneWorkCards.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const AUTH = 'test-e2e-phone-work-cards';
const PIN = '482913';
const HOST = 'echo.example.dev';
const tmpDirs: string[] = [];

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-work-cards-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 10000, version: '0.0.0',
    workBoard: { enabled: true },
    mobilePairing: { enabled: true, permissionActions: { enabled: true }, multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/phone-work-cards-alive.test.ts' }); });

interface Rig { runtime: WorkBoardRuntime; journal: CoherenceJournal; lines: Array<{ key: string; id: string; text: string }>; briefs: string[]; conversations: Set<string>; removed: string[] }

function mkRuntime(stateDir: string, opts: { rotateBytes?: number; permissionSlips?: ConstructorParameters<typeof WorkBoardRuntime>[0]['permissionSlips']; onAwaitDurable?: (seq: number, journal: CoherenceJournal) => void } = {}): Rig {
  const reg = new ReplicatedKindRegistry(); reg.register(WORK_CARD_KIND_REGISTRATION);
  const journal = new CoherenceJournal({
    stateDir, machineId: 'm1', flushIntervalMs: 1_000_000,
    ...(opts.rotateBytes ? { retention: { [WORK_CARD_RECORD_KIND]: { maxFileBytes: opts.rotateBytes, rotateKeep: 0 } } } : {}),
  } as never);
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = Date.parse('2026-11-12T20:00:00Z');
  const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'm1', now: () => (t += 1000) }), registry: reg, origin: 'm1', stores: () => ({ [WORK_BOARD_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
  const streams = new ReplicatedPeerStreamReader({ stateDir, registry: reg, selfMachineId: 'm1', autoRebuild: false });
  const lines: Rig['lines'] = []; const briefs: string[] = []; const conversations = new Set<string>(); const removed: string[] = [];
  const runtime = new WorkBoardRuntime({
    machineId: 'm1', permissionSlips: opts.permissionSlips, enabled: () => true, rawSettings: () => ({}), saveSettings: () => true,
    emit: (k, b) => { const r = emitter.emit(WORK_BOARD_STORE_KEY, k, b); journal.flush(); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}), ...(r.hlc ? { hlc: r.hlc } : {}) }; },
    awaitDurable: async (seq) => { journal.flush(); opts.onAwaitDurable?.(seq, journal); },
    loadUnion: () => {
      journal.flush();
      const out: UnionEntry[] = [];
      for (const byOrigin of streams.loadAllOriginRecords(WORK_BOARD_STORE_KEY).values()) for (const r of byOrigin) out.push({ data: { ...r.data, recordKey: r.envelope.recordKey, hlc: r.envelope.hlc, op: r.envelope.op, origin: r.origin }, origin: r.origin });
      return out;
    },
    journalBytes: () => 0,
    conversation: {
      create: (_id, key) => { conversations.add(key); }, exists: (key) => conversations.has(key),
      appendSystemLine: (key, id, text) => { if (!lines.some((l) => l.id === id)) lines.push({ key, id, text }); },
      remove: (key) => { conversations.delete(key); removed.push(key); },
      serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
      dispatchSystem: async (input) => { briefs.push(input.text); return { outcome: 'spawned' }; },
      injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }),
    ownerPersonKey: () => 'owner', displayName: () => 'Justin', timezone: () => 'America/Los_Angeles',
    detectCredential: (text) => (/sk-ant-[A-Za-z0-9]{10,}/.test(text) ? 'anthropic-api-key' : null),
    ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => 'm1',
  });
  return { runtime, journal, lines, briefs, conversations, removed };
}


type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: Parameters<typeof request>[0], phone: Phone, method: 'POST' | 'GET', p: string, body?: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw));
  const r = method === 'POST' ? request(app).post(p).set('Content-Type', 'application/json') : request(app).get(p);
  r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return method === 'POST' ? r.send(raw.toString()) : r;
}

describe('Work cards from the owner phone E2E (feature is alive)', () => {
  it('fences a partially configured slip writer before it can issue or write', () => {
    const { stateDir } = mkConfig();
    const db = new Database(':memory:');
    const store = new WorkBoardSlipStore(db);
    const writer = { epoch: 'epoch1', ownerGeneration: 'owner1', ownerPersonKey: 'owner', writerIncarnation: 'i1' };
    const { runtime, journal } = mkRuntime(stateDir, { permissionSlips: { store, currentWriter: () => writer } });
    try {
      runtime.start();
      const created = runtime.svc.createCard({ kind: 'agent' }, {
        title: 'Cannot create', need: 'Await an enrolled writer', doneWhen: [{ id: 'done', text: 'Complete' }],
      });
      expect(created).toMatchObject({ ok: false, error: 'store-unavailable' });
      expect(runtime.readPermissionSlip('11111111-2222-4333-8444-555555555555').status).toBe(503);
      expect(journal.readKindComplete(WORK_CARD_RECORD_KIND).entries).toHaveLength(0);
    } finally { runtime.stop(); journal.close(); db.close(); }
  });

  it('refuses a pickup when an unexpected peer record arrives during the durability wait', async () => {
    const { stateDir } = mkConfig();
    const db = new Database(':memory:');
    const store = new WorkBoardSlipStore(db);
    const writer = { epoch: 'epoch1', ownerGeneration: 'owner1', ownerPersonKey: 'owner', writerIncarnation: 'i1' };
    let fenced = false;
    const rig: Rig = mkRuntime(stateDir, {
      permissionSlips: {
        store, currentWriter: () => writer,
        application: { readEvent: (id) => readWorkBoardApprovalEvent(id, {
          journal: rig.journal,
          epoch: { machineId: 'm1', journalIncarnation: rig.journal.getOwnAdvert()[WORK_CARD_RECORD_KIND].incarnation, baselineSequence: 0 },
          current: () => !fenced, hasReservation: () => false,
        }) },
      },
      onAwaitDurable: (seq, journal) => {
        const intent = journal.readKindComplete(WORK_CARD_RECORD_KIND).entries.find((row) => row.seq === seq);
        if (intent?.data.recordType !== 'dispatching') return;
        fenced = true;
        rig.runtime.onCommitted([{ machine: 'unexpected-peer', data: { ...intent.data, origin: 'unexpected-peer' } }], 'unexpected-peer');
      },
    });
    rig.runtime.start();
    try {
      const created = rig.runtime.svc.createCard({ kind: 'agent' }, {
        title: 'Test pickup fence', need: 'Check this card', doneWhen: [{ id: 'done', text: 'Checked' }], outward: true,
      });
      if (!created.ok) throw new Error('card');
      const { version } = rig.runtime.svc.approvalSnapshot(created.cardId)!;
      const result = await rig.runtime.svc.approveBound({ kind: 'person', personKey: 'owner', isOwner: true, proof: 'presence' },
        { proof: writer, version, source: 'slip', decisionId: 'fixture-decision' });
      if (result.status !== 'applied') throw new Error('approval');
      expect(rig.runtime.svc.projectBoundApproval(result.winner)).toBe(true);
      await rig.runtime.controller.tick();
      expect(fenced).toBe(true);
      expect(rig.briefs).toEqual([]);
    } finally { rig.runtime.stop(); rig.journal.close(); db.close(); }
  });

  it('reads an enrolled slip and its exact receipt through the signed owner-device route', async () => {
    const { config, stateDir } = mkConfig();
    delete config.dashboardPin;
    config.users = [{ id: 'owner', name: 'Owner', channels: [], permissions: [], preferences: {}, telegramUserId: 1001, orgRole: 'owner' }];
    const db = new Database(':memory:');
    const writer = { epoch: 'epoch1', ownerGeneration: 'owner1', ownerPersonKey: 'owner', writerIncarnation: 'i1' };
    let active = true;
    const store = new WorkBoardSlipStore(db);
    const sealed = {
      origin: 'old-peer',
      data: {
        origin: 'old-peer', recordKey: 'wb-policy:sealed-fixture', recordType: 'policy', policy: 'every-agent-card',
        hlc: { physical: 100, logical: 0, node: 'old-peer' }, op: 'put',
        at: '2026-11-12T20:00:00.000Z', by: { kind: 'person', personKey: 'owner', proof: 'pin' },
      },
    };
    let sourceCards: string[] = [];
    const telegram = {
      getOwnerUserId: () => 1001,
      getAllTopicMappings: () => [{ topicId: 4242 }],
      getTopicHistory: () => [],
      findTopicMessage: (topicId: number, messageId: number) => ({
        entry: topicId === 4242 && (messageId === 777 || messageId === 778) ? {
          topicId, messageId, telegramUserId: messageId === 777 ? 1001 : 1002,
          text: `Approve Work Board cards: ${sourceCards.join(', ')}`,
          fromUser: true, forwarded: false, provenance: 'user', authorship: 'human',
        } : null,
      }),
    };
    const rig: Rig = mkRuntime(stateDir, {
      permissionSlips: {
        store, currentWriter: () => active ? writer : null,
        sealedPeerHistory: new Set([workBoardHistoryFingerprint(sealed)]),
        application: {
          readEvent: (id) => readWorkBoardApprovalEvent(id, {
            journal: rig.journal,
            epoch: { machineId: 'm1', journalIncarnation: rig.journal.getOwnAdvert()[WORK_CARD_RECORD_KIND].incarnation, baselineSequence: 0 },
            current: () => active, hasReservation: () => false,
          }),
        },
      },
    });
    rig.runtime.start();
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig.runtime, telegram: telegram as never });
    await server.start();
    const app = server.getApp();
    try {
      const pairing = (server as unknown as { mobilePairing: MobilePairingService }).mobilePairing;
      const dev = makeDevice();
      const created = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
      if (!created.ok) throw new Error('pair');
      pairing.devices.applyConfirm(created.device.id, { ok: true });
      const phone: Phone = { dev, presence: makeDevice(), id: created.device.id };
      pairing.devices.setPresenceKey(phone.id, phone.presence.publicKey);
      const createdCard = rig.runtime.svc.createCard({ kind: 'agent' }, {
        title: 'Review the exact card', need: 'Check this before starting',
        doneWhen: [{ id: 'done', text: 'Checked', certify: 'agent-may-certify' }], outward: true,
      });
      if (!createdCard.ok) throw new Error('card');
      const { cardId } = createdCard;
      const { version, disclosure } = rig.runtime.svc.approvalSnapshot(cardId)!;
      const beforeLegacyTap = rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries.length;
      const legacy = rig.runtime.svc.tap({ kind: 'person', personKey: 'owner', proof: 'pin', isOwner: true }, cardId,
        { action: 'approve', materialHash: version.materialHash, titleHash: version.titleHash });
      expect(legacy).toMatchObject({ ok: false, error: 'bound-approval-required' });
      expect(rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries).toHaveLength(beforeLegacyTap);
      sourceCards = [cardId];
      const issue = (sourceRef: string) => request(app).post('/work-board/slips').set(auth()).send({ sourceRef });
      expect((await issue('telegram:4242:778')).status).toBe(409);
      expect((await issue('telegram:4242:779')).status).toBe(409);
      const issuance = await issue('telegram:4242:777');
      expect(issuance.status, JSON.stringify(issuance.body)).toBe(200);
      const issued = issuance.body;
      expect((await issue('telegram:4242:777')).body).toEqual(issued);
      sourceCards = [cardId, 'wc_8ef2f314f32acff4'];
      expect((await issue('telegram:4242:777')).status).toBe(409);
      sourceCards = [cardId];
      const slip = store.get(issued.slipId)!;
      expect(slip.proposal.items).toEqual([{ version, disclosure }]);
      const route = `/mobile/work-board/slips/${slip.id}`;
      const bearer = await request(app).get(route).set(auth());
      expect(bearer.status).toBe(403);
      const pending = await send(app, phone, 'GET', route);
      expect(pending.status, JSON.stringify(pending.body)).toBe(200);
      expect(pending.headers['cache-control']).toBe('no-store');
      expect(pending.body).toMatchObject({
        schemaVersion: 1, slipId: slip.id, disclosureDigest: slip.digest, state: 'pending',
        receipt: null, items: [{ cardId, version, disclosure, action: 'approve' }],
      });
      expect(JSON.stringify(pending.body)).not.toContain('telegram:4242:777');
      const challengeRoute = '/mobile/permissions/challenge';
      const challengeInput = { action: 'work-board-slip-approve', target: slip.id, disclosureDigest: slip.digest };
      const wrong = await send(app, phone, 'POST', challengeRoute, { ...challengeInput, disclosureDigest: 'f'.repeat(64) });
      expect(wrong.status).toBe(409);
      const challenge = await send(app, phone, 'POST', challengeRoute, challengeInput);
      expect(challenge.status, JSON.stringify(challenge.body)).toBe(200);
      expect(challenge.body.actionBindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(Date.parse(challenge.body.expiresAt)).toBeLessThanOrEqual(slip.expiresAt);
      const replacement = makeDevice();
      expect(pairing.devices.replacePresenceKey(phone.id, replacement.publicKey)).toBe('replaced');
      const updated = await send(app, phone, 'POST', challengeRoute, challengeInput);
      expect(updated.status).toBe(200);
      expect(updated.body.actionBindingDigest).not.toBe(challenge.body.actionBindingDigest);

      const submitRoute = `${route}/approve`;
      const bodyFor = (c: { challenge: string; actionBindingDigest: string }, key: typeof replacement) => {
        const line = workBoardSlipApprovalLine(slip.id, slip.digest, c.actionBindingDigest)!;
        return {
          challenge: c.challenge, disclosureDigest: slip.digest, actionBindingDigest: c.actionBindingDigest,
          presenceSig: key.sign(permissionPresenceMessage(phone.id, HOST, c.challenge, line)),
        };
      };
      expect((await send(app, phone, 'POST', submitRoute, bodyFor(challenge.body, phone.presence))).status).toBe(409);
      const submit = bodyFor(updated.body, replacement);
      expect((await send(app, phone, 'POST', submitRoute, { ...submit, presenceSig: 'invalid' })).status).toBe(401);
      expect(store.get(slip.id)?.decisionId).toBeNull();
      const committed = await send(app, phone, 'POST', submitRoute, submit);
      expect(committed.status, JSON.stringify(committed.body)).toBe(200);
      expect(committed.body).toMatchObject({ state: 'signed', receipt: { items: [{ cardId, status: 'applied' }] } });
      const retry = await send(app, phone, 'POST', submitRoute, submit);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(committed.body);
      const eventId = committed.body.receipt.items[0].eventId;
      const history = rig.lines.filter(({ id }) => id === lineIdFor(eventId));
      expect(history).toHaveLength(1);
      expect(history[0].key).toBe(createdCard.conversationKey);
      expect(history[0].text).toMatch(/approved/i);
      const records = rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries;
      expect(records.filter(({ data }) => data.approvalBinding)).toHaveLength(1);
      expect(rig.runtime.svc.view(cardId)?.card.approvedBy?.id).toBe(committed.body.receipt.items[0].eventId);

      const signed = await send(app, phone, 'GET', route);
      expect(signed.status).toBe(200);
      expect(signed.body).toMatchObject({ state: 'signed', receipt: { items: [{ cardId, status: 'applied' }] } });
      expect((await send(app, phone, 'POST', challengeRoute, challengeInput)).status).toBe(409);
      rig.runtime.svc.rebuild();
      const rebuilt = await send(app, phone, 'GET', route);
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({ state: 'signed', receipt: { items: [{ cardId, status: 'unresolved' }] } });
      rig.runtime.stop();
      rig.runtime.start();
      const recovered = await send(app, phone, 'GET', route);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(committed.body);
      expect(rig.runtime.svc.view(cardId)?.card.approvedBy?.id).toBe(eventId);
      expect(rig.lines.filter(({ id }) => id === lineIdFor(eventId))).toHaveLength(1);
      expect(rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries.filter(({ data }) => data.approvalBinding)).toHaveLength(1);
      expect(rig.runtime.svc.edit({ kind: 'agent' }, cardId, { title: 'Changed after approval' }).ok).toBe(true);
      expect((await issue('telegram:4242:777')).body).toEqual(issued);
      rig.runtime.stop();
      rig.runtime.start();
      const changed = await send(app, phone, 'GET', route);
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ state: 'signed', receipt: { items: [{ cardId, status: 'unresolved' }] } });
      expect(rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries.filter(({ data }) => data.approvalBinding)).toHaveLength(1);
      active = false;
      const beforeLostWriter = rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries.length;
      const refusedEdit = rig.runtime.svc.edit({ kind: 'agent' }, cardId, { title: 'Cannot write after authority loss' });
      expect(refusedEdit).toMatchObject({ ok: false, error: 'store-unavailable' });
      expect(rig.journal.readKindComplete(WORK_CARD_RECORD_KIND).entries).toHaveLength(beforeLostWriter);
      expect(rig.runtime.svc.view(cardId)?.card.title).toBe('Changed after approval');
      const unavailable = await send(app, phone, 'GET', route);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.items).toBeUndefined();
      active = true;
      rig.runtime.onCommitted([{ data: sealed.data, machine: sealed.origin }], sealed.origin);
      expect(rig.runtime.svc.policyRecords().some(({ id }) => id === sealed.data.recordKey)).toBe(true);
      expect((await send(app, phone, 'GET', route)).status).toBe(200);
      const oldPeerEdit = {
        origin: 'old-peer', recordKey: `wc:${cardId}:e:peer`, recordType: 'edited', cardId,
        hlc: { physical: Date.now(), logical: 0, node: 'old-peer' }, title: 'Unexpected peer change',
      };
      rig.runtime.onCommitted([{ data: oldPeerEdit, machine: 'old-peer' }], 'old-peer');
      expect(rig.runtime.svc.view(cardId)?.card.title).toBe('Changed after approval');
      expect((await send(app, phone, 'GET', route)).status).toBe(503);
      expect(rig.runtime.svc.edit({ kind: 'agent' }, cardId, { title: 'Cannot write after peer conflict' }))
        .toMatchObject({ ok: false, error: 'store-unavailable' });
    } finally { await server.stop(); rig.runtime.stop?.(); db.close(); }
  });

  it('the owner phone opens one card and makes a card from a message through the real server', async () => {
    const { config, stateDir } = mkConfig();
    const rig = mkRuntime(stateDir);
    rig.runtime.start();
    const late = { ledgerNote: null, ownerPersonKey: null, displayName: null };
    const telegram = { getAllTopicMappings: () => [{ topicId: 4242 }], getTopicHistory: () => [] };
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig.runtime, workBoardLate: late, telegram: telegram as never });
    await server.start();
    const app = server.getApp();
    try {
      const pairing = (server as unknown as { mobilePairing: MobilePairingService }).mobilePairing;
      const dev = makeDevice(); const presence = makeDevice();
      const created = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
      if (!created.ok) throw new Error('pair');
      pairing.devices.applyConfirm(created.device.id, { ok: true });
      pairing.devices.setPresenceKey(created.device.id, presence.publicKey);
      const owner: Phone = { dev, presence, id: created.device.id };

      // The bearer reaches the create's write gate (wired), and is refused for having no device signature.
      const b = await request(app).post('/mobile/work-board/cards').set(auth()).send({ requestId: 'aaaaaaaa-1111', pin: PIN });
      expect(b.status, JSON.stringify(b.body)).toBe(403); expect(b.body.error).toBe('device-signature-required');

      // An agent card: the phone opens it alone and gets the board's card.
      const agentCard = await request(app).post('/work-board/cards').set(auth()).send({ title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false, recommendation: 'Venue A: closest to everyone.', whyYou: 'Only you know who is coming.' });
      expect(agentCard.status).toBe(201);
      const one = await send(app, owner, 'GET', `/mobile/work-board/cards/${agentCard.body.cardId}`);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(one.body.card.id).toBe(agentCard.body.cardId);

      // Make a card from a Telegram message with Face ID.
      const body = { requestId: '6f1c2a40-0b1e-4c8e-9a51-3d2b7e9f0c11', title: 'Book the venue', need: 'Adriana asked us to book the venue.', doneWhen: [{ id: 'd1', text: 'Booked' }], source: { conversationKey: 'telegram:4242', messageId: '991' } };
      const parsed = parsePhoneCardDraft(body); if (!parsed.ok) throw new Error(parsed.error);
      const h = phoneCardDraftHash(parsed.draft);
      const pre = await send(app, owner, 'POST', '/mobile/work-board/cards', { ...body, preflight: true });
      expect(pre.status, JSON.stringify(pre.body)).toBe(200); expect(pre.body.draftHash).toBe(h);
      const ch = await send(app, owner, 'POST', '/mobile/permissions/challenge', { action: 'work-card-create', target: body.requestId, proposalHash: h });
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      const presenceSig = presence.sign(permissionPresenceMessage(owner.id, HOST, ch.body.challenge, `work-card-create ${body.requestId} ${h}`));
      const made = await send(app, owner, 'POST', '/mobile/work-board/cards', { ...body, challenge: ch.body.challenge, presenceSig });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body.card.source).toEqual(body.source);
      expect(rig.conversations.has(made.body.conversationKey)).toBe(true);
      const back = await send(app, owner, 'GET', `/mobile/work-board/cards/${made.body.cardId}`);
      expect(back.status).toBe(200); expect(back.body.card.title).toBe('Book the venue');
    } finally { await server.stop(); rig.runtime.stop?.(); }
  });
});
