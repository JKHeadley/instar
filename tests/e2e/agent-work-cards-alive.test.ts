// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" for agent-work-cards-default, slice 1 (docs/specs/agent-work-cards-default.md).
 *
 * The REAL AgentServer on the production init path (`AgentServer.start()`), a REAL WorkBoardRuntime over a real
 * CoherenceJournal, the real ReplicatedRecordEmitter and peer-stream reader, a real CommitmentTracker, and the gate
 * attached with fake durable-row lookups. Then, over HTTP: an owner's commitment appears as a workable card in
 * GET /work-board (with the agent, never waiting on him) and under GET /work/projects; a note appears in the card's
 * conversation; a member's commitment under the strict policy appears in GET /needs as a genuine per-card approval and never
 * as an aggregate; a second boot over the same journal shows the same cards and writes the team's enabled-at once.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { WORK_CARD_KIND_REGISTRATION, WORK_BOARD_STORE_KEY, requestCardId, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { WorkBoardRuntime } from '../../src/core/WorkBoardRuntime.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import type { TelegramRow } from '../../src/core/WorkBoardRequestGate.js';

const AUTH = 'test-e2e-agent-work-cards';
const PIN = '482913';
const OWNER_TEXT = 'Please fix the venue list before Friday.';
const tmpDirs: string[] = [];
const tick = () => new Promise((r) => setTimeout(r, 20));

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-cards-alive-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 10000, version: '0.0.0',
    needsYou: { ownerAdmission: { enabled: false } },
    workBoard: { enabled: true }, developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/agent-work-cards-alive.test.ts' }); });

interface Rig { runtime: WorkBoardRuntime; tracker: CommitmentTracker; noteEvents: Map<string, Array<{ eventId: string; text: string; at: string }>>; telegramRows: Map<string, TelegramRow> }

function mkRig(stateDir: string, telegramRows: Map<string, TelegramRow>, noteEvents: Rig['noteEvents']): Rig {
  const reg = new ReplicatedKindRegistry(); reg.register(WORK_CARD_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir, machineId: 'm1', flushIntervalMs: 1_000_000 } as never);
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = Date.now() - 60_000; // near wall-clock: the holder's quiet rule reads Date.now()
  const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'm1', now: () => (t += 1000) }), registry: reg, origin: 'm1', stores: () => ({ [WORK_BOARD_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
  const streams = new ReplicatedPeerStreamReader({ stateDir, registry: reg, selfMachineId: 'm1', autoRebuild: false });
  const conversations = new Set<string>();
  const runtime = new WorkBoardRuntime({
    machineId: 'm1', enabled: () => true, rawSettings: () => ({}), saveSettings: () => true,
    emit: (k, b) => { const r = emitter.emit(WORK_BOARD_STORE_KEY, k, b); journal.flush(); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}), ...(r.hlc ? { hlc: r.hlc } : {}) }; },
    awaitDurable: async () => { journal.flush(); },
    loadUnion: () => {
      journal.flush();
      const out: UnionEntry[] = [];
      for (const byOrigin of streams.loadAllOriginRecords(WORK_BOARD_STORE_KEY).values()) for (const r of byOrigin) out.push({ data: { ...r.data, recordKey: r.envelope.recordKey, hlc: r.envelope.hlc, op: r.envelope.op, origin: r.origin }, origin: r.origin });
      return out;
    },
    journalBytes: () => 0,
    conversation: {
      create: (_id, key) => { conversations.add(key); }, exists: (key) => conversations.has(key), appendSystemLine: () => {}, remove: (key) => { conversations.delete(key); },
      serves: () => true, aliasFor: () => 7, hasLiveSession: () => false, dispatchSystem: async () => ({ outcome: 'spawned' }), injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
      appendNoteEvent: (ck, eventId, text) => { const l = noteEvents.get(ck) ?? []; l.push({ eventId, text, at: new Date().toISOString() }); noteEvents.set(ck, l); return 'appended'; },
      noteEvent: (ck, id) => { const e = noteEvents.get(ck)?.find((x) => x.eventId === id); return e ? { text: e.text, at: e.at } : null; },
      noteEventIds: (ck) => (noteEvents.get(ck) ?? []).map((e) => ({ eventId: e.eventId, at: e.at })),
      recordingSessionLive: () => true,
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'owner', displayName: () => 'Justin', timezone: () => 'America/Los_Angeles',
    detectCredential: (text) => (/sk-ant-[A-Za-z0-9]{10,}/.test(text) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => 'm1',
  });
  const tracker = new CommitmentTracker({ stateDir, originMachineId: 'm1' } as never);
  runtime.attachRequestGate({
    operatorConversation: (k) => (k.startsWith('telegram:') ? { ok: true, projectKey: null } : { ok: false }),
    telegramRow: (topic, mid) => ({ entry: telegramRows.get(`${topic}:${mid}`) ?? null }),
    deviceRecord: () => null, telegramOwnerId: () => 777, teamPersonForTelegramId: (id) => (id === 888 ? 'adriana' : null),
    commitments: {
      list: () => tracker.getAll().map((c) => ({ ...c, originMachineId: c.originMachineId ?? 'm1' })) as never,
      annotate: (id, patch) => { tracker.annotateCard(id, patch); },
      supersedeSentinels: (ck, ur, ar, by) => tracker.supersedeSentinelsFor(ck, ur, ar, by),
    },
    teamKey: () => 'owner',
  });
  return { runtime, tracker, noteEvents, telegramRows };
}

describe('Agent work cards E2E (feature is alive)', () => {
  it('an owner\'s request recorded over HTTP is a card with the agent, under the projects read, with a note in its conversation; a member\'s is one genuine approval; a second boot writes enabled-at once', async () => {
    const { config, stateDir } = mkConfig();
    const telegramRows = new Map<string, TelegramRow>();
    telegramRows.set('42:1001', { text: OWNER_TEXT, fromUser: true, forwarded: false, telegramUserId: 777 });
    telegramRows.set('42:2002', { text: 'Sort it too please', fromUser: true, forwarded: false, telegramUserId: 888 });
    const noteEvents: Rig['noteEvents'] = new Map();
    const rig = mkRig(stateDir, telegramRows, noteEvents);
    rig.runtime.start();
    const late = { ledgerNote: null, ownerPersonKey: null, displayName: null };
    let ready = true;
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => ready ? rig.runtime : null, workBoardLate: late, commitmentTracker: rig.tracker });
    await server.start();
    const app = server.getApp();
    try {
      // The owner's request becomes a card by itself.
      const r = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'fix the venue list', agentResponse: 'I will tidy it today', topicId: 42, source: 'agent', sourceMessageId: '1001', externalKey: 'e2e:42:1001', followThroughOptOutReason: 'tracked on the work board' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const ownerCard = requestCardId('m1', r.body.id);
      expect(r.body.cardId).toBe(ownerCard);
      await tick();
      const board = await request(app).get('/work-board').set(auth());
      expect(board.status).toBe(200);
      const withAgent = board.body.lanes.find((l: { lane: string }) => l.lane === 'with-agent').cards.map((c: { id: string }) => c.id);
      expect(withAgent).toContain(ownerCard);
      expect(board.body.lanes.find((l: { lane: string }) => l.lane === 'waiting-on-you').cards).toEqual([]);
      expect(board.body.waitingOnYou).toBe(0);
      const card = await request(app).get(`/work-board/cards/${ownerCard}`).set(auth());
      expect(card.body.card).toMatchObject({ status: 'with-agent', approved: true, agentWork: true, need: OWNER_TEXT });
      expect(card.body.card.asked).toMatchObject({ needLocked: true });
      // Under the projects read (no Chief of Staff here: the card lists apart from any project).
      const projects = await request(app).get('/work/projects').set(auth());
      expect(projects.status, JSON.stringify(projects.body)).toBe(200);
      expect(projects.body.notInProject.map((c: { id: string }) => c.id)).toContain(ownerCard);
      // A note lands in the card's conversation at once.
      const note = await request(app).post(`/work-board/cards/${ownerCard}/notes`).set(auth()).send({ text: 'Started on the list' });
      expect(note.status, JSON.stringify(note.body)).toBe(201);
      const ck = rig.runtime.svc.view(ownerCard)!.card.conversationKey;
      expect(noteEvents.get(ck)!.map((e) => e.text)).toEqual(['Work board: the agent noted: Started on the list']);
      // A verified member request really needs owner approval; internal work never creates an aggregate.
      const m = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'sort the venue list', agentResponse: 'I will sort it', topicId: 42, source: 'agent', sourceMessageId: '2002', followThroughOptOutReason: 'tracked on the work board' });
      expect(m.status).toBe(201);
      await tick();
      const memberCard = requestCardId('m1', m.body.id);
      expect((await request(app).get(`/work-board/cards/${memberCard}`).set(auth())).body.card.status).toBe('not-started');
      // The Needs-you list's work-board source is the console model over the board read (needsRoutes imports it); the
      // list itself self-reads every source over HTTP, which a port-0 test server cannot serve, so the derivation is
      // run here on the REAL board read exactly as needs-model.js does.
      const needs = await request(app).get('/needs').set(auth());
      expect(needs.status).toBe(200);
      const b2 = await request(app).get('/work-board').set(auth());
      expect(b2.body.notStartedCards).toMatchObject({ count: 1, cardIds: [memberCard] });
      const { workBoardNeedRows } = await import(pathToFileURL(path.join(process.cwd(), 'dashboard', 'console', 'work-model.js')).href) as { workBoardNeedRows: (wb: unknown) => Array<{ key: string; main: string }> | null };
      const rows = workBoardNeedRows({ ok: true, data: b2.body })!;
      expect(rows.map((r) => r.key)).toEqual(['work:'+memberCard]);
      expect(rows[0].main).toBe('sort the venue list');
      expect(rows.some((r) => r.key === 'work:not-started' || r.key === 'work:'+ownerCard)).toBe(false);
      // Production initialization binds the actual App store to the late-bound board runtime.
      expect(server.appConversations).not.toBeNull();
      const internal = rig.runtime.svc.createCard({ kind: 'agent' }, {
        title: 'Maintain the registry', need: 'Keep the registry current', carrier: 'agent', outward: false,
        doneWhen: [{ id: 'checked', text: 'Registry checked', certify: 'agent-may-certify' }],
      });
      expect(internal.ok).toBe(true);
      if (!internal.ok) throw Error(internal.error);
      const internalKey = rig.runtime.svc.view(internal.cardId)!.card.conversationKey;
      rig.runtime.ensureConversation(internal.cardId);
      expect(rig.runtime.conversationAvailable(internal.cardId)).toBe(false);
      // Simulate a durable empty chat left by the older eager-creation path, without deleting its history.
      const store = server.appConversations!.store;
      store.append({ eventId: 'old-internal-created', kind: 'created', conversationKey: internalKey,
        title: 'Maintain the registry', at: new Date().toISOString(), machineId: 'm1' });
      expect(store.isHiddenConversation(internalKey)).toBe(true);
      ready = false;
      expect(() => store.listConversations({ limit: 100 })).toThrow('work-card-visibility-unavailable');
      ready = true;
      expect(store.isHiddenConversation(internalKey)).toBe(true);
      expect(store.getConversation(internalKey)).not.toBeNull();
      expect(store.listConversations({ limit: 100 }).conversations.some(c => c.conversationKey === internalKey)).toBe(false);
      expect((await request(app).get('/work-board').set(auth())).body.lanes.flatMap((l: { cards: Array<{ id: string }> }) => l.cards).some((c: { id: string }) => c.id === internal.cardId)).toBe(false);
      const explicit = await request(app).get('/work-board?view=agent').set(auth());
      expect(explicit.status).toBe(200);
      expect(explicit.body.waitingOnYou).toBe(0);
      expect(explicit.body.lanes.flatMap((l: { cards: Array<{ id: string }> }) => l.cards).map((c: { id: string }) => c.id)).toEqual([internal.cardId]);
      // The holder's first pass wrote the team's enabled-at once.
      expect(rig.runtime.svc.enabledAt('owner')).not.toBeNull();
      const enabledAt = rig.runtime.svc.enabledAt('owner')!.at;
      await server.stop();
      // A second boot over the same journal: the same cards, the same enabled-at, no new backfill.
      const rig2 = mkRig(stateDir, telegramRows, noteEvents);
      rig2.runtime.start();
      const server2 = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig2.runtime, workBoardLate: late, commitmentTracker: rig2.tracker });
      await server2.start();
      try {
        await rig2.runtime.controller.tick();
        expect(rig2.runtime.svc.cardIds().sort()).toEqual([ownerCard, memberCard, internal.cardId].sort());
        expect(rig2.runtime.svc.enabledAt('owner')!.at).toBe(enabledAt);
        expect(rig2.runtime.gate!.needsCard()).toEqual([]);
        const b2 = await request(server2.getApp()).get('/work-board').set(auth());
        expect(b2.body.notStartedCards.count).toBe(1);
      } finally { await server2.stop(); }
    } finally { try { await server.stop(); } catch { /* stopped above */ } }
  });
});
