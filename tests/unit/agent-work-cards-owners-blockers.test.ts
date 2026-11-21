/**
 * agent-work-cards-default (docs/specs/agent-work-cards-default.md), slice 2 — card owners across the team (§8) and
 * blocking links between cards (§9), at the store and the service.
 *
 * Both sides of every boundary the slice adds: the four new record kinds and who may write them; the team check on a
 * carrier (owner, member, stranger, unreadable record); who passes a card and who cannot (the agent never takes one);
 * the visibility floor on a pass; a member's taps (done as the current carrier, bound to the hash; an answer to their own
 * question; nothing else); the fold's view of a member's records; `blocked` as a non-waiting status and its lanes; the asks
 * operation (one idempotent step, caps, counts); blocker links (self, cycle, unreadable blocker, duplicate, episode); the
 * holder's reconciliation (done, archived, removed, cycle, reopen); the departed carrier; the reads' access rule; the
 * per-carrier soft budget; the pass line; the phone's signed `pass` line.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, transcriptLineFor, type WorkPrincipal, type TeamMembership } from '../../src/core/WorkBoardService.js';
import {
  workCardRecordStoreSchema, foldCard, toFoldRecords, deriveStatus, laneFor, derivePickupCauses, tapActionLine, askCardId, mintRecordKey,
  WORK_RECORD_TYPES, WAITING_STATUSES, UNBLOCK_REASONS, ASK_KEY_RE, isRecordId, type UnionEntry,
} from '../../src/core/WorkCardStore.js';
import { cardJson, boardJson, cardVisible, needLine, type Viewer } from '../../src/core/workBoardViews.js';
import { buildAction } from '../../src/server/mobilePermissionsRoutes.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const ADRIANA: WorkPrincipal = { kind: 'person', personKey: 'adriana', proof: 'presence', isOwner: false };
const BOB: WorkPrincipal = { kind: 'person', personKey: 'bob', proof: 'presence', isOwner: false };
const AGENT: WorkPrincipal = { kind: 'agent' };
const SESSION = (ck: string): WorkPrincipal => ({ kind: 'session', conversationKey: ck });

function makeService(over: Record<string, unknown> = {}, team: { members?: string[]; unavailable?: boolean; reads?: Array<[string, string]> } = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-21T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings(over);
  const members = new Set(team.members ?? ['adriana', 'bob']);
  const reads = new Set((team.reads ?? []).map(([k, ck]) => `${k}|${ck}`));
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => ({ justin: 'Justin', adriana: 'Adriana', bob: 'Bob' } as Record<string, string>)[k] ?? k,
    teamMember: (k): TeamMembership => (k === 'justin' ? 'owner' : team.unavailable ? 'unavailable' : members.has(k) ? 'member' : 'not-a-member'),
    personMayRead: (k, ck) => reads.has(`${k}|${ck}`),
  });
  svc.rebuild();
  return { svc, journal, members, reads, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const work = { title: 'Fix the venue list', need: 'Tidy it', doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false };
const ask = (over: Record<string, unknown> = {}) => ({ askKey: 'venue-address', title: 'Send me the venue address', need: 'I need the street address to finish the list', carrier: 'owner', recommendation: 'Reply with the address from the booking email.', whyYou: 'Only you have the booking.', doneWhen: [{ id: 'a1', text: 'Address sent' }], ...over });
const memberCard = (svc: WorkBoardService, who = 'adriana') => svc.createCard(OWNER, { ...work, carrier: { personKey: who }, outward: false });
const viewerOf = (key: string | null, isOwner = false): Viewer => ({ personKey: key, isOwner, isAgent: false });

describe('schema: the four new kinds (§8/§9)', () => {
  const ctx = { countDroppedField: () => {} } as never;
  const C = 'wc_0123456789abcdef'; const B = 'wc_fedcba9876543210';
  const base = { cardId: C, at: '2026-11-21T20:00:00.000Z' };
  const v = (r: Record<string, unknown>) => workCardRecordStoreSchema.validate({ ...base, ...r }, ctx);
  it('names them, and the unblock reasons', () => {
    for (const k of ['blocked-by', 'unblocked', 'blocker-reopened', 'carrier-departed']) expect(WORK_RECORD_TYPES).toContain(k);
    expect([...UNBLOCK_REASONS]).toEqual(['cleared', 'blocker-done', 'blocker-archived', 'blocker-removed', 'cycle']);
    expect(ASK_KEY_RE.test('venue-address')).toBe(true); expect(ASK_KEY_RE.test('has space')).toBe(false); expect(ASK_KEY_RE.test('x'.repeat(65))).toBe(false);
    expect(askCardId(C, 'k')).toMatch(/^wc_[0-9a-f]{16}$/); expect(askCardId(C, 'k')).toBe(askCardId(C, 'k')); expect(askCardId(C, 'k')).not.toBe(askCardId(B, 'k'));
  });
  it('blocked-by: a writer (never the system) names another card; self and a bad id are refused; the note is bounded', () => {
    expect(v({ recordType: 'blocked-by', by: { kind: 'agent' }, blockerCardId: B })).toMatchObject({ blockerCardId: B });
    expect(v({ recordType: 'blocked-by', by: { kind: 'person', personKey: 'adriana', proof: 'presence', isOwner: false }, blockerCardId: B, note: 'waiting on the address' })).toMatchObject({ note: 'waiting on the address' });
    expect(v({ recordType: 'blocked-by', by: { kind: 'system' }, blockerCardId: B })).toBeNull();
    expect(v({ recordType: 'blocked-by', by: { kind: 'agent' }, blockerCardId: C })).toBeNull();
    expect(v({ recordType: 'blocked-by', by: { kind: 'agent' }, blockerCardId: 'nope' })).toBeNull();
    expect(v({ recordType: 'blocked-by', by: { kind: 'agent' }, blockerCardId: B, note: '' })).toBeNull();
  });
  it('unblocked: binds to a link on THIS card; a writer says only cleared, the system never says cleared', () => {
    const link = `wc:${C}:bb:0011223344556677`;
    expect(v({ recordType: 'unblocked', by: { kind: 'agent' }, blockedByRecordId: link, reason: 'cleared' })).toMatchObject({ reason: 'cleared' });
    expect(v({ recordType: 'unblocked', by: { kind: 'system' }, blockedByRecordId: link, reason: 'blocker-done', closedByPerson: true })).toMatchObject({ reason: 'blocker-done', closedByPerson: true });
    expect(v({ recordType: 'unblocked', by: { kind: 'system' }, blockedByRecordId: link, reason: 'cleared' })).toBeNull();
    expect(v({ recordType: 'unblocked', by: { kind: 'agent' }, blockedByRecordId: link, reason: 'blocker-done' })).toBeNull();
    expect(v({ recordType: 'unblocked', by: { kind: 'agent' }, blockedByRecordId: `wc:${B}:bb:0011223344556677`, reason: 'cleared' })).toBeNull();
    expect(v({ recordType: 'unblocked', by: { kind: 'system' }, blockedByRecordId: link, reason: 'because' })).toBeNull();
    expect(v({ recordType: 'unblocked', by: { kind: 'system' }, blockedByRecordId: link, reason: 'cycle', closedByPerson: 'yes' })).toBeNull();
  });
  it('blocker-reopened and carrier-departed are the system\'s, each naming what it is keyed on', () => {
    expect(v({ recordType: 'blocker-reopened', by: { kind: 'system' }, blockerCardId: B, for: `wc:${B}:t:abc` })).toMatchObject({ blockerCardId: B });
    expect(v({ recordType: 'blocker-reopened', by: { kind: 'agent' }, blockerCardId: B, for: `wc:${B}:t:abc` })).toBeNull();
    expect(v({ recordType: 'blocker-reopened', by: { kind: 'system' }, blockerCardId: B })).toBeNull();
    expect(v({ recordType: 'carrier-departed', by: { kind: 'system' }, carrierEditRecordId: `wc:${C}:e:abc` })).toMatchObject({ carrierEditRecordId: `wc:${C}:e:abc` });
    expect(v({ recordType: 'carrier-departed', by: { kind: 'system' }, carrierEditRecordId: `wc:${B}:e:abc` })).toBeNull();
    expect(v({ recordType: 'carrier-departed', by: { kind: 'person', personKey: 'justin', proof: 'pin' }, carrierEditRecordId: `wc:${C}:e:abc` })).toBeNull();
  });
  it('the keys are derived so a repeat is one record: link per blocker and episode, unblock per link, departure per carrier edit', () => {
    expect(mintRecordKey('blocked-by', C, { blockerCardId: B, episode: 0 })).toBe(mintRecordKey('blocked-by', C, { blockerCardId: B, episode: 0 }));
    expect(mintRecordKey('blocked-by', C, { blockerCardId: B, episode: 0 })).not.toBe(mintRecordKey('blocked-by', C, { blockerCardId: B, episode: 1 }));
    const link = mintRecordKey('blocked-by', C, { blockerCardId: B, episode: 0 });
    expect(mintRecordKey('unblocked', C, { blockedByRecordId: link })).toBe(`wc:${C}:u:${link}`);
    expect(isRecordId(mintRecordKey('unblocked', C, { blockedByRecordId: link }))).toBe(true);
    expect(mintRecordKey('carrier-departed', C, { carrierEditRecordId: `wc:${C}:e:abc` })).toBe(`wc:${C}:cd:wc:${C}:e:abc`);
    expect(isRecordId(mintRecordKey('carrier-departed', C, { carrierEditRecordId: `wc:${C}:e:abc` }))).toBe(true);
  });
});

describe('carriers across the team (§8)', () => {
  it('any team member may carry a card; a stranger is refused by name; an unreadable team record changes nothing', () => {
    const t = makeService();
    expect(memberCard(t.svc, 'adriana').ok).toBe(true);
    expect(t.svc.createCard(OWNER, { ...work, carrier: { personKey: 'zed' } })).toMatchObject({ ok: false, status: 400, error: 'not-a-team-member' });
    const u = makeService({}, { unavailable: true });
    expect(u.svc.createCard(OWNER, { ...work, carrier: { personKey: 'adriana' } })).toMatchObject({ ok: false, status: 503, error: 'team-unavailable' });
    expect(u.svc.createCard(OWNER, { ...work, carrier: 'agent' }).ok).toBe(true); // the agent needs no team record
  });
  it('a member\'s card is in that member\'s Waiting on you and the owner\'s Waiting on others; the agent\'s brief lane rule is unchanged', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    const v = t.svc.view(r.cardId)!;
    expect(v.status).toBe('with-person');
    expect(t.svc.lane(v, { isOwner: false, personKey: 'adriana' })).toBe('waiting-on-you');
    expect(t.svc.lane(v, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-others');
    expect(t.svc.lane(v, { isOwner: false, personKey: 'bob' })).toBe('waiting-on-others');
    expect(t.svc.waitingOnPersonCount('adriana')).toBe(1); expect(t.svc.waitingOnOwnerCount()).toBe(0);
    // The owner's own card stays in the owner's Waiting on you.
    const o = t.svc.createCard(OWNER, { ...work, carrier: 'owner' }); if (!o.ok) throw new Error(o.error);
    expect(t.svc.lane(t.svc.view(o.cardId)!, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-you');
  });
  it('the owner or the current carrier passes a card; another member cannot; the agent passes only a card it carries, to a person, as an ask, and never to itself', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    // A card Bob cannot see does not exist for him, whatever he tries; once he may read it, the authority rule answers.
    expect(t.svc.edit(BOB, r.cardId, { carrier: { personKey: 'bob' } })).toMatchObject({ ok: false, status: 404, error: 'not-found' });
    t.reads.add(`bob|${r.conversationKey}`);
    expect(t.svc.edit(BOB, r.cardId, { carrier: { personKey: 'bob' } })).toMatchObject({ ok: false, status: 403, error: 'not-the-carrier' });
    t.reads.delete(`bob|${r.conversationKey}`);
    expect(t.svc.edit(ADRIANA, r.cardId, { title: 'Renamed' })).toMatchObject({ ok: false, status: 403, error: 'owner-required' });
    expect(t.svc.edit(ADRIANA, r.cardId, { carrier: { personKey: 'bob' }, title: 'Renamed' })).toMatchObject({ ok: false, status: 403, error: 'owner-required' });
    // Bob cannot see the card: a member's pass never widens access.
    expect(t.svc.edit(ADRIANA, r.cardId, { carrier: { personKey: 'bob' } })).toMatchObject({ ok: false, status: 409, error: 'new-carrier-cannot-see-card' });
    t.reads.add(`bob|${r.conversationKey}`);
    const p = t.svc.edit(ADRIANA, r.cardId, { carrier: { personKey: 'bob' } }); expect(p.ok).toBe(true);
    let v = t.svc.view(r.cardId)!;
    expect(v.card.carrier).toEqual({ personKey: 'bob' });
    expect(v.card.carrierTrail.map((c) => c.carrier)).toEqual([{ personKey: 'adriana' }, { personKey: 'bob' }]);
    expect(v.card.memberPassed).toBe(true);
    // A member's carrier write counts as agent-written for approval.
    expect(v.card.lastWriter.carrier).toBe('agent');
    // The agent cannot take it; a person passes it to the agent.
    expect(t.svc.edit(AGENT, r.cardId, { carrier: 'agent' })).toMatchObject({ ok: false, status: 403, error: 'agent-cannot-take-card' });
    expect(t.svc.edit(BOB, r.cardId, { carrier: 'agent' }).ok).toBe(true);
    v = t.svc.view(r.cardId)!;
    expect(v.card.carrier).toBe('agent');
    // Under the strict policy the card a member handed to the agent still needs the owner's Approve.
    expect(v.card.approvalRequired).toBe(true); expect(v.status).toBe('needs-approval'); expect(v.card.workable).toBe(false);
    // The agent passes a card it carries only as an ask (both fields), and to a team member it may name.
    const a = t.svc.createCard(AGENT, work); if (!a.ok) throw new Error(a.error);
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'adriana' } })).toMatchObject({ ok: false, error: 'recommendation-required' });
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'adriana' }, recommendation: 'Pick A' })).toMatchObject({ ok: false, error: 'why-you-required' });
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'zed' }, recommendation: 'Pick A', whyYou: 'Your call' })).toMatchObject({ ok: false, error: 'not-a-team-member' });
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'adriana' }, recommendation: 'Pick A', whyYou: 'Your call' })).toMatchObject({ ok: false, status: 409, error: 'new-carrier-cannot-see-card' });
    t.reads.add(`adriana|${a.conversationKey}`);
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'adriana' }, recommendation: 'Pick A', whyYou: 'Your call' }).ok).toBe(true);
    expect(t.svc.edit(AGENT, a.cardId, { carrier: { personKey: 'bob' }, recommendation: 'Pick A', whyYou: 'Your call' })).toMatchObject({ ok: false, error: 'not-the-carrier' });
    // The owner's pass needs no visibility floor (the owner's own grant shares the conversation from the phone).
    expect(t.svc.edit(OWNER, a.cardId, { carrier: { personKey: 'bob' } }).ok).toBe(true);
  });
  it('a request approval never covers a card a member passed, even back with the agent; the owner\'s pass to the agent restores nothing either way', () => {
    const t = makeService();
    const created = t.svc.createCard({ kind: 'agent', server: true }, { ...work, need: 'Please fix the venue list', source: { conversationKey: 'telegram:42', messageId: '1' }, requester: { personKey: 'justin', isOwner: true }, requestTextHash: 'a'.repeat(64), recordedAsHash: 'a'.repeat(64) }); if (!created.ok) throw new Error(created.error);
    expect(t.svc.view(created.cardId)!.card.requestApproved).toBe(true);
    t.reads.add(`adriana|${created.conversationKey}`);
    expect(t.svc.edit(OWNER, created.cardId, { carrier: { personKey: 'adriana' } }).ok).toBe(true);
    expect(t.svc.view(created.cardId)!.card.requestApproved).toBe(false);
    expect(t.svc.edit(ADRIANA, created.cardId, { carrier: 'agent' }).ok).toBe(true);
    const v = t.svc.view(created.cardId)!;
    expect(v.card.memberPassed).toBe(true); expect(v.card.requestApproved).toBe(false); expect(v.card.approvalValid).toBe(false);
  });
  it('a member\'s taps: done as the current carrier bound to the hash; an answer to their own question; nothing else', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    const v = t.svc.view(r.cardId)!;
    expect(t.svc.tap(ADRIANA, r.cardId, { action: 'approve', materialHash: v.card.materialHash })).toMatchObject({ ok: false, status: 403, error: 'owner-required' });
    expect(t.svc.tap(ADRIANA, r.cardId, { action: 'archive', closeAs: 'not-important', note: 'nah', materialHash: v.card.materialHash })).toMatchObject({ ok: false, status: 403, error: 'owner-required' });
    expect(t.svc.tap(BOB, r.cardId, { action: 'archive', closeAs: 'done', note: 'done it', materialHash: v.card.materialHash })).toMatchObject({ ok: false, status: 404, error: 'not-found' }); // Bob cannot see it
    t.reads.add(`bob|${r.conversationKey}`);
    expect(t.svc.tap(BOB, r.cardId, { action: 'archive', closeAs: 'done', note: 'done it', materialHash: v.card.materialHash })).toMatchObject({ ok: false, status: 403, error: 'not-the-carrier' });
    expect(t.svc.tap(ADRIANA, r.cardId, { action: 'archive', closeAs: 'done', note: 'done it', materialHash: 'b'.repeat(64) })).toMatchObject({ ok: false, status: 409, error: 'stale-card' });
    expect(t.svc.tap(ADRIANA, r.cardId, { action: 'archive', closeAs: 'done', note: 'Booked the hall', materialHash: v.card.materialHash }).ok).toBe(true);
    const after = t.svc.view(r.cardId)!;
    expect(after.status).toBe('archived'); expect(after.card.closeout).toMatchObject({ as: 'done', note: 'Booked the hall' });
    expect(t.svc.lane(after, { isOwner: true, personKey: 'justin' })).toBe('done');
    // A question addressed to a member is theirs to answer; someone else's is not.
    const q = t.svc.createCard(AGENT, { ...work, recommendation: 'Pick A', whyYou: 'Your call' }); if (!q.ok) throw new Error(q.error);
    const w = t.svc.setWaitingOn(AGENT, q.cardId, { principal: { personKey: 'adriana' }, question: { text: 'Which hall?' } });
    expect(w.ok).toBe(true); if (!w.ok) return;
    // The addressed member sees the card by that alone (no grant); another member does not; a stranger cannot be asked.
    expect(cardVisible(t.svc, t.svc.view(q.cardId)!, viewerOf('adriana'), null)).toBe(true);
    expect(cardVisible(t.svc, t.svc.view(q.cardId)!, viewerOf('bob'), null)).toBe(false);
    expect(t.svc.tap(BOB, q.cardId, { action: 'answer', questionId: w.questionId, answer: 'x' })).toMatchObject({ ok: false, status: 404, error: 'not-found' });
    expect(t.svc.setWaitingOn(AGENT, q.cardId, { principal: { personKey: 'zed' }, question: { text: 'Which?' }, supersedes: w.questionId, reason: 'r' })).toMatchObject({ ok: false, error: 'principal-not-allowed' });
    t.reads.add(`bob|${q.conversationKey}`);
    expect(t.svc.tap(BOB, q.cardId, { action: 'answer', questionId: w.questionId, answer: 'The big one' })).toMatchObject({ ok: false, status: 403, error: 'not-your-question' });
    expect(t.svc.tap(ADRIANA, q.cardId, { action: 'answer', questionId: w.questionId, answer: 'The big one' }).ok).toBe(true);
    expect(t.svc.view(q.cardId)!.card.questions[0]).toMatchObject({ state: 'answered', answeredBy: 'adriana' });
    expect(t.svc.lane(t.svc.view(q.cardId)!, { isOwner: false, personKey: 'adriana' })).not.toBe('waiting-on-you');
  });
  it('the fold is the authority: a member\'s done tap from another machine counts only as the carrier at that position with the hash; their other taps are nothing', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    const hash = t.svc.view(r.cardId)!.card.materialHash;
    const at = '2026-11-21T20:01:00.000Z';
    const by = { kind: 'person', personKey: 'bob', proof: 'presence', isOwner: false };
    const extra: UnionEntry[] = [
      { data: { recordType: 'tap', cardId: r.cardId, by, at, action: 'archive', closeAs: 'done', note: 'x', materialHash: hash, recordKey: `wc:${r.cardId}:t:aaaa`, hlc: { physical: t.now() + 1, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' },
      { data: { recordType: 'tap', cardId: r.cardId, by: { ...by, personKey: 'adriana' }, at, action: 'approve', materialHash: hash, recordKey: `wc:${r.cardId}:t:bbbb`, hlc: { physical: t.now() + 2, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' },
      { data: { recordType: 'tap', cardId: r.cardId, by: { ...by, personKey: 'adriana' }, at, action: 'archive', closeAs: 'done', note: 'stale', materialHash: 'c'.repeat(64), recordKey: `wc:${r.cardId}:t:cccc`, hlc: { physical: t.now() + 3, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' },
      { data: { recordType: 'edited', cardId: r.cardId, by: { ...by, personKey: 'adriana' }, at, title: 'renamed by a member', recordKey: `wc:${r.cardId}:e:dddd`, hlc: { physical: t.now() + 4, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' },
      // Bob is not the carrier: his pass record from another machine moves nothing; Adriana's does.
      { data: { recordType: 'edited', cardId: r.cardId, by, at, carrier: { personKey: 'bob' }, recordKey: `wc:${r.cardId}:e:eeee`, hlc: { physical: t.now() + 5, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' },
    ];
    let f = foldCard(r.cardId, toFoldRecords([...t.journal, ...extra]), []);
    expect(f.archives).toEqual([]); expect(f.closeout).toBeNull(); expect(f.approvalValid).toBe(false); expect(f.title).toBe(work.title);
    expect(f.taps).toHaveLength(3); // recorded, not counted
    expect(f.carrier).toEqual({ personKey: 'adriana' }); expect(f.carrierTrail).toHaveLength(1);
    f = foldCard(r.cardId, toFoldRecords([...t.journal, ...extra, { data: { recordType: 'edited', cardId: r.cardId, by: { ...by, personKey: 'adriana' }, at, carrier: { personKey: 'bob' }, recordKey: `wc:${r.cardId}:e:ffff`, hlc: { physical: t.now() + 6, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' }, origin: 'm_b' }]), []);
    expect(f.carrier).toEqual({ personKey: 'bob' }); expect(f.memberPassed).toBe(true); expect(f.lastWriter.carrier).toBe('agent');
  });
  it('a carrier who leaves the team: one record per carrier assignment, the owner\'s row with Pass, ended by the owner\'s pass; re-adding changes nothing; an unreadable record writes nothing', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    const keep = t.svc.createCard(OWNER, { ...work, carrier: { personKey: 'bob' } }); if (!keep.ok) throw new Error(keep.error);
    expect(t.svc.reconcileDepartedCarriers()).toEqual([]);
    t.members.delete('adriana');
    const d = t.svc.reconcileDepartedCarriers();
    expect(d).toHaveLength(1); expect(d[0]).toMatchObject({ cardId: r.cardId, personKey: 'adriana' });
    expect(t.svc.reconcileDepartedCarriers()).toEqual([]); // idempotent
    let v = t.svc.view(r.cardId)!;
    expect(v.status).toBe('carrier-departed'); expect(WAITING_STATUSES.has('carrier-departed')).toBe(true);
    expect(t.svc.lane(v, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-you');
    expect(t.svc.lane(v, { isOwner: false, personKey: 'adriana' })).toBe('waiting-on-others');
    expect(t.svc.view(keep.cardId)!.status).toBe('with-person');
    const json = cardJson(t.svc, v, viewerOf('justin', true), (k) => k);
    expect(json.carrierDeparted).toMatchObject({ control: 'pass' }); expect(json.needLine).toBe('adriana is no longer on the team; this card needs a new owner');
    // Re-adding the person hands nothing back.
    t.members.add('adriana');
    expect(t.svc.view(r.cardId)!.status).toBe('carrier-departed');
    // The owner's Pass is a newer carrier edit: the record no longer names the newest one, so the status ends by itself.
    expect(t.svc.edit(OWNER, r.cardId, { carrier: { personKey: 'bob' } }).ok).toBe(true);
    v = t.svc.view(r.cardId)!;
    expect(v.status).toBe('with-person'); expect(v.card.carrierDeparted).toBeNull();
    // A later departure of the new carrier is a new record.
    t.members.delete('bob');
    expect(t.svc.reconcileDepartedCarriers().map((x) => x.cardId).sort()).toEqual([r.cardId, keep.cardId].sort());
    const u = makeService({}, { unavailable: true });
    const uc = u.svc.createCard(OWNER, { ...work, carrier: 'owner' }); if (!uc.ok) throw new Error(uc.error);
    expect(u.svc.reconcileDepartedCarriers()).toEqual([]);
    // The departed line and the pass line.
    const rec = t.svc.recordsOf(r.cardId).find((x) => x.d.recordType === 'carrier-departed')!;
    expect(transcriptLineFor('carrier-departed', rec.d, { name: (k) => k, when: (iso) => iso, carrierName: 'Adriana' })).toBe('Work board: Adriana is no longer on the team; this card needs a new owner');
    const pass = t.svc.recordsOf(r.cardId).filter((x) => x.d.recordType === 'edited').pop()!;
    expect(transcriptLineFor('edited', pass.d, { name: (k) => ({ justin: 'Justin', bob: 'Bob' } as Record<string, string>)[k] ?? k, when: () => 'now', materialChanged: ['carrier'] })).toBe('Work board: passed to Bob by Justin · now');
  });
  it('who sees a card: the owner and the agent; the current carrier and the row-named requester while on the team; the conversation grant; nobody else', () => {
    const t = makeService();
    const r = memberCard(t.svc); if (!r.ok) throw new Error(r.error);
    const v = t.svc.view(r.cardId)!;
    expect(cardVisible(t.svc, v, viewerOf('justin', true), null)).toBe(true);
    expect(cardVisible(t.svc, v, { personKey: null, isOwner: false, isAgent: true }, null)).toBe(true);
    expect(cardVisible(t.svc, v, viewerOf('adriana'), null)).toBe(true); // carrier
    expect(cardVisible(t.svc, v, viewerOf('bob'), null)).toBe(false);
    expect(cardVisible(t.svc, v, viewerOf('bob'), (ck) => ck === v.card.conversationKey)).toBe(true); // the owner's grant
    t.members.delete('adriana');
    expect(cardVisible(t.svc, v, viewerOf('adriana'), null)).toBe(false); // departed: no longer sees it as carrier
    const req = t.svc.createCard({ kind: 'agent', server: true }, { ...work, source: { conversationKey: 'telegram:42', messageId: '9' }, requester: { personKey: 'bob', isOwner: false }, requestTextHash: 'a'.repeat(64) }); if (!req.ok) throw new Error(req.error);
    expect(cardVisible(t.svc, t.svc.view(req.cardId)!, viewerOf('bob'), null)).toBe(true); // requester
    expect(cardVisible(t.svc, t.svc.view(req.cardId)!, viewerOf('zed'), null)).toBe(false);
    // The board for a member lists only what they may see, in their own lanes.
    const board = boardJson(t.svc, viewerOf('bob'), () => false, (k) => k, { softOpenCards: 30 });
    const ids = (board.lanes as Array<{ cards: Array<{ id: string }> }>).flatMap((l) => l.cards.map((c) => c.id));
    expect(ids).toEqual([req.cardId]);
    expect(board.notStartedCards).toBeUndefined();
  });
  it('overSoftBudget is per carrier lane (measured after the write, as the owner\'s is)', () => {
    const t = makeService({ softOpenCards: 2 });
    const a = memberCard(t.svc); expect(a.ok && !a.overSoftBudget).toBe(true);
    const b = memberCard(t.svc); expect(b.ok && b.overSoftBudget).toMatchObject({ waiting: 2, softOpenCards: 2, personKey: 'adriana' });
    const c = memberCard(t.svc, 'bob'); expect(c.ok && !c.overSoftBudget).toBe(true);
    const o = t.svc.createCard(OWNER, { ...work, carrier: 'owner' }); expect(o.ok && !o.overSoftBudget).toBe(true);
  });
});

describe('blocking links between cards (§9)', () => {
  /** An agent card the owner approved (under the strict policy an unapproved agent card is `not-started`, which outranks `blocked`). */
  function approvedCard(t: ReturnType<typeof makeService>, over: Record<string, unknown> = {}) {
    const r = t.svc.createCard(AGENT, { ...work, ...over }); if (!r.ok) throw new Error(r.error);
    const tap = t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: t.svc.view(r.cardId)!.card.materialHash }); if (!tap.ok) throw new Error(tap.error);
    return r;
  }
  function pair(t: ReturnType<typeof makeService>) {
    const a = approvedCard(t);
    const b = approvedCard(t, { title: 'Get the address' });
    return { a: a.cardId, b: b.cardId, ack: a.conversationKey, bck: b.conversationKey };
  }
  it('a link makes the card blocked (not workable, not waiting, with-agent lane); self and cycles are refused; a duplicate open link is one record', () => {
    const t = makeService();
    const { a, b } = pair(t);
    expect(t.svc.addBlockedBy(AGENT, a, { blockerCardId: a })).toMatchObject({ ok: false, status: 409, error: 'blocker-cycle' });
    expect(t.svc.addBlockedBy(AGENT, a, { blockerCardId: 'wc_0000000000000000' })).toMatchObject({ ok: false, status: 404, error: 'not-found' });
    expect(t.svc.addBlockedBy(AGENT, a, {})).toMatchObject({ ok: false, status: 400, error: 'blocker-required' });
    const l = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b, note: 'need the address first' }); expect(l.ok).toBe(true); if (!l.ok) return;
    const again = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); expect(again).toMatchObject({ ok: true, blockedByRecordId: l.blockedByRecordId, duplicate: true });
    expect(t.svc.recordsOf(a).filter((r) => r.d.recordType === 'blocked-by')).toHaveLength(1);
    const v = t.svc.view(a)!;
    expect(v.card.blocked).toBe(true); expect(v.card.openBlockers).toEqual([b]); expect(v.card.workable).toBe(false);
    expect(v.status).toBe('blocked'); expect(WAITING_STATUSES.has('blocked')).toBe(false);
    expect(t.svc.lane(v, { isOwner: true, personKey: 'justin' })).toBe('with-agent');
    expect(t.svc.blocks(b)).toEqual([a]);
    // b ← a would close the loop; through c too.
    expect(t.svc.addBlockedBy(AGENT, b, { blockerCardId: a })).toMatchObject({ ok: false, error: 'blocker-cycle' });
    const c = t.svc.createCard(AGENT, { ...work, title: 'c' }); if (!c.ok) throw new Error(c.error);
    expect(t.svc.addBlockedBy(AGENT, b, { blockerCardId: c.cardId }).ok).toBe(true);
    expect(t.svc.addBlockedBy(AGENT, c.cardId, { blockerCardId: a })).toMatchObject({ ok: false, error: 'blocker-cycle' });
    // A note with a credential is refused; a note is bounded.
    expect(t.svc.addBlockedBy(AGENT, c.cardId, { blockerCardId: b, note: 'sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, error: 'blocker-cycle' }); // the cycle check comes first (c ← b ← c)
    const d = t.svc.createCard(AGENT, { ...work, title: 'd' }); if (!d.ok) throw new Error(d.error);
    expect(t.svc.addBlockedBy(AGENT, d.cardId, { blockerCardId: b, note: 'sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, status: 422, error: 'credential-refused' });
    expect(t.svc.addBlockedBy(AGENT, d.cardId, { blockerCardId: b, note: 'x'.repeat(4001) })).toMatchObject({ ok: false, status: 413, error: 'over-limit' });
  });
  it('write authority: the agent on a card it carries or wrote; the card\'s person carrier; the owner; a blocker the writer may not read is not-found', () => {
    const t = makeService();
    const mine = memberCard(t.svc); if (!mine.ok) throw new Error(mine.error);
    const other = t.svc.createCard(OWNER, { ...work, title: 'owner only' }); if (!other.ok) throw new Error(other.error);
    expect(t.svc.addBlockedBy(AGENT, mine.cardId, { blockerCardId: other.cardId })).toMatchObject({ ok: false, status: 403, error: 'not-the-carrier' }); // owner-written, member-carried: not the agent's
    expect(t.svc.addBlockedBy(BOB, mine.cardId, { blockerCardId: other.cardId })).toMatchObject({ ok: false, status: 404, error: 'not-found' }); // Bob cannot see Adriana's card: no existence oracle
    t.reads.add(`bob|${mine.conversationKey}`);
    expect(t.svc.addBlockedBy(BOB, mine.cardId, { blockerCardId: other.cardId })).toMatchObject({ ok: false, status: 403, error: 'not-the-carrier' });
    expect(t.svc.addBlockedBy(ADRIANA, mine.cardId, { blockerCardId: other.cardId })).toMatchObject({ ok: false, status: 404, error: 'not-found' }); // she may not read the owner's card
    t.reads.add(`adriana|${other.conversationKey}`);
    expect(t.svc.addBlockedBy(ADRIANA, mine.cardId, { blockerCardId: other.cardId }).ok).toBe(true);
    expect(t.svc.addBlockedBy(OWNER, other.cardId, { blockerCardId: mine.cardId })).toMatchObject({ ok: false, error: 'blocker-cycle' });
    const third = t.svc.createCard(OWNER, { ...work, title: 'third' }); if (!third.ok) throw new Error(third.error);
    expect(t.svc.addBlockedBy(OWNER, other.cardId, { blockerCardId: third.cardId }).ok).toBe(true);
    // A scoped session writes on its own card only.
    const { a, b } = pair(t);
    expect(t.svc.addBlockedBy(SESSION(t.svc.view(b)!.card.conversationKey), a, { blockerCardId: b })).toMatchObject({ ok: false, status: 404, error: 'not-found' });
    expect(t.svc.addBlockedBy(SESSION(t.svc.view(a)!.card.conversationKey), a, { blockerCardId: b }).ok).toBe(true);
  });
  it('a writer clears a link with reason cleared only; a cleared link is not open; a second episode is a new key', () => {
    const t = makeService();
    const { a, b } = pair(t);
    const l = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); if (!l.ok) throw new Error(l.error);
    expect(t.svc.clearBlockedBy(AGENT, a, { blockedByRecordId: l.blockedByRecordId, reason: 'blocker-done' })).toMatchObject({ ok: false, status: 400, error: 'reason-not-allowed' });
    expect(t.svc.clearBlockedBy(AGENT, a, { blockedByRecordId: `wc:${a}:bb:ffffffffffffffff` })).toMatchObject({ ok: false, status: 404, error: 'link-not-found' });
    expect(t.svc.clearBlockedBy(BOB, a, { blockedByRecordId: l.blockedByRecordId })).toMatchObject({ ok: false, status: 404, error: 'not-found' }); // Bob cannot see the agent's card
    t.reads.add(`bob|${t.svc.view(a)!.card.conversationKey}`);
    expect(t.svc.clearBlockedBy(BOB, a, { blockedByRecordId: l.blockedByRecordId })).toMatchObject({ ok: false, status: 403, error: 'not-the-carrier' });
    expect(t.svc.clearBlockedBy(AGENT, a, { blockedByRecordId: l.blockedByRecordId }).ok).toBe(true);
    expect(t.svc.clearBlockedBy(AGENT, a, { blockedByRecordId: l.blockedByRecordId })).toMatchObject({ ok: false, status: 409, error: 'link-not-open' });
    let v = t.svc.view(a)!;
    expect(v.card.blocked).toBe(false); expect(v.card.workable).toBe(true); expect(v.card.blockedBy[0].unblocked).toMatchObject({ reason: 'cleared' });
    expect(t.svc.blocks(b)).toEqual([]);
    const l2 = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); expect(l2.ok).toBe(true); if (!l2.ok) return;
    expect(l2.blockedByRecordId).not.toBe(l.blockedByRecordId);
    v = t.svc.view(a)!; expect(v.card.blocked).toBe(true); expect(v.card.blockedBy).toHaveLength(2);
    // The `cleared` is a work cause (the card re-entered workable) and is agent-caused when the agent cleared it.
    const causes = derivePickupCauses(a, t.svc.recordsOf(a), []);
    const unblock = causes.find((c) => c.unblocked);
    expect(unblock).toMatchObject({ kind: 'work', agentCaused: true, unblocked: { reason: 'cleared' } });
  });
  it('the holder reconciles: a finished blocker ends the link (closedByPerson follows the finishing record), an archived or removed one too; the card is handed back with the link named', () => {
    const t = makeService();
    const { a, b } = pair(t);
    const l = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); if (!l.ok) throw new Error(l.error);
    expect(t.svc.reconcileBlockers()).toEqual({ unblocked: [], reopened: [] });
    // The blocker finishes on the agent's own evidence (approve it first; the item is agent-may-certify).
    const bv = t.svc.view(b)!;
    expect(t.svc.tap(OWNER, b, { action: 'approve', materialHash: bv.card.materialHash }).ok).toBe(true);
    expect(t.svc.addEvidence(AGENT, b, { itemId: 'd1', text: 'Address: 1 Main St' }).ok).toBe(true);
    expect(t.svc.claimDone(AGENT, b).ok).toBe(true);
    expect(t.svc.view(b)!.card.done).toBe(true);
    expect(t.svc.view(a)!.card.blocked).toBe(true); // nothing until the holder reconciles
    const r = t.svc.reconcileBlockers();
    expect(r.unblocked).toEqual([{ cardId: a, recordId: `wc:${a}:u:${l.blockedByRecordId}`, blockerCardId: b, reason: 'blocker-done' }]);
    expect(t.svc.reconcileBlockers()).toEqual({ unblocked: [], reopened: [] }); // idempotent
    const v = t.svc.view(a)!;
    expect(v.card.blocked).toBe(false); expect(v.card.blockedBy[0].unblocked).toMatchObject({ reason: 'blocker-done', closedByPerson: false });
    const cause = derivePickupCauses(a, t.svc.recordsOf(a), []).find((c) => c.unblocked)!;
    expect(cause).toMatchObject({ kind: 'work', agentCaused: true, unblocked: { linkId: l.blockedByRecordId, reason: 'blocker-done' } });
    // A person's close of a blocker (owner-carried ask closed as done) is a person's cause.
    const c = approvedCard(t, { title: 'c' });
    const askc = t.svc.createCard(AGENT, { ...work, title: 'ask', carrier: 'owner', recommendation: 'r', whyYou: 'w', doneWhen: [{ id: 'x', text: 'y' }] }); if (!askc.ok) throw new Error(askc.error);
    const lc = t.svc.addBlockedBy(AGENT, c.cardId, { blockerCardId: askc.cardId }); if (!lc.ok) throw new Error(lc.error);
    expect(t.svc.tap(OWNER, askc.cardId, { action: 'archive', closeAs: 'not-important', note: 'We do not need this' }).ok).toBe(true);
    expect(t.svc.reconcileBlockers().unblocked).toEqual([{ cardId: c.cardId, recordId: `wc:${c.cardId}:u:${lc.blockedByRecordId}`, blockerCardId: askc.cardId, reason: 'blocker-archived' }]);
    const cc = derivePickupCauses(c.cardId, t.svc.recordsOf(c.cardId), []).find((x) => x.unblocked)!;
    expect(cc.agentCaused).toBe(false);
    // A removed blocker.
    const d = approvedCard(t, { title: 'd' });
    const e = approvedCard(t, { title: 'e' });
    expect(t.svc.addBlockedBy(AGENT, d.cardId, { blockerCardId: e.cardId }).ok).toBe(true);
    expect(t.svc.tap(OWNER, e.cardId, { action: 'redact' }).ok).toBe(true);
    expect(t.svc.reconcileBlockers().unblocked.map((u) => u.reason)).toEqual(['blocker-removed']);
    expect(t.svc.view(d.cardId)!.card.workable).toBe(true);
  });
  it('a cycle closed by concurrent writes ends at the later link; a reopened blocker writes one blocker-reopened per reopen and re-blocks nothing', () => {
    const t = makeService();
    const { a, b } = pair(t);
    const l1 = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); if (!l1.ok) throw new Error(l1.error);
    // Another machine wrote b ← a without seeing a ← b.
    const data = { recordType: 'blocked-by', cardId: b, blockerCardId: a, by: { kind: 'agent' }, at: '2026-11-21T20:00:01.000Z', recordKey: `wc:${b}:bb:1111111111111111`, hlc: { physical: t.now() + 5, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b' };
    t.svc.apply([{ data, origin: 'm_b' }]);
    expect(t.svc.view(b)!.card.blocked).toBe(true);
    const r = t.svc.reconcileBlockers();
    expect(r.unblocked).toEqual([{ cardId: b, recordId: `wc:${b}:u:wc:${b}:bb:1111111111111111`, blockerCardId: a, reason: 'cycle' }]);
    expect(t.svc.view(b)!.card.blocked).toBe(false); expect(t.svc.view(a)!.card.blocked).toBe(true);
    // Finish b, reconcile, then reopen it: a stays workable, with one record telling the agent.
    const bv = t.svc.view(b)!;
    expect(t.svc.tap(OWNER, b, { action: 'approve', materialHash: bv.card.materialHash }).ok).toBe(true);
    expect(t.svc.addEvidence(AGENT, b, { itemId: 'd1', text: 'ok' }).ok).toBe(true);
    const claim = t.svc.claimDone(AGENT, b); if (!claim.ok) throw new Error(claim.error);
    expect(t.svc.reconcileBlockers().unblocked.map((u) => u.reason)).toEqual(['blocker-done']);
    expect(t.svc.tap(OWNER, b, { action: 'reopen', claimId: claim.claimId }).ok).toBe(true);
    expect(t.svc.view(b)!.card.done).toBe(false);
    const r2 = t.svc.reconcileBlockers();
    expect(r2.reopened).toEqual([{ cardId: a, recordId: expect.stringMatching(new RegExp(`^wc:${a}:br:[0-9a-f]{16}$`)), blockerCardId: b }]);
    expect(t.svc.reconcileBlockers()).toEqual({ unblocked: [], reopened: [] });
    const v = t.svc.view(a)!;
    expect(v.card.blocked).toBe(false); expect(v.card.workable).toBe(true); expect(v.card.blockerReopened).toHaveLength(1);
    const json = cardJson(t.svc, v, { personKey: null, isOwner: false, isAgent: true }, (k) => k);
    expect((json.blockerReopened as Array<{ words: string }>)[0].words).toContain('was reopened; nothing is blocked again');
  });
  it('the asks operation: one idempotent step, the carrier a team person, both ask fields, counted and capped', () => {
    const t = makeService({ maxOpenAsksPerCard: 2, maxAgentCardsPerDay: 4 });
    const parent = approvedCard(t);
    expect(t.svc.createAsk(OWNER, parent.cardId, ask())).toMatchObject({ ok: false, status: 403, error: 'agent-only' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ askKey: 'has space' }))).toMatchObject({ ok: false, error: 'ask-key-required' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ carrier: 'agent' }))).toMatchObject({ ok: false, error: 'ask-carrier-must-be-person' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ carrier: { personKey: 'zed' } }))).toMatchObject({ ok: false, error: 'not-a-team-member' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ recommendation: '' }))).toMatchObject({ ok: false, error: 'recommendation-required' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ whyYou: undefined }))).toMatchObject({ ok: false, error: 'why-you-required' });
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ doneWhen: [] }))).toMatchObject({ ok: false, error: 'done-item-required' });
    const r = t.svc.createAsk(AGENT, parent.cardId, ask()); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.cardId).toBe(askCardId(parent.cardId, 'venue-address')); expect(r.existed).toBe(false); expect(r.blockedByRecordId).toMatch(/^wc:wc_/);
    const a = t.svc.view(r.cardId)!;
    expect(a.card.carrier).toEqual({ personKey: 'justin' }); expect(a.card.refs).toEqual([{ kind: 'parent-card', id: parent.cardId }]); expect(a.card.createdBy).toEqual({ kind: 'agent' });
    expect(a.status).toBe('with-person'); expect(t.svc.lane(a, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-you');
    const p = t.svc.view(parent.cardId)!;
    expect(p.status).toBe('blocked'); expect(p.card.openBlockers).toEqual([r.cardId]); expect(t.svc.blocks(r.cardId)).toEqual([parent.cardId]);
    // The same body again: the same ask and link, nothing new written.
    const n = t.svc.recordsOf(parent.cardId).length + t.svc.recordsOf(r.cardId).length;
    const again = t.svc.createAsk(AGENT, parent.cardId, ask()); expect(again).toMatchObject({ ok: true, cardId: r.cardId, blockedByRecordId: r.blockedByRecordId, existed: true });
    expect(t.svc.recordsOf(parent.cardId).length + t.svc.recordsOf(r.cardId).length).toBe(n);
    // A different body under the same key: refused with the existing id.
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ title: 'Something else' }))).toMatchObject({ ok: false, status: 409, error: 'ask-exists', detail: { cardId: r.cardId } });
    // The cap on open asks per parent, named.
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ askKey: 'two', carrier: { personKey: 'adriana' } })).ok).toBe(true);
    expect(t.svc.createAsk(AGENT, parent.cardId, ask({ askKey: 'three' }))).toMatchObject({ ok: false, status: 429, error: 'too-many-open-asks', detail: { limit: 2, open: 2 } });
    expect(t.svc.openAsksOf(parent.cardId)).toHaveLength(2);
    // Asks count toward the daily ceiling (parent + 2 asks = 3 of 4 today).
    const other = t.svc.createCard(AGENT, { ...work, title: 'other' }); if (!other.ok) throw new Error(other.error);
    expect(t.svc.createAsk(AGENT, other.cardId, ask({ askKey: 'k' }))).toMatchObject({ ok: false, status: 429, error: 'daily-card-ceiling' });
    // A scoped session bound to the parent's conversation may raise one; bound elsewhere it finds no card.
    const t2 = makeService();
    const p2 = approvedCard(t2);
    expect(t2.svc.createAsk(SESSION('00000000-0000-4000-8000-000000000000'), p2.cardId, ask())).toMatchObject({ ok: false, status: 404 });
    const s = t2.svc.createAsk(SESSION(p2.conversationKey), p2.cardId, ask()); expect(s.ok).toBe(true);
    // Closing the ask as done by its carrier hands the parent back; the brief's words come from the close-out.
    if (!s.ok) return;
    const askView = t2.svc.view(s.cardId)!;
    expect(t2.svc.tap(OWNER, s.cardId, { action: 'archive', closeAs: 'done', note: '1 Main Street', materialHash: askView.card.materialHash }).ok).toBe(true);
    expect(t2.svc.reconcileBlockers().unblocked.map((u) => u.reason)).toEqual(['blocker-archived']);
    expect(t2.svc.view(p2.cardId)!.card.workable).toBe(true);
  });
  it('a chain past softOpenBlockers is a budget, not a refusal', () => {
    const t = makeService({ softOpenBlockers: 1 });
    const { a, b } = pair(t);
    const c = t.svc.createCard(AGENT, { ...work, title: 'c' }); if (!c.ok) throw new Error(c.error);
    const l1 = t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }); expect(l1.ok && !l1.overBlockerBudget).toBe(true);
    const l2 = t.svc.addBlockedBy(AGENT, a, { blockerCardId: c.cardId }); expect(l2.ok && l2.overBlockerBudget).toMatchObject({ count: 2, softOpenBlockers: 1, words: 'a chain this deep is usually a project' });
  });
  it('reads resolve blocker words under the viewer\'s access and never leak the other card', () => {
    const t = makeService();
    const mine = memberCard(t.svc); if (!mine.ok) throw new Error(mine.error);
    const secret = t.svc.createCard(OWNER, { ...work, title: 'Board salaries review' }); if (!secret.ok) throw new Error(secret.error);
    expect(t.svc.addBlockedBy(OWNER, mine.cardId, { blockerCardId: secret.cardId }).ok).toBe(true);
    const v = t.svc.view(mine.cardId)!;
    expect(v.status).toBe('blocked');
    const owner = cardJson(t.svc, v, viewerOf('justin', true), (k) => k);
    expect(owner.blockedWords).toBe('Blocked by: Board salaries review'); expect(owner.needLine).toBe('Blocked by: Board salaries review');
    expect(owner.blockedBy).toEqual([expect.objectContaining({ cardId: secret.cardId, title: 'Board salaries review' })]);
    const member = cardJson(t.svc, v, viewerOf('adriana'), (k) => k);
    expect(member.blockedWords).toBe('Blocked by a card you cannot see'); expect(member.needLine).toBe('Blocked by a card you cannot see');
    expect(member.blockedBy).toEqual([expect.objectContaining({ cardId: null, title: null })]);
    expect(JSON.stringify(member)).not.toContain('salaries'); expect(JSON.stringify(member)).not.toContain(secret.cardId);
    // The blocker's row for the owner says what it blocks; for a member who may read the blocker but not the blocked card, it hides it.
    const sv = t.svc.view(secret.cardId)!;
    expect(cardJson(t.svc, sv, viewerOf('justin', true), (k) => k).blocksLine).toBe(`Blocks: ${work.title}`);
    t.reads.add(`bob|${secret.conversationKey}`);
    const bobOnSecret = cardJson(t.svc, sv, viewerOf('bob'), (k) => k, { mayRead: (ck) => ck === secret.conversationKey });
    expect(bobOnSecret.blocksLine).toBe('Blocks a card you cannot see'); expect(JSON.stringify(bobOnSecret)).not.toContain(mine.cardId);
    // The blocked card is in nobody's Waiting on you; the member's lane for it is Waiting on others... no: it is their own card, blocked, so Waiting on others
    expect(t.svc.lane(v, { isOwner: false, personKey: 'adriana' })).toBe('waiting-on-others');
    expect(t.svc.lane(v, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-others');
    // A member's refs omit a parent they cannot read.
    const parent = t.svc.createCard(AGENT, work); if (!parent.ok) throw new Error(parent.error);
    const r = t.svc.createAsk(AGENT, parent.cardId, ask({ carrier: { personKey: 'adriana' } })); if (!r.ok) throw new Error(r.error);
    const askJson = cardJson(t.svc, t.svc.view(r.cardId)!, viewerOf('adriana'), (k) => k);
    expect(askJson.refs).toEqual([]); expect(askJson.blocksLine).toBe('Blocks a card you cannot see');
    expect(cardJson(t.svc, t.svc.view(r.cardId)!, viewerOf('justin', true), (k) => k).refs).toEqual([{ kind: 'parent-card', id: parent.cardId }]);
  });
  it('status precedence: a person\'s pending action outranks a block; blocked outranks quiet and parked; needLine floors', () => {
    const t = makeService();
    const { a, b } = pair(t);
    expect(t.svc.addBlockedBy(AGENT, a, { blockerCardId: b }).ok).toBe(true);
    const f = t.svc.view(a)!.card;
    expect(deriveStatus(f, { pendingOrParked: false, parked: true }, t.now() + 10 * 86_400_000, 1)).toBe('blocked');
    expect(deriveStatus({ ...f, holds: ['wc:x:t:1'] }, { pendingOrParked: false, parked: false }, t.now(), 24)).toBe('held');
    expect(laneFor('blocked', true, f, 'justin')).toBe('with-agent');
    expect(needLine({ ...t.svc.view(a)!, status: 'blocked' })).toBe('Blocked by another card');
  });
});

describe('the phone\'s signed pass (§8)', () => {
  it('`to` enters the action line only when present, so every existing line is unchanged; buildAction accepts a pass and refuses `to` elsewhere', () => {
    const C = 'wc_0123456789abcdef';
    const plain = tapActionLine({ action: 'approve', cardId: C, materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64) });
    expect(plain).toBe(tapActionLine({ action: 'approve', cardId: C, materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64), to: undefined }));
    const pass = tapActionLine({ action: 'pass', cardId: C, titleHash: 'b'.repeat(64), to: 'adriana' });
    expect(pass).toContain('pass to adriana'); expect(pass).not.toBe(tapActionLine({ action: 'pass', cardId: C, titleHash: 'b'.repeat(64), to: 'bob' }));
    const built = buildAction('work-card-tap', C, { tapAction: 'pass', to: 'owner', titleHash: 'b'.repeat(64) });
    expect(built).toMatchObject({ ok: true, action: { kind: 'work-card-tap', target: C, tap: { action: 'pass', to: 'owner' } } });
    expect(buildAction('work-card-tap', C, { tapAction: 'pass', titleHash: 'b'.repeat(64) })).toMatchObject({ ok: false, error: 'bad-pass-to' });
    expect(buildAction('work-card-tap', C, { tapAction: 'approve', to: 'adriana', materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64) })).toMatchObject({ ok: false, error: 'bad-pass-to' });
    expect(buildAction('work-card-tap', C, { tapAction: 'pass', to: 'has space', titleHash: 'b'.repeat(64) })).toMatchObject({ ok: false, error: 'bad-pass-to' });
  });
});
