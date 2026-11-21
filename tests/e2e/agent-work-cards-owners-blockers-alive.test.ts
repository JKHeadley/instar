// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" for agent-work-cards-default, slice 2 (§8 card owners, §9 blocked-by links).
 *
 * The REAL AgentServer on the production init path (`AgentServer.start()`), a REAL WorkBoardRuntime over a real
 * CoherenceJournal, the real ReplicatedRecordEmitter and peer-stream reader, with a team seam attached before boot. Then,
 * over HTTP: the asks operation answers 201 (not 503/404) and the parent reads `blocked` in GET /work-board; the owner's
 * close of the ask (PIN) hands the parent back with the board's own `unblocked` record and a brief naming the close-out;
 * a pass leaves its line and moves the card to the member's lane; a second boot over the same journal rebuilds the
 * reverse index and every state from the replicated records alone.
 */
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
import { WORK_CARD_KIND_REGISTRATION, WORK_BOARD_STORE_KEY, askCardId, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { WorkBoardRuntime } from '../../src/core/WorkBoardRuntime.js';

const AUTH = 'test-e2e-awc-owners-blockers';
const PIN = '246810';
const tmpDirs: string[] = [];
const tick = () => new Promise((r) => setTimeout(r, 20));
const WORK = { title: 'Fix the venue list', need: 'Tidy it before Friday', doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false };
const ASK = { askKey: 'venue-address', title: 'Send me the venue address', need: 'I need the street address', carrier: 'owner', recommendation: 'Reply with the address from the booking email.', whyYou: 'Only you have the booking.', doneWhen: [{ id: 'a1', text: 'Address sent' }] };

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awc-owners-blockers-alive-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 10000, version: '0.0.0',
    workBoard: { enabled: true },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/agent-work-cards-owners-blockers-alive.test.ts' }); });

function mkRig(stateDir: string, members: Set<string>, lines: string[], briefs: string[]): { runtime: WorkBoardRuntime; journal: CoherenceJournal } {
  const reg = new ReplicatedKindRegistry(); reg.register(WORK_CARD_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir, machineId: 'm1', flushIntervalMs: 1_000_000 } as never);
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = Date.now() - 60_000;
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
      create: (_id, key) => { conversations.add(key); }, exists: (key) => conversations.has(key), appendSystemLine: (_ck, _id, text) => { lines.push(text); }, remove: (key) => { conversations.delete(key); },
      serves: () => true, aliasFor: () => 7, hasLiveSession: () => false, dispatchSystem: async (input) => { briefs.push(input.text); return { outcome: 'spawned' }; }, injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'owner', displayName: (k) => (k === 'owner' ? 'Justin' : k === 'adriana' ? 'Adriana' : k), timezone: () => 'America/Los_Angeles',
    detectCredential: (text) => (/sk-ant-[A-Za-z0-9]{10,}/.test(text) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => 'm1',
    team: { teamMember: (k) => (members.has(k) ? 'member' : 'not-a-member'), personMayRead: () => false },
  });
  return { runtime, journal };
}

describe('Card owners and blocked-by links E2E (feature is alive)', () => {
  it('an ask raised over HTTP blocks its parent; the owner\'s close hands it back with a brief; a pass moves it to a member; a second boot rebuilds it all from the journal', async () => {
    const { config, stateDir } = mkConfig();
    const members = new Set(['adriana']); const lines: string[] = []; const briefs: string[] = [];
    const made = mkRig(stateDir, members, lines, briefs); const rig = made.runtime;
    rig.start();
    const late = { ledgerNote: null, ownerPersonKey: null, displayName: null };
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig, workBoardLate: late });
    await server.start();
    const app = server.getApp();
    let parentId = ''; let askId = ''; let passedId = '';
    try {
      // An approved agent card (the strict policy: not-started until the owner's tap).
      const c = await request(app).post('/work-board/cards').set(auth()).send(WORK);
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      parentId = c.body.cardId;
      const approve = await request(app).post(`/work-board/cards/${parentId}/tap`).set(auth()).send({ pin: PIN, action: 'approve', materialHash: c.body.card.materialHash, titleHash: c.body.card.titleHash });
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);
      await rig.controller.tick(); briefs.length = 0;
      // The asks operation is alive: 201, one step, the parent blocked.
      const a = await request(app).post(`/work-board/cards/${parentId}/asks`).set(auth()).send(ASK);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      askId = a.body.cardId; expect(askId).toBe(askCardId(parentId, 'venue-address'));
      const board = await request(app).get('/work-board').set(auth());
      expect(board.status).toBe(200);
      const lane = (n: string) => board.body.lanes.find((l: { lane: string }) => l.lane === n).cards;
      expect(lane('with-agent').find((x: { id: string }) => x.id === parentId)).toMatchObject({ status: 'blocked', blockedWords: `Blocked by: ${ASK.title}` });
      expect(lane('waiting-on-you').find((x: { id: string }) => x.id === askId)).toMatchObject({ status: 'with-person', blocksLine: `Blocks: ${WORK.title}` });
      expect(board.body.waitingOnYou).toBe(1);
      // The owner closes the ask as done: the board writes `unblocked`, the parent is workable, the brief quotes the note.
      const askCard = (await request(app).get(`/work-board/cards/${askId}`).set(auth())).body.card;
      const close = await request(app).post(`/work-board/cards/${askId}/tap`).set(auth()).send({ pin: PIN, action: 'archive', closeAs: 'done', note: '1 Main Street', materialHash: askCard.materialHash, titleHash: askCard.titleHash });
      expect(close.status, JSON.stringify(close.body)).toBe(200);
      const parent = (await request(app).get(`/work-board/cards/${parentId}`).set(auth())).body.card;
      expect(parent).toMatchObject({ status: 'with-agent', blocked: false, workable: true });
      expect(parent.blockerHistory).toEqual([expect.objectContaining({ cardId: askId, reason: 'blocker-archived', closeAs: 'done', closeNote: '1 Main Street' })]);
      await rig.controller.tick(); await tick();
      const brief = briefs.find((b) => b.includes(`Work card ${parentId}`) && b.includes('Unblocked:'));
      expect(brief, briefs.join('\n---\n')).toBeDefined();
      expect(brief).toContain('Justin closed it as done: "1 Main Street"');
      // A pass (PIN) to a member leaves its line and moves the card to the member's lane.
      const p = await request(app).post('/work-board/cards').set(auth()).send({ ...WORK, title: 'Pass me' });
      passedId = p.body.cardId;
      const pass = await request(app).post(`/work-board/cards/${passedId}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'adriana' }, pin: PIN });
      expect(pass.status, JSON.stringify(pass.body)).toBe(200);
      expect(lines.some((l) => l.startsWith('Work board: passed to '))).toBe(true);
      expect((await request(app).get(`/work-board/cards/${passedId}`).set(auth())).body.card).toMatchObject({ status: 'with-person', lane: 'waiting-on-others', carrier: { personKey: 'adriana' } });
      // The agent cannot take it back over HTTP.
      expect((await request(app).post(`/work-board/cards/${passedId}/records`).set(auth()).send({ kind: 'edited', carrier: 'agent' })).status).toBe(403);
      await server.stop(); rig.stop(); made.journal.close();
      // A second boot over the same journal: every state folds back from the replicated records; the reverse index is rebuilt.
      const made2 = mkRig(stateDir, members, [], []); const rig2 = made2.runtime;
      rig2.start();
      const server2 = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig2, workBoardLate: late });
      await server2.start();
      try {
        const app2 = server2.getApp();
        const again = (await request(app2).get(`/work-board/cards/${parentId}`).set(auth())).body.card;
        expect(again).toMatchObject({ status: 'with-agent', blocked: false });
        expect(again.blockerHistory).toHaveLength(1);
        expect(rig2.svc.blocks(askId)).toEqual([]);
        expect((await request(app2).get(`/work-board/cards/${passedId}`).set(auth())).body.card).toMatchObject({ status: 'with-person', carrier: { personKey: 'adriana' } });
        // A new link after the boot: the rebuilt index answers at once.
        const other = await request(app2).post('/work-board/cards').set(auth()).send({ ...WORK, title: 'Other' });
        expect(other.status, JSON.stringify(other.body)).toBe(201);
        const link = await request(app2).post(`/work-board/cards/${parentId}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: other.body.cardId });
        expect(link.status, JSON.stringify(link.body)).toBe(201);
        expect(rig2.svc.blocks(other.body.cardId)).toEqual([parentId]);
        // Nothing re-replicated or lost: the departed-carrier reconciliation on this boot writes nothing for a member still on the team.
        rig2.onTeamRecordChanged();
        expect((await request(app2).get(`/work-board/cards/${passedId}`).set(auth())).body.card.carrierDeparted).toBeNull();
      } finally { await server2.stop(); rig2.stop(); made2.journal.close(); }
    } finally { try { await server.stop(); } catch { /* stopped above */ } rig.stop(); try { made.journal.close(); } catch { /* closed above */ } }
  });
});
