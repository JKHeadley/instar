// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for Work Board slice 3 (docs/specs/work-front-doors.md §6, decision 3).
 *
 * Boots the REAL AgentServer on the production init path with a REAL WorkBoardRuntime over a real
 * CoherenceJournal and the real replicated emitter/reader: with the board off the lessons read is an honest
 * 503; with it on, an agent card is closed "Not important" with the PIN, the reason is the agent's lesson and
 * rides its next create answer, a second card closed "Done" sits in the Done lane with its note and its
 * conversation line, every card names its turn and conversation, and a restart (a fresh index from the
 * journal) still shows both closes.
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
import { CoherenceJournal, type JournalKind } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { WORK_CARD_KIND_REGISTRATION, WORK_CARD_RECORD_KIND, WORK_BOARD_STORE_KEY, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { WorkBoardRuntime } from '../../src/core/WorkBoardRuntime.js';

const AUTH = 'test-e2e-work-board';
const PIN = '482913';
const tmpDirs: string[] = [];

function mkConfig(enabled: boolean): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-card-closeout-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 10000, version: '0.0.0',
    workBoard: { enabled },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/work-card-closeout-alive.test.ts' }); });

interface Rig { runtime: WorkBoardRuntime; journal: CoherenceJournal; lines: Array<{ key: string; id: string; text: string }>; briefs: string[]; conversations: Set<string>; removed: string[] }

function mkRuntime(stateDir: string, opts: { rotateBytes?: number } = {}): Rig {
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

describe('Work Board slice 3 E2E (feature is alive)', () => {
  it('with the board off the lessons read answers an honest 503', async () => {
    const { config, stateDir } = mkConfig(false);
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    try {
      const r = await request(server.getApp()).get('/work-board/lessons').set(auth());
      expect(r.status).toBe(503); expect(r.body.error).toBe('work-board-disabled');
    } finally { await server.stop(); }
  });

  it('Done and Not important through the real routes, the lessons, the turn and the conversation, across a restart', async () => {
    const { config, stateDir } = mkConfig(true);
    const rig = mkRuntime(stateDir);
    rig.runtime.start();
    const late = { ledgerNote: null, ownerPersonKey: null, displayName: null };
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig.runtime, workBoardLate: late });
    await server.start();
    const app = server.getApp();
    let first = ''; let second = '';
    try {
      const a = await request(app).post('/work-board/cards').set(auth()).send({ title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false });
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      first = a.body.cardId;
      expect(a.body.card).toMatchObject({ turn: 'you', started: false, conversation: { kind: 'app', key: a.body.conversationKey } });
      expect(a.body.lessons).toEqual([]);

      // The agent's token cannot close it; the PIN can, and only with a reason.
      expect((await request(app).post(`/work-board/cards/${first}/tap`).set(auth()).send({ action: 'archive', closeAs: 'not-important', note: 'no' })).status).toBe(403);
      const noReason = await request(app).post(`/work-board/cards/${first}/tap`).set(auth()).send({ action: 'archive', closeAs: 'not-important', pin: PIN });
      expect(noReason.status).toBe(400); expect(noReason.body.error).toBe('reason-required');
      const closed = await request(app).post(`/work-board/cards/${first}/tap`).set(auth()).send({ action: 'archive', closeAs: 'not-important', note: 'We already chose last week', pin: PIN });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(closed.body.card).toMatchObject({ lane: 'archived', turn: 'nobody', closeout: { as: 'not-important', note: 'We already chose last week' } });

      const lessons = await request(app).get('/work-board/lessons').set(auth());
      expect(lessons.status).toBe(200);
      expect(lessons.body.lessons.map((l: { reason: string; cardId: string }) => [l.reason, l.cardId])).toEqual([['We already chose last week', first]]);

      const b = await request(app).post('/work-board/cards').set(auth()).send({ title: 'Book catering', need: 'Order food', doneWhen: [{ id: 'd1', text: 'Ordered' }], outward: false });
      expect(b.status).toBe(201);
      second = b.body.cardId;
      expect(b.body.lessons.map((l: { reason: string }) => l.reason)).toEqual(['We already chose last week']);
      const done = await request(app).post(`/work-board/cards/${second}/tap`).set(auth()).send({ action: 'archive', closeAs: 'done', note: 'Ordered by phone', pin: PIN });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const board = await request(app).get('/work-board').set(auth());
      const doneLane = board.body.lanes.find((l: { lane: string }) => l.lane === 'done');
      expect(doneLane.cards.map((c: { id: string }) => c.id)).toEqual([second]);
      expect(rig.lines.some((l) => l.text.startsWith('Work board: Justin closed this as done: "Ordered by phone"'))).toBe(true);
    } finally { await server.stop(); rig.runtime.stop(); rig.journal.close(); }

    const again = mkRuntime(stateDir);
    again.runtime.start();
    try {
      expect(again.runtime.svc.view(first)!.card.closeout).toMatchObject({ as: 'not-important', note: 'We already chose last week' });
      expect(again.runtime.svc.view(second)!.card.closeout).toMatchObject({ as: 'done', note: 'Ordered by phone' });
      expect(again.runtime.svc.dismissalLessons().map((l) => l.cardId)).toEqual([first]);
    } finally { again.runtime.stop(); again.journal.close(); }
  });
});
const _kind: JournalKind = WORK_CARD_RECORD_KIND as JournalKind; void _kind;
