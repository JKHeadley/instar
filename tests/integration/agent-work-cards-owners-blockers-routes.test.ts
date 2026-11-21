/**
 * agent-work-cards-default, slice 2 — the HTTP pipeline for card owners (§8) and blocked-by links (§9) through a REAL
 * AgentServer: the asks operation (one idempotent step; retry; a differing body; the per-parent cap), the parent reading
 * `blocked` with the blocker's words, the owner's close of the ask handing the parent back with a brief that quotes the
 * close-out, blocker links and the cycle refusal through /records, a writer's `unblocked`, passes (owner PIN; the agent as
 * an ask only, never to itself; the visibility floor), the pass line, and a departed carrier through the team seam.
 * The Work Board runtime runs over an in-memory journal with a team seam attached before the server boots.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { workCardRecordStoreSchema, askCardId, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'awc2-int-token';
const PIN = '135791';
const tick = () => new Promise((r) => setTimeout(r, 15));
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const WORK = { title: 'Fix the venue list', need: 'Tidy it before Friday', doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false };
const ASK = { askKey: 'venue-address', title: 'Send me the venue address', need: 'I need the street address to finish the list', carrier: 'owner', recommendation: 'Reply with the address from the booking email.', whyYou: 'Only you have the booking.', doneWhen: [{ id: 'a1', text: 'Address sent' }] };

describe('card owners and blocked-by links over HTTP', () => {
  let project: TempProject; let server: AgentServer; let app: ReturnType<AgentServer['getApp']>; let rt: WorkBoardRuntime;
  const lines: string[] = []; const briefs: string[] = [];
  const members = new Set(['adriana', 'bob']);
  const reads = new Set<string>();

  beforeAll(async () => {
    project = createTempProject();
    const journal: UnionEntry[] = []; let clock = Date.parse('2026-11-21T20:00:00Z'); let logical = 0;
    const seams: WorkBoardRuntimeSeams = {
      machineId: 'm1', enabled: () => true, rawSettings: () => ({ maxOpenAsksPerCard: 2 }), saveSettings: () => true,
      emit: (_k, build) => { const hlc: HlcTimestamp = { physical: clock++, logical: logical++, node: 'm1' }; const data = build(hlc, 'm1'); if (!data) return { outcome: 'skipped' }; if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' }; journal.push({ data, origin: 'm1' }); return { outcome: 'emitted', seq: journal.length, hlc }; },
      awaitDurable: async () => {}, loadUnion: () => journal, journalBytes: () => 0,
      conversation: {
        create: () => {}, exists: () => true, appendSystemLine: (_ck, _id, text) => { lines.push(text); }, remove: () => {}, serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
        dispatchSystem: async (input) => { briefs.push(input.text); return { outcome: 'spawned' }; }, injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
      },
      relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'owner', displayName: (k) => ({ owner: 'Justin', adriana: 'Adriana', bob: 'Bob' } as Record<string, string>)[k] ?? k, timezone: () => 'UTC',
      detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => 'm1',
      team: { teamMember: (k) => (members.has(k) ? 'member' : 'not-a-member'), personMayRead: (k, ck) => reads.has(`${k}|${ck}`) },
    };
    rt = new WorkBoardRuntime(seams); rt.start();
    const config = {
      projectName: 'awc2', projectDir: project.projectDir, stateDir: project.stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, version: '0.0.0',
      workBoard: { enabled: true },
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: project.projectDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1 }, users: [], messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, workBoard: () => rt, workBoardLate: { ledgerNote: null, ownerPersonKey: null, displayName: null } });
    app = server.getApp();
  });
  afterAll(async () => { rt.stop(); await server.stop(); project.cleanup(); });

  async function approvedAgentCard(over: Record<string, unknown> = {}): Promise<{ id: string; conversationKey: string; titleHash: string }> {
    const r = await request(app).post('/work-board/cards').set(auth()).send({ ...WORK, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const tap = await request(app).post(`/work-board/cards/${r.body.cardId}/tap`).set(auth()).send({ pin: PIN, action: 'approve', materialHash: r.body.card.materialHash, titleHash: r.body.card.titleHash });
    expect(tap.status, JSON.stringify(tap.body)).toBe(200);
    return { id: r.body.cardId, conversationKey: r.body.conversationKey, titleHash: r.body.card.titleHash };
  }
  const card = async (id: string) => (await request(app).get(`/work-board/cards/${id}`).set(auth())).body.card;

  it('the asks operation creates the ask and the link in one step; a retry finds it; a differing body is refused; the cap is named; a PIN caller is refused', async () => {
    const parent = await approvedAgentCard();
    const r = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send(ASK);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.cardId).toBe(askCardId(parent.id, 'venue-address'));
    expect(r.body.existed).toBe(false); expect(r.body.blockedByRecordId).toMatch(new RegExp(`^wc:${parent.id}:bb:`));
    expect(r.body.card).toMatchObject({ status: 'with-person', lane: 'waiting-on-you', carrier: { personKey: 'owner' }, blocksLine: `Blocks: ${WORK.title}` });
    expect(r.body.parent).toMatchObject({ status: 'blocked', lane: 'with-agent', blocked: true, blockedWords: `Blocked by: ${ASK.title}`, needLine: `Blocked by: ${ASK.title}`, workable: false });
    // The board: the ask waits on the owner; the parent is with the agent, not in anyone's Waiting on you.
    const board = await request(app).get('/work-board').set(auth());
    const lane = (n: string) => board.body.lanes.find((l: { lane: string }) => l.lane === n).cards.map((c: { id: string }) => c.id);
    expect(lane('waiting-on-you')).toContain(r.body.cardId); expect(lane('with-agent')).toContain(parent.id); expect(lane('waiting-on-you')).not.toContain(parent.id);
    // Idempotent: the same body answers the same ids and writes nothing new.
    const before = rt.svc.recordsOf(parent.id).length;
    const again = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send(ASK);
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ cardId: r.body.cardId, blockedByRecordId: r.body.blockedByRecordId, existed: true });
    expect(rt.svc.recordsOf(parent.id).length).toBe(before);
    const differs = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, title: 'Another title' });
    expect(differs.status).toBe(409); expect(differs.body).toMatchObject({ error: 'ask-exists', cardId: r.body.cardId });
    // The cap (2 here), named with the limit.
    expect((await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, askKey: 'two', carrier: { personKey: 'adriana' } })).status).toBe(201);
    const capped = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, askKey: 'three' });
    expect(capped.status).toBe(429); expect(capped.body).toMatchObject({ error: 'too-many-open-asks', limit: 2 });
    // A person (PIN) does not raise asks; an unknown card is not found; the ask needs both fields.
    expect((await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, askKey: 'p', pin: PIN })).status).toBe(403);
    expect((await request(app).post('/work-board/cards/wc_0000000000000000/asks').set(auth()).send(ASK)).status).toBe(404);
    const noWhy = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, askKey: 'w', whyYou: '' });
    expect(noWhy.status).toBe(400); expect(noWhy.body.error).toBe('why-you-required');
  });

  it('closing the ask hands the parent back with a brief that quotes the close-out; the history carries the note for the agent', async () => {
    const parent = await approvedAgentCard({ title: 'Book the hall' });
    const r = await request(app).post(`/work-board/cards/${parent.id}/asks`).set(auth()).send({ ...ASK, askKey: 'hall' });
    expect(r.status).toBe(201);
    await rt.controller.tick(); briefs.length = 0;
    // The owner closes the ask as done from the console (the material hash is the ask's own).
    const ask = await card(r.body.cardId);
    const close = await request(app).post(`/work-board/cards/${r.body.cardId}/tap`).set(auth()).send({ pin: PIN, action: 'archive', closeAs: 'done', note: '1 Main Street, hall B', materialHash: ask.materialHash, titleHash: ask.titleHash });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    // The route reconciled at the transition: the parent is workable again with the link ended by the board.
    const p = await card(parent.id);
    expect(p).toMatchObject({ status: 'with-agent', blocked: false, workable: true, blockedWords: null });
    expect(p.blockerHistory).toEqual([expect.objectContaining({ cardId: r.body.cardId, title: ASK.title, reason: 'blocker-archived', closeAs: 'done', closeNote: '1 Main Street, hall B' })]);
    expect(rt.svc.recordsOf(parent.id).some((x) => x.d.recordType === 'unblocked' && x.d.reason === 'blocker-archived' && x.d.closedByPerson === true)).toBe(true);
    // The pickup fires from that record; the brief names what unblocked the card and quotes the owner's words.
    await rt.controller.tick(); await tick();
    const brief = briefs.find((b) => b.includes(`Work card ${parent.id}`) && b.includes('Unblocked:'));
    expect(brief, briefs.join('\n---\n')).toBeDefined();
    expect(brief).toContain(`blocked by "${ASK.title}"`); expect(brief).toContain('Justin closed it as done: "1 Main Street, hall B"');
  });

  it('blocker links through /records: a link, the cycle refusal, a writer\'s unblocked with its one reason; a person-PIN writer on their own card', async () => {
    const a = await approvedAgentCard({ title: 'A' }); const b = await approvedAgentCard({ title: 'B' });
    const link = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: b.id, note: 'B first' });
    expect(link.status, JSON.stringify(link.body)).toBe(201); expect(link.body.blockedByRecordId).toMatch(/^wc:/);
    expect((await card(a.id)).status).toBe('blocked'); expect((await card(b.id)).blocksLine).toBe('Blocks: A');
    const dup = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: b.id });
    expect(dup.status).toBe(200); expect(dup.body).toMatchObject({ blockedByRecordId: link.body.blockedByRecordId, duplicate: true });
    const cycle = await request(app).post(`/work-board/cards/${b.id}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: a.id });
    expect(cycle.status).toBe(409); expect(cycle.body.error).toBe('blocker-cycle');
    const badReason = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'unblocked', blockedByRecordId: link.body.blockedByRecordId, reason: 'blocker-done' });
    expect(badReason.status).toBe(400); expect(badReason.body.error).toBe('reason-not-allowed');
    const clear = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'unblocked', blockedByRecordId: link.body.blockedByRecordId });
    expect(clear.status, JSON.stringify(clear.body)).toBe(201);
    expect((await card(a.id))).toMatchObject({ status: 'with-agent', blocked: false });
    // The owner (PIN) links on any card; the unknown blocker is not found.
    const c = await approvedAgentCard({ title: 'C' });
    expect((await request(app).post(`/work-board/cards/${c.id}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: a.id, pin: PIN })).status).toBe(201);
    expect((await request(app).post(`/work-board/cards/${c.id}/records`).set(auth()).send({ kind: 'blocked-by', blockerCardId: 'wc_0000000000000000', pin: PIN })).status).toBe(404);
  });

  it('passes: the owner passes any card and the line says so; the agent never takes a card, passes only its own as an ask, and a pass never widens access', async () => {
    const a = await approvedAgentCard({ title: 'Pass me' });
    lines.length = 0;
    const toAdriana = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'adriana' }, pin: PIN });
    expect(toAdriana.status, JSON.stringify(toAdriana.body)).toBe(200); expect(toAdriana.body.changed).toEqual(['carrier']);
    expect(lines.some((l) => l.startsWith('Work board: passed to '))).toBe(true);
    let v = await card(a.id);
    expect(v).toMatchObject({ status: 'with-person', carrier: { personKey: 'adriana' }, lane: 'waiting-on-others' });
    expect(v.carrierTrail.map((t: { carrier: { personKey?: string } | string }) => (typeof t.carrier === 'string' ? t.carrier : t.carrier.personKey))).toEqual(['agent', 'adriana']);
    // The agent cannot take it back; a stranger cannot carry it; the owner can pass it to the agent.
    const take = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: 'agent' });
    expect(take.status).toBe(403); expect(take.body.error).toBe('agent-cannot-take-card');
    const stranger = await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'zed' }, pin: PIN });
    expect(stranger.status).toBe(400); expect(stranger.body.error).toBe('not-a-team-member');
    expect((await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: 'agent', pin: PIN })).status).toBe(200);
    // The agent passes a card it carries only as an ask, to someone who can see it.
    const b = await approvedAgentCard({ title: 'Agent passes' });
    const noAsk = await request(app).post(`/work-board/cards/${b.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'bob' } });
    expect(noAsk.status).toBe(400); expect(noAsk.body.error).toBe('recommendation-required');
    const cannotSee = await request(app).post(`/work-board/cards/${b.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'bob' }, recommendation: 'Take it', whyYou: 'It is yours' });
    expect(cannotSee.status).toBe(409); expect(cannotSee.body.error).toBe('new-carrier-cannot-see-card');
    reads.add(`bob|${b.conversationKey}`);
    const ok = await request(app).post(`/work-board/cards/${b.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'bob' }, recommendation: 'Take it', whyYou: 'It is yours' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    v = await card(b.id);
    expect(v).toMatchObject({ status: 'with-person', carrier: { personKey: 'bob' }, approvalRequired: false });
  });

  it('a carrier who leaves the team: the holder writes the record from the team seam, the card is the owner\'s with a Pass control, the line is left, and the owner\'s pass ends it', async () => {
    const a = await approvedAgentCard({ title: 'Departing' });
    expect((await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'bob' }, pin: PIN })).status).toBe(200);
    lines.length = 0;
    members.delete('bob');
    rt.onTeamRecordChanged();
    let v = await card(a.id);
    expect(v).toMatchObject({ status: 'carrier-departed', lane: 'waiting-on-you' }); expect(v.needLine).toContain('is no longer on the team; this card needs a new owner');
    expect(v.carrierDeparted).toMatchObject({ control: 'pass' });
    expect(lines.some((l) => l.endsWith('is no longer on the team; this card needs a new owner'))).toBe(true);
    const board = await request(app).get('/work-board').set(auth());
    expect(board.body.lanes.find((l: { lane: string }) => l.lane === 'waiting-on-you').cards.map((c: { id: string }) => c.id)).toContain(a.id);
    // Re-adding changes nothing; the owner's pass does.
    members.add('bob'); rt.onTeamRecordChanged();
    expect((await card(a.id)).status).toBe('carrier-departed');
    expect((await request(app).post(`/work-board/cards/${a.id}/records`).set(auth()).send({ kind: 'edited', carrier: { personKey: 'adriana' }, pin: PIN })).status).toBe(200);
    v = await card(a.id);
    expect(v.status).toBe('with-person'); expect(v.carrierDeparted).toBeNull();
  });
});
