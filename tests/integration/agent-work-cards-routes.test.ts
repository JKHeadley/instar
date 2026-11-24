/**
 * agent-work-cards-default, slice 1 — the HTTP pipeline: the request-to-card gate behind POST /commitments (the owner's
 * own sender-verified request is the yes; a member's request is not-started), the derived cardId in the response,
 * `?cardPending=1`, the notes route, deliver with an item, the /feedback source rule, the aggregated row's controls
 * (PIN), and DELETE /trust/requests/:id. The AgentServer is real; the Work Board runtime runs over an in-memory journal;
 * the gate's row lookups are fakes attached before the server boots (the server never overwrites an attached gate).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { workCardRecordStoreSchema, requestCardId, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { TelegramRow } from '../../src/core/WorkBoardRequestGate.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'awc-int-token';
const PIN = '246813';
const OWNER_TEXT = 'Please fix the venue list before Friday.';
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('agent work cards over HTTP', () => {
  let project: TempProject; let server: AgentServer; let app: ReturnType<AgentServer['getApp']>; let rt: WorkBoardRuntime; let tracker: CommitmentTracker;
  const telegramRows = new Map<string, TelegramRow>();
  const noteEvents = new Map<string, Array<{ eventId: string; text: string; at: string }>>();
  const withdrawn: string[] = [];
  const proposals: unknown[] = [];

  beforeAll(() => {
    project = createTempProject();
    const journal: UnionEntry[] = []; let clock = Date.parse('2026-11-20T20:00:00Z'); let logical = 0;
    const seams: WorkBoardRuntimeSeams = {
      machineId: 'm1', enabled: () => true, rawSettings: () => ({}), saveSettings: () => true,
      emit: (_k, build) => { const hlc: HlcTimestamp = { physical: clock++, logical: logical++, node: 'm1' }; const data = build(hlc, 'm1'); if (!data) return { outcome: 'skipped' }; if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' }; journal.push({ data, origin: 'm1' }); return { outcome: 'emitted', seq: journal.length, hlc }; },
      awaitDurable: async () => {}, loadUnion: () => journal, journalBytes: () => 0,
      conversation: {
        create: () => {}, exists: () => true, appendSystemLine: () => {}, remove: () => {}, serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
        dispatchSystem: async () => ({ outcome: 'spawned' }), injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
        appendNoteEvent: (ck, eventId, text) => { const l = noteEvents.get(ck) ?? []; l.push({ eventId, text, at: new Date().toISOString() }); noteEvents.set(ck, l); return 'appended'; },
        noteEvent: (ck, id) => { const e = noteEvents.get(ck)?.find((x) => x.eventId === id); return e ? { text: e.text, at: e.at } : null; },
        noteEventIds: (ck) => (noteEvents.get(ck) ?? []).map((e) => ({ eventId: e.eventId, at: e.at })),
        recordingSessionLive: () => true,
      },
      relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'owner', displayName: () => 'Justin', timezone: () => 'UTC',
      detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => 'm1',
    };
    rt = new WorkBoardRuntime(seams); rt.start();
    tracker = new CommitmentTracker({ stateDir: project.stateDir, originMachineId: 'm1' } as never);
    rt.attachRequestGate({
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
    const feedback = new FeedbackManager({ enabled: true, webhookUrl: 'https://example.invalid/feedback', feedbackFile: path.join(project.stateDir, 'feedback.json') } as never);
    const config = {
      projectName: 'awc', projectDir: project.projectDir, stateDir: project.stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, version: '0.0.0',
      workBoard: { enabled: true },
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: project.projectDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1 }, users: [], messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const trustAccountPath = {
      service: {
        withdraw: async (id: string) => { withdrawn.push(id); return id === 'tr-aaaaaaaaaaaa-GONE' ? { ok: false, reason: 'not-found' } : id === 'tr-aaaaaaaaaaaa-POLICY' ? { ok: false, reason: 'board-policy-not-withdrawable' } : { ok: true, status: 'withdrawn', cardTold: true }; },
      },
      store: { allRequests: () => [], sinkDescription: 'fake' },
      propose: async (change: unknown) => { proposals.push(change); return { status: 'sent', requestId: 'tr-bbbbbbbbbbbb-ABCD', code: 'ABCD', expiresAt: '2026-12-01T00:00:00Z' }; },
      bindDevices: () => {}, deviceListing: () => [],
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, commitmentTracker: tracker, feedback, workBoard: () => rt, workBoardLate: { ledgerNote: null, ownerPersonKey: null, displayName: null }, trustAccountPath: trustAccountPath as never });
    app = server.getApp();
  });
  afterAll(() => { project.cleanup(); });
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('asks for clearer commitment card copy before recording a second request', async () => {
    const draft = { type: 'one-time-action', userRequest: 'Finish PR 3596', agentResponse: 'You can see the updated venue list.', topicId: 42, source: 'agent', followThroughOptOutReason: 'tracked on the work board' };
    const refused = await request(app).post('/commitments').set(auth()).send(draft);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: 'card-text-needs-rewrite', field: 'userRequest' });
  });

  it('the owner\'s sender-verified request becomes a request-approved card by itself; the response carries the derived cardId; the card asks nothing', async () => {
    telegramRows.set('42:1001', { text: OWNER_TEXT, fromUser: true, forwarded: false, telegramUserId: 777 });
    const r = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'fix the venue list', agentResponse: 'I will tidy it today', topicId: 42, source: 'agent', sourceMessageId: '1001', externalKey: 'req:42:1001', followThroughOptOutReason: 'tracked on the work board' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const cardId = requestCardId('m1', r.body.id);
    expect(r.body).toMatchObject({ cardId, cardPending: true, sourceVerified: true, requesterIsOwner: true, requestText: OWNER_TEXT, sourceConversationKey: 'telegram:42' });
    await tick();
    const card = await request(app).get(`/work-board/cards/${cardId}`).set(auth());
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.card).toMatchObject({ status: 'with-agent', lane: 'with-agent', agentWork: true, pickupHeld: true, approved: true, need: OWNER_TEXT, requester: { isOwner: true } });
    expect(card.body.card.approvedBy.by.proof).toBe('their own request');
    expect(card.body.card.asked).toMatchObject({ need: OWNER_TEXT, needLocked: true, recordedInAgentWords: true, changedSinceAsked: false });
    expect(card.body.card.asked.agoWords).toMatch(/asked/);
    expect(card.body.card.refs).toEqual([{ kind: 'commitment', id: `m1:${r.body.id}` }]);
    const stored = tracker.get(r.body.id)!;
    expect(stored).toMatchObject({ cardId, cardWritten: true, cardPending: false });
    const pending = await request(app).get('/commitments?cardPending=1').set(auth());
    expect(pending.body.commitments).toEqual([]);
    const board = await request(app).get('/work-board').set(auth());
    expect(board.body.lanes.find((l: { lane: string }) => l.lane === 'waiting-on-you').cards).toEqual([]);
    expect(board.body.myBoard.sections.find((s: { reason: string }) => s.reason === 'approval').cardIds).toEqual([]);
    // the same request recorded again under its externalKey is one commitment and one card
    const again = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'fix the venue list', agentResponse: 'I will tidy it today', topicId: 42, source: 'agent', sourceMessageId: '1001', externalKey: 'req:42:1001', followThroughOptOutReason: 'tracked on the work board' });
    expect(again.body.id).toBe(r.body.id);
    await tick();
    expect(rt.svc.cardIds()).toHaveLength(1);
  });

  it('a member\'s request is an actual owner approval; its PIN control starts it; a chosen cardId is refused', async () => {
    telegramRows.set('42:2002', { text: 'Can you also sort the list?', fromUser: true, forwarded: false, telegramUserId: 888 });
    const r = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'sort the venue list', agentResponse: 'I will sort it', topicId: 42, source: 'agent', sourceMessageId: '2002', followThroughOptOutReason: 'tracked on the work board' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ sourceVerified: true, requesterIsOwner: false, requesterPersonKey: 'adriana' });
    await tick();
    const cardId = requestCardId('m1', r.body.id);
    const card = await request(app).get(`/work-board/cards/${cardId}`).set(auth());
    expect(card.body.card.status).toBe('not-started');
    expect(card.body.card.needLine).toBe('Needs your approval before the agent starts');
    const board = await request(app).get('/work-board').set(auth());
    expect(board.body.notStartedCards).toMatchObject({ count: 1, cardIds: [cardId], more: 0 });
    expect(board.body.notStartedCards.shown[0]).toMatchObject({ id: cardId, requester: { personKey: 'adriana', isOwner: false } });
    expect(board.body.lanes.find((l: { lane: string }) => l.lane === 'waiting-on-you').cards.map((c: { id: string }) => c.id)).toContain(cardId);
    // the agent's note and evidence are refused while it is not started
    const note = await request(app).post(`/work-board/cards/${cardId}/notes`).set(auth()).send({ text: 'starting' });
    expect(note.status).toBe(409); expect(note.body.error).toBe('not-started');
    const ev = await request(app).post(`/work-board/cards/${cardId}/records`).set(auth()).send({ kind: 'evidence', itemId: 'm1', text: 'done' });
    expect(ev.status).toBe(409); expect(ev.body.error).toBe('not-started');
    // the agent cannot approve; the owner's PIN on the aggregated control can
    const noPin = await request(app).post('/work-board/not-started/approve').set(auth()).send({ cards: [{ id: cardId, materialHash: card.body.card.materialHash, titleHash: card.body.card.titleHash }] });
    expect(noPin.status).toBe(403);
    const approved = await request(app).post('/work-board/not-started/approve').set(auth()).send({ pin: PIN, cards: [{ id: cardId, materialHash: card.body.card.materialHash, titleHash: card.body.card.titleHash }] });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.results[0]).toMatchObject({ id: cardId, approved: true });
    expect(approved.body.notStarted).toBe(0);
    const stale = await request(app).post('/work-board/not-started/approve').set(auth()).send({ pin: PIN, cards: [{ id: cardId, materialHash: 'f'.repeat(64), titleHash: card.body.card.titleHash }] });
    expect(stale.body.results[0].error).toBe('stale-card');
    expect((await request(app).get(`/work-board/cards/${cardId}`).set(auth())).body.card.status).toBe('with-agent');
    const chosen = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'x', agentResponse: 'y', topicId: 42, source: 'agent', cardId: 'wc_0123456789abcdef', followThroughOptOutReason: 'n/a' });
    expect(chosen.status).toBe(400); expect(chosen.body.error).toBe('card-id-not-accepted');
  });

  it('notes: a Bearer note lands in the card\'s conversation at once and shows as the last note; a long note names the limit; a person cannot write one here', async () => {
    const cardId = rt.svc.cardIds().find((id) => rt.svc.view(id)!.card.requestApproved)!;
    const n = await request(app).post(`/work-board/cards/${cardId}/notes`).set(auth()).send({ text: 'Started on the list' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const ck = rt.svc.view(cardId)!.card.conversationKey;
    expect(noteEvents.get(ck)![0].text).toBe('Work board: the agent noted: Started on the list');
    const card = await request(app).get(`/work-board/cards/${cardId}`).set(auth());
    expect(card.body.card.lastNote).toMatchObject({ text: 'Started on the list', eventId: n.body.eventId });
    const long = await request(app).post(`/work-board/cards/${cardId}/notes`).set(auth()).send({ text: 'x'.repeat(4001) });
    expect(long.status).toBe(413); expect(long.body.limit).toBe(4000);
    const pin = await request(app).post(`/work-board/cards/${cardId}/notes`).set(auth()).send({ pin: PIN, text: 'from the console' });
    expect(pin.status).toBe(403);
    await rt.controller.tick();
    expect(rt.svc.view(cardId)!.card.notes).toHaveLength(1);
  });

  it('deliver: without itemId a note only; with itemId and evidence the item is evidenced and the last one claims the card done', async () => {
    const owned = tracker.getAll().find((c) => c.requesterIsOwner)!;
    const cardId = requestCardId('m1', owned.id);
    // make the card workable for the write (lift its hold as the holder would)
    rt.svc.liftHold(cardId, 'quiet');
    const d = await request(app).post(`/commitments/${owned.id}/deliver`).set(auth()).send({ deliveryMessageId: '77', evidence: 'Tidied and sorted', itemId: 'm1' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.card).toMatchObject({ cardId, noted: true, evidenced: true, claimed: true });
    const card = await request(app).get(`/work-board/cards/${cardId}`).set(auth());
    expect(card.body.card.done).toBe(true);
    expect(card.body.card.closeoutLabel).toBe('closed by the agent on its own word');
    const tooLong = await request(app).post('/commitments/CMT-999/deliver').set(auth()).send({ evidence: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
  });

  it('/feedback requires a source when the board is on and refuses an operator conversation, naming the routes', async () => {
    const none = await request(app).post('/feedback').set(auth()).send({ type: 'bug', title: 'A real bug in the thing', description: 'When I do X the server answers Y instead of Z, every time, since the last update.' });
    expect(none.status).toBe(400); expect(none.body.error).toBe('source-required'); expect(none.body.routes.commitments).toContain('/commitments');
    const op = await request(app).post('/feedback').set(auth()).send({ type: 'feature', title: 'Justin asked for a thing', description: 'He wants the list sorted by date, with the newest first, in the app.', source: { kind: 'operator-conversation', conversationKey: 'telegram:42' } });
    expect(op.status).toBe(400); expect(op.body.error).toBe('operator-request-not-feedback');
    const ok = await request(app).post('/feedback').set(auth()).send({ type: 'bug', title: 'A real bug in the thing', description: 'When I do X the server answers Y instead of Z, every time, since the last update.', source: { kind: 'agent' } });
    expect([201, 422, 500]).toContain(ok.status); // past the source rule: the manager's own checks decide
    expect(ok.body.error).not.toBe('source-required');
  });

  it('DELETE /trust/requests/:id withdraws through the service and maps its refusals; approve-and-widen raises the board-policy request with the record', async () => {
    const ok = await request(app).delete('/trust/requests/tr-aaaaaaaaaaaa-ABCD').set(auth());
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('withdrawn'); expect(withdrawn).toContain('tr-aaaaaaaaaaaa-ABCD');
    expect((await request(app).delete('/trust/requests/tr-aaaaaaaaaaaa-GONE').set(auth())).status).toBe(404);
    expect((await request(app).delete('/trust/requests/tr-aaaaaaaaaaaa-POLICY').set(auth())).status).toBe(409);
    expect((await request(app).delete('/trust/requests/not-an-id').set(auth())).status).toBe(400);
    telegramRows.set('42:3003', { text: 'And archive the old ones', fromUser: true, forwarded: false, telegramUserId: 888 });
    const r = await request(app).post('/commitments').set(auth()).send({ type: 'one-time-action', userRequest: 'archive old venues', agentResponse: 'I will archive them', topicId: 42, source: 'agent', sourceMessageId: '3003', followThroughOptOutReason: 'tracked on the work board' });
    await tick();
    const cardId = requestCardId('m1', r.body.id);
    const c = await request(app).get(`/work-board/cards/${cardId}`).set(auth());
    const widen = await request(app).post('/work-board/not-started/approve-and-widen').set(auth()).send({ pin: PIN, cards: [{ id: cardId, materialHash: c.body.card.materialHash, titleHash: c.body.card.titleHash }] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    expect(widen.body.results[0]).toMatchObject({ approved: true });
    expect(widen.body.request.status).toBe('sent');
    expect(proposals).toEqual([{ kind: 'board-policy', policy: 'outward-only' }]);
    expect(widen.body.message).toContain('answer it in your chat or on your phone');
  });

  it('with the board off every new route answers 503, and /feedback no longer asks for a source', async () => {
    const off = { ...((server as unknown as { options?: unknown }).options ?? {}) };
    void off;
    const cfg = { projectName: 'awc-off', projectDir: project.projectDir, stateDir: project.stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, version: '0.0.0', workBoard: { enabled: false }, sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: project.projectDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] }, scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1 }, users: [], messaging: [], monitoring: {}, updates: {} } as unknown as InstarConfig;
    const feedback = new FeedbackManager({ enabled: true, webhookUrl: 'https://example.invalid/feedback', feedbackFile: path.join(project.stateDir, 'feedback-off.json') } as never);
    const s2 = new AgentServer({ config: cfg, sessionManager: createMockSessionManager() as never, state: project.state, feedback });
    const a2 = s2.getApp();
    for (const p of ['/work-board/cards/wc_0123456789abcdef/notes', '/work-board/not-started/approve', '/work-board/not-started/approve-and-widen']) {
      const r = await request(a2).post(p).set(auth()).send({});
      expect(r.status, p).toBe(503); expect(r.body.error).toBe('work-board-disabled');
    }
    const fb = await request(a2).post('/feedback').set(auth()).send({ type: 'bug', title: 'A real bug in the thing', description: 'When I do X the server answers Y instead of Z, every time, since the last update.' });
    expect(fb.body.error).not.toBe('source-required');
    expect(fs.existsSync(project.stateDir)).toBe(true);
  });
  it('keeps agent-internal work out of default board, Projects and Needs while retaining an explicit agent view', async () => {
    const before=await request(app).get('/work-board').set(auth());
    const created=await request(app).post('/work-board/cards').set(auth()).send({source:{conversationKey:'telegram:987654',messageId:'1'},title:'Keep the model registry current',need:'Keep the model registry current',carrier:'agent',outward:false,doneWhen:[{id:'d1',text:'Checked',certify:'agent-may-certify'}]});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const id=created.body.cardId;
    const card=await request(app).get('/work-board/cards/'+id).set(auth());
    expect(card.body.card).toMatchObject({agentInternal:true,conversationAvailable:false,status:'not-started',lane:'with-agent'});
    expect(card.body.card.needLine).not.toMatch(/your approval/);
    const board=await request(app).get('/work-board').set(auth());
    expect(board.body.ownerProjectionVersion).toBe(1);
    expect(board.body.waitingOnYou).toBe(before.body.waitingOnYou);
    expect(board.body.lanes.flatMap((l:any)=>l.cards).some((c:any)=>c.id===id)).toBe(false);
    const agents=await request(app).get('/mobile/work-board?view=agent').set(auth());
    expect(agents.status).toBe(200);
    expect(agents.body.view).toBe('agent');
    expect(agents.body.waitingOnYou).toBe(0);
    expect(agents.body.lanes.flatMap((l:any)=>l.cards).find((c:any)=>c.id===id)?.agentInternal).toBe(true);
    const projects=await request(app).get('/work/projects').set(auth());
    expect(JSON.stringify(projects.body)).not.toContain(id);
    const needs=await request(app).get('/needs?view=agent').set(auth());
    expect(needs.status).toBe(200);
    expect(JSON.stringify(needs.body)).not.toContain(id);
    expect(needs.body.items.some((n:any)=>n.id==='work:not-started'||n.key==='work:not-started')).toBe(false);
    expect((await request(app).get('/work-board?view=other').set(auth())).status).toBe(400);
    const source = await request(app).get('/work-board?sourceConversationKey=telegram%3A987654').set(auth());
    expect(source.status).toBe(200);
    expect(source.body.cards).toEqual([]);
    expect(source.body.total).toBe(0);
    const owner = {kind:'person',personKey:'owner',proof:'pin',isOwner:true} as const;
    expect(rt.svc.tap(owner,id,{action:'approve',materialHash:rt.svc.view(id)!.card.materialHash}).ok).toBe(true);
    const pickup = rt.svc.view(id)!.pickups.find(p=>p.status==='pending')!;
    expect(pickup).toBeTruthy();
    expect(rt.svc.writeSystem('dispatched',id,{for:pickup.cause.id,attempt:1,outcome:'parked',reason:'decision:test'}).ok).toBe(true);
    const ownerBoard = await request(app).get('/work-board').set(auth());
    const agentBoard = await request(app).get('/work-board?view=agent').set(auth());
    expect(agentBoard.body.pickups.parked).toBeGreaterThanOrEqual(1);
    expect(ownerBoard.body.pickups.parked).toBe(before.body.pickups.parked);

  });

});
