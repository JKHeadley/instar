// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for the Work Board (docs/specs/work-board-asks.md §4–§7).
 *
 * Boots the REAL AgentServer on the production init path: once with no runtime (the feature is
 * off: every route answers an honest 503), and once with a REAL WorkBoardRuntime over a real
 * CoherenceJournal, the real ReplicatedRecordEmitter and the real ReplicatedPeerStreamReader.
 * Then one card's whole life through the real routes: proposed by the agent, a tap refused for
 * the agent's token, approved with the PIN, handed to the agent, asked and answered, evidenced,
 * claimed, confirmed, reopened; a stale tap refused; and a restart (a fresh index from the
 * journal, across a rotation) that still shows the approval.
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
import { workCardJournalFiles } from '../../src/core/BackupManager.js';

const AUTH = 'test-e2e-work-board';
const PIN = '482913';
const tmpDirs: string[] = [];

function mkConfig(enabled: boolean): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-board-alive-e2e-')); tmpDirs.push(tmpDir);
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

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/work-board-alive.test.ts' }); });

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

describe('Work Board E2E (feature is alive)', () => {
  it('with the feature off every route answers an honest 503', async () => {
    const { config, stateDir } = mkConfig(false);
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    try {
      for (const [m, p] of [['get', '/work-board'], ['get', '/work-board/cards/wc_0123456789abcdef'], ['post', '/work-board/cards'], ['post', '/work-board/cards/wc_0123456789abcdef/tap'], ['post', '/work-board/settings']] as const) {
        const r = await (request(server.getApp()) as unknown as Record<string, (p: string) => request.Test>)[m](p).set(auth()).send({});
        expect(r.status, `${m} ${p}`).toBe(503);
        expect(r.body.error).toBe('work-board-disabled');
      }
    } finally { await server.stop(); }
  });

  it('a card proposed, approved, briefed, asked, evidenced, finished and reopened through the real routes', async () => {
    const { config, stateDir } = mkConfig(true);
    const rig = mkRuntime(stateDir);
    rig.runtime.start();
    const late = { ledgerNote: null, ownerPersonKey: null, displayName: null };
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), workBoard: () => rig.runtime, workBoardLate: late });
    await server.start();
    const app = server.getApp();
    try {
      expect((await request(app).get('/work-board')).status).toBe(401);

      // The agent proposes a card.
      const created = await request(app).post('/work-board/cards').set(auth()).send({ title: 'Pick a venue', need: 'Choose one of three venues for the retreat.', doneWhen: [{ id: 'd1', text: 'Venue booked' }], outward: false });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.cardId as string;
      expect(id).toMatch(/^wc_[0-9a-f]{16}$/);
      expect(created.body.card.status).toBe('needs-approval');
      expect(rig.conversations.has(created.body.conversationKey)).toBe(true);

      // It is in the owner's first lane, and nothing was handed over.
      const board = await request(app).get('/work-board').set(auth());
      expect(board.status).toBe(200);
      expect(board.body.lanes[0].lane).toBe('waiting-on-you');
      expect(board.body.lanes[0].cards.map((c: { id: string }) => c.id)).toEqual([id]);
      expect(board.body.waitingOnYou).toBe(1);
      await rig.runtime.controller.tick();
      expect(rig.briefs).toHaveLength(0);

      // The agent's token cannot tap; a wrong PIN cannot either.
      const hash = created.body.card.materialHash as string;
      const noPin = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'approve', materialHash: hash });
      expect(noPin.status).toBe(403); expect(noPin.body.error).toBe('person-required');
      const badPin = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'approve', materialHash: hash, pin: '000000' });
      expect(badPin.status).toBe(403);
      // The agent cannot write a tap or a pickup record through the records route.
      for (const kind of ['tap', 'dispatching', 'dispatched', 'policy']) {
        const r = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind, action: 'approve', materialHash: hash });
        expect(r.status, kind).toBe(400); expect(r.body.error).toBe('record-kind-not-allowed');
      }

      // A stale approval is refused; the current one starts the card.
      const stale = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'approve', materialHash: 'f'.repeat(64), titleHash: created.body.card.titleHash, pin: PIN });
      expect(stale.status).toBe(409); expect(stale.body.error).toBe('stale-card');
      const approved = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'approve', materialHash: hash, titleHash: created.body.card.titleHash, pin: PIN });
      expect(approved.status).toBe(200);
      expect(approved.body.card.approved).toBe(true);
      expect(rig.lines.some((l) => /^Work board: approved by .+ · /.test(l.text))).toBe(true);

      // The pickup hands a pointer brief to the session.
      await rig.runtime.controller.tick(); await rig.runtime.controller.tick();
      expect(rig.briefs).toHaveLength(1);
      expect(rig.briefs[0]).toContain(`GET /work-board/cards/${id}`);
      expect(rig.briefs[0]).not.toContain('Choose one of three venues');

      // Ask and answer.
      const asked = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'waiting-on', principal: { personKey: 'owner' }, question: { text: 'Which venue?', options: ['A', 'B'] } });
      expect(asked.status).toBe(200);
      const answered = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'answer', questionId: asked.body.questionId, answer: 'B', titleHash: created.body.card.titleHash, pin: PIN });
      expect(answered.status).toBe(200);
      await rig.runtime.controller.tick();
      expect(rig.briefs).toHaveLength(2);

      // A credential in evidence is refused at the door.
      const leaked = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'evidence', itemId: 'd1', text: 'key sk-ant-abcdefghijklmnop' });
      expect(leaked.status).toBe(422); expect(leaked.body.error).toBe('credential-refused');

      // Evidence, claim, confirm.
      const ev = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'evidence', itemId: 'd1', text: 'Booked venue B, confirmation 4471' });
      expect(ev.status).toBe(200);
      const claim = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'claimed-done' });
      expect(claim.status).toBe(200); expect(claim.body.needsConfirm).toBe(true);
      const card1 = await request(app).get(`/work-board/cards/${id}`).set(auth());
      expect(card1.body.card.status).toBe('claims-done');
      const confirmed = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'confirm-done', claimId: claim.body.claimId, materialHash: hash, titleHash: created.body.card.titleHash, pin: PIN });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.card.status).toBe('done');

      // The agent cannot unfinish it; the owner reopens it.
      const sneaky = await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'edited', need: 'Changed after the fact' });
      expect(sneaky.status).toBe(409); expect(sneaky.body.error).toBe('reopen-required');
      const reopened = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'reopen', claimId: claim.body.claimId, pin: PIN });
      expect(reopened.status).toBe(200);
      expect(reopened.body.card.status).not.toBe('done');

      // An unknown card does not exist.
      expect((await request(app).get('/work-board/cards/wc_ffffffffffffffff').set(auth())).status).toBe(404);

      // Settings: a preview needs no PIN; a change does; a mistyped name is refused.
      const preview = await request(app).post('/work-board/settings').set(auth()).send({ preview: true, policy: 'outward-only' });
      expect(preview.status).toBe(200); expect(typeof preview.body.wouldStart).toBe('number');
      expect((await request(app).post('/work-board/settings').set(auth()).send({ policy: 'outward-only' })).status).toBe(403);
      const typo = await request(app).post('/work-board/settings').set(auth()).send({ softOpenCard: 5, pin: PIN });
      expect(typo.status).toBe(400); expect(typo.body.field).toBe('softOpenCard');
      // A policy sent with one bad setting changes nothing at all.
      const mixed = await request(app).post('/work-board/settings').set(auth()).send({ policy: 'outward-only', softOpenCards: 0, pin: PIN });
      expect(mixed.status).toBe(400);
      expect((await request(app).get('/work-board').set(auth())).body.policy).toBe('every-agent-card');
      // A permitting tap must name the title the person saw.
      const noTitle = await request(app).post(`/work-board/cards/${id}/tap`).set(auth()).send({ action: 'approve', materialHash: hash, pin: PIN });
      expect(noTitle.status).toBe(400); expect(noTitle.body.error).toBe('title-hash-required');
      const pol = await request(app).post('/work-board/settings').set(auth()).send({ policy: 'outward-only', pin: PIN });
      expect(pol.status).toBe(200); expect(pol.body.policy).toBe('outward-only');

      // Graduation: readable, nothing due on day 0, and the agent cannot write a record through /records.
      const grad = await request(app).get('/work-board/graduation').set(auth());
      expect(grad.status).toBe(200); expect(grad.body.due).toEqual([]); expect(grad.body.current.decision).toBe('measured');
      const pass = await request(app).post('/work-board/graduation/pass').set(auth()).send({});
      expect(pass.status).toBe(200); expect(pass.body.written).toEqual([]);
      expect((await request(app).post(`/work-board/cards/${id}/records`).set(auth()).send({ kind: 'graduation', day: 7 })).status).toBe(400);

      // The capability index knows the board.
      const caps = await request(app).get('/capabilities').set(auth());
      expect(JSON.stringify(caps.body)).toContain('/work-board');

      // The journal file is what the backup would include.
      rig.journal.flush();
      expect(workCardJournalFiles(stateDir).some((f) => f.endsWith('.work-card-record.jsonl'))).toBe(true);
    } finally { rig.runtime.stop(); await server.stop(); rig.journal.close(); }
  });

  it('an approval that sits in a rotated archive still counts after a restart', async () => {
    const { stateDir } = mkConfig(true);
    const a = mkRuntime(stateDir, { rotateBytes: 1500 });
    a.runtime.start();
    const svc = a.runtime.svc;
    const owner = { kind: 'person' as const, personKey: 'owner', proof: 'pin' as const, isOwner: true };
    const c = svc.createCard({ kind: 'agent' }, { title: 'Rotation card', need: 'x'.repeat(600), doneWhen: [{ id: 'd1', text: 'done' }], outward: false });
    if (!c.ok) throw new Error('create');
    const tap = svc.tap(owner, c.cardId, { action: 'approve', materialHash: svc.view(c.cardId)!.card.materialHash });
    expect(tap.ok).toBe(true);
    // Push the approval into an archive with unrelated records.
    for (let i = 0; i < 12; i++) svc.createCard({ kind: 'agent' }, { title: `Filler ${i}`, need: 'y'.repeat(700), doneWhen: [{ id: 'd1', text: 'done' }], outward: false });
    a.journal.flush();
    a.runtime.stop(); a.journal.close();
    const archives = fs.readdirSync(path.join(stateDir, 'state', 'coherence-journal')).filter((n) => new RegExp(`\\.${WORK_CARD_RECORD_KIND}\\.\\d+\\.jsonl$`).test(n));
    expect(archives.length).toBeGreaterThan(0);

    const b = mkRuntime(stateDir, { rotateBytes: 1500 });
    b.runtime.start();
    try {
      const v = b.runtime.svc.view(c.cardId);
      expect(v).not.toBeNull();
      expect(v!.card.approvalValid).toBe(true);
      expect(b.runtime.svc.cardIds().length).toBe(13);
      // Live file and every archive are in the backup's list.
      const onDisk = fs.readdirSync(path.join(stateDir, 'state', 'coherence-journal')).filter((n) => n.includes(`.${WORK_CARD_RECORD_KIND}.`));
      expect(workCardJournalFiles(stateDir).length).toBe(onDisk.length);
      expect(onDisk.length).toBeGreaterThan(archives.length);
    } finally { b.runtime.stop(); b.journal.close(); }
  });
});

// The kind constant is a real journal kind (compile-time check).
const _kind: JournalKind = WORK_CARD_RECORD_KIND as JournalKind; void _kind;
