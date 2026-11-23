/**
 * Work Board slice 3 (docs/specs/work-front-doors.md §6, decision 3): a person closes a card as "Done" with a
 * closeout note or as "Not important" with a reason; the reasons become the agent's dismissal lessons; every card
 * says whose turn it is and whether work has started; the board lists untouched cards first; a card names its
 * own conversation's read and send routes.
 */
import { lessonsJson } from '../../src/server/workBoardRoutes.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, transcriptLineFor, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, tapActionLine, sha256Hex, canonicalJson, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { cardJson, boardJson, turnFor, conversationRef } from '../../src/core/workBoardViews.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const VIEWER = { personKey: 'justin', isOwner: true, isAgent: false };
const name = (k: string) => (k === 'justin' ? 'Justin' : k);

function makeService() {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-17T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings({});
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal,
    now: () => clock,
    settings: () => settings,
    ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: name,
  });
  return { svc, journal, advance: (ms: number) => { clock += ms; } };
}

const card = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked', certify: 'agent-may-certify' }], outward: false };
const ctx = { countDroppedField: () => {}, countJailReject: () => {} } as never;

describe('closing a card: Done with a note, Not important with a reason', () => {
  let t: ReturnType<typeof makeService>;
  let id: string;
  beforeEach(() => { t = makeService(); const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create'); id = r.cardId; });

  it('Done needs its closeout note and Not important its reason; an empty or blank note is refused by name', () => {
    expect(t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'done' })).toMatchObject({ ok: false, status: 400, error: 'note-required' });
    expect(t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: '   ' })).toMatchObject({ ok: false, status: 400, error: 'reason-required' });
    expect(t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'maybe', note: 'x' })).toMatchObject({ ok: false, error: 'unknown-close' });
    expect(t.svc.tap(OWNER, id, { action: 'archive', note: 'x' })).toMatchObject({ ok: false, error: 'unknown-close' });
    expect(t.svc.view(id)!.card.archives).toEqual([]);
  });
  it('a note carrying a credential is refused; an over-long note is refused', () => {
    expect(t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'done', note: 'key sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, status: 422, error: 'credential-refused' });
    expect(t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'done', note: 'x'.repeat(2001) })).toMatchObject({ ok: false, status: 413 });
  });
  it('the agent can never close a card (only a person\'s tap)', () => {
    expect(t.svc.tap(AGENT, id, { action: 'archive', closeAs: 'done', note: 'did it' })).toMatchObject({ ok: false, status: 403, error: 'person-required' });
  });
  it('Done puts the card with the done cards and shows its note; it stops being workable', () => {
    const r = t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'done', note: 'Booked the Hall for Friday' });
    expect(r.ok).toBe(true);
    const v = t.svc.view(id)!;
    expect(v.status).toBe('archived');
    expect(v.card.workable).toBe(false);
    expect(v.card.closeout).toMatchObject({ as: 'done', note: 'Booked the Hall for Friday' });
    const j = cardJson(t.svc, v, VIEWER, name);
    expect(j.lane).toBe('done');
    expect(j.turn).toBe('nobody');
    expect(j.needLine).toBe('Done: Booked the Hall for Friday');
    expect(j.closeout).toMatchObject({ as: 'done', note: 'Booked the Hall for Friday', by: { kind: 'person', name: 'Justin' } });
  });
  it('Not important stays archived, and its reason becomes a lesson with its source', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'We never use that venue' });
    const v = t.svc.view(id)!;
    expect(cardJson(t.svc, v, VIEWER, name).lane).toBe('archived');
    const lessons = t.svc.dismissalLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ cardId: id, title: 'Pick a venue', reason: 'We never use that venue', by: { kind: 'person', personKey: 'justin' } });
    expect(lessons[0].tapId).toBe(v.card.closeout!.tapId);
  });
  it('SEC-122: a card retitled after it was dismissed keeps the dismissed title on its lesson, with the new one beside it', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'We never use that venue', titleHash: sha256Hex(card.title) });
    t.advance(1000);
    const e = t.svc.edit(AGENT, id, { title: 'Pay the deposit for the Hall' });
    expect(e.ok).toBe(true);
    const lessons = t.svc.dismissalLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ title: 'Pick a venue', currentTitle: 'Pay the deposit for the Hall', reason: 'We never use that venue' });
    expect(t.svc.view(id)!.card.closeout!.title).toBe('Pick a venue');
    const json = lessonsJson(t.svc, name, 50);
    expect(json[0]).toMatchObject({ cardTitle: 'Pick a venue', cardTitleNow: 'Pay the deposit for the Hall', retitledAfterClose: true });
  });
  it('SEC-122: an edit that lands before the tap does not take over the reason: the title the screen sent wins', () => {
    expect(t.svc.edit(AGENT, id, { title: 'Pay the deposit for the Hall' }).ok).toBe(true); // the person still sees "Pick a venue"
    t.advance(1000);
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'We never use that venue', titleHash: sha256Hex('Pick a venue') });
    const l = t.svc.dismissalLessons()[0]!;
    expect(l).toMatchObject({ title: 'Pick a venue', currentTitle: 'Pay the deposit for the Hall' });
    expect(l).not.toHaveProperty('titleUnconfirmed');
  });
  it('SEC-122: a screen title that matches no title the card ever had is marked unconfirmed', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'Not ours', titleHash: sha256Hex('Something else entirely') });
    const l = t.svc.dismissalLessons()[0]!;
    expect(l).toMatchObject({ title: 'Pick a venue', titleUnconfirmed: true });
    expect(lessonsJson(t.svc, name, 50)[0]).toMatchObject({ titleUnconfirmed: true });
  });
  it('SEC-122: close, reopen, retitle, close again: the lesson carries the second close\'s title', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'Not now', titleHash: sha256Hex(card.title) });
    const first = t.svc.view(id)!.card.closeout!.tapId;
    expect(t.svc.tap(OWNER, id, { action: 'unarchive', names: first, titleHash: sha256Hex(card.title) }).ok).toBe(true);
    t.advance(1000);
    expect(t.svc.edit(AGENT, id, { title: 'Pick a venue for March' }).ok).toBe(true);
    t.advance(1000);
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'March is cancelled', titleHash: sha256Hex('Pick a venue for March') });
    const ls = t.svc.dismissalLessons();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ title: 'Pick a venue for March', reason: 'March is cancelled' });
    expect(ls[0]).not.toHaveProperty('currentTitle');
    expect(cardJson(t.svc, t.svc.view(id)!, VIEWER, name).closeout).toMatchObject({ title: 'Pick a venue for March' });
  });
  it('SEC-122: a lesson on a card that was never retitled carries no current title, and a confirmed close no flag', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'We never use that venue', titleHash: sha256Hex(card.title) });
    const l = t.svc.dismissalLessons()[0]!;
    expect(l.title).toBe('Pick a venue');
    expect(l).not.toHaveProperty('currentTitle');
    expect(l).not.toHaveProperty('titleUnconfirmed');
    expect(lessonsJson(t.svc, name, 50)[0]).not.toHaveProperty('retitledAfterClose');
  });
  it('SEC-122: a close sent without the screen\'s title hash (an older client) is marked unconfirmed', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'We never use that venue' });
    expect(t.svc.dismissalLessons()[0]).toMatchObject({ title: 'Pick a venue', titleUnconfirmed: true });
  });
  it('reopening (unarchive naming the close) drops the close and its lesson', () => {
    t.svc.tap(OWNER, id, { action: 'archive', closeAs: 'not-important', note: 'Not needed' });
    const tapId = t.svc.view(id)!.card.closeout!.tapId;
    expect(t.svc.tap(OWNER, id, { action: 'unarchive', names: tapId, titleHash: sha256Hex(card.title) }).ok).toBe(true);
    expect(t.svc.view(id)!.card.closeout).toBeNull();
    expect(t.svc.dismissalLessons()).toEqual([]);
  });
  it('a plain archive still works (older clients) and carries no closeout', () => {
    expect(t.svc.tap(OWNER, id, { action: 'archive' }).ok).toBe(true);
    const v = t.svc.view(id)!;
    expect(v.card.closeout).toBeNull();
    expect(cardJson(t.svc, v, VIEWER, name).lane).toBe('archived');
  });
  it('the conversation line names the close and its note', () => {
    const at = '2026-11-17T20:00:00.000Z';
    const by = { kind: 'person', personKey: 'justin', proof: 'pin' };
    const when = () => '1:00 PM';
    expect(transcriptLineFor('tap', { action: 'archive', closeAs: 'done', note: 'Booked', by, at }, { name, when })).toBe('Work board: Justin closed this as done: "Booked" · 1:00 PM');
    expect(transcriptLineFor('tap', { action: 'archive', closeAs: 'not-important', note: 'No', by, at }, { name, when })).toBe('Work board: Justin closed this as not important: "No" · 1:00 PM');
    expect(transcriptLineFor('tap', { action: 'archive', by, at }, { name, when })).toBe('Work board: archived by Justin');
  });
});

describe('the close record on every build', () => {
  const base = { recordType: 'tap', cardId: 'wc_0123456789abcdef', recordKey: 'wc:wc_0123456789abcdef:t:1', hlc: { physical: 1, logical: 0, node: 'm_a' }, op: 'put', origin: 'm_a', by: { kind: 'person', personKey: 'justin', proof: 'pin' }, at: '2026-11-17T20:00:00.000Z' };
  it('a close is only an archive with a non-empty note', () => {
    expect(workCardRecordStoreSchema.validate({ ...base, action: 'archive', closeAs: 'done', note: 'ok' }, ctx)).toMatchObject({ closeAs: 'done', note: 'ok' });
    expect(workCardRecordStoreSchema.validate({ ...base, action: 'hold', closeAs: 'done', note: 'ok' }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...base, action: 'archive', closeAs: 'done' }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...base, action: 'archive', closeAs: 'done', note: ' ' }, ctx)).toBeNull();
  });
  it('the signed line of a tap without a close is byte-identical to before; a close enters the digest', () => {
    const t = { action: 'hold', cardId: 'wc_0123456789abcdef' };
    const old = `Work card ${t.cardId}: hold [${sha256Hex(canonicalJson({ action: 'hold', cardId: t.cardId, materialHash: null, questionId: null, answer: null, claimId: null, retryOf: null, names: null, titleHash: null }))}]`;
    expect(tapActionLine(t)).toBe(old);
    const a = tapActionLine({ action: 'archive', cardId: t.cardId, closeAs: 'done', note: 'one' });
    const b = tapActionLine({ action: 'archive', cardId: t.cardId, closeAs: 'done', note: 'two' });
    expect(a).toMatch(/: close as done \[/);
    expect(a).not.toBe(b);
  });
});

describe('the owner phone: the close is on the Face ID line, checked before any challenge', () => {
  const cardId = 'wc_0123456789abcdef';
  it('a missing note or reason is refused before a challenge is issued', () => {
    expect(buildAction('work-card-tap', cardId, { tapAction: 'archive', closeAs: 'done' })).toEqual({ ok: false, error: 'note-required' });
    expect(buildAction('work-card-tap', cardId, { tapAction: 'archive', closeAs: 'not-important', note: '' })).toEqual({ ok: false, error: 'reason-required' });
    expect(buildAction('work-card-tap', cardId, { tapAction: 'hold', closeAs: 'done', note: 'x' })).toEqual({ ok: false, error: 'bad-close' });
  });
  it('the note is part of what Face ID signs', () => {
    const a = buildAction('work-card-tap', cardId, { tapAction: 'archive', closeAs: 'not-important', note: 'not ours' });
    const b = buildAction('work-card-tap', cardId, { tapAction: 'archive', closeAs: 'not-important', note: 'not ours either' });
    if (!a.ok || !b.ok) throw new Error('build');
    expect(actionLine(a.action)).not.toBe(actionLine(b.action));
    expect(actionLine(a.action)).toContain('close as not important');
  });
});

describe('whose turn, untouched first, and the conversation inside the card', () => {
  it('turn follows the viewer\'s lane', () => {
    expect(turnFor('waiting-on-you')).toBe('you');
    expect(turnFor('with-agent')).toBe('agent');
    expect(turnFor('waiting-on-others')).toBe('others');
    expect(turnFor('done')).toBe('nobody');
    expect(turnFor('archived')).toBe('nobody');
  });
  it('a card is untouched until a person taps it; the agent\'s own edits do not start it', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    t.svc.edit(AGENT, r.cardId, { recommendation: 'Book the Hall' });
    let j = cardJson(t.svc, t.svc.view(r.cardId)!, VIEWER, name);
    expect(j).toMatchObject({ started: false, startedAt: null, turn: 'you' });
    t.advance(1000);
    t.svc.tap(OWNER, r.cardId, { action: 'hold' });
    j = cardJson(t.svc, t.svc.view(r.cardId)!, VIEWER, name);
    expect(j.started).toBe(true);
    expect(typeof j.startedAt).toBe('string');
  });
  it('"Waiting on you" lists untouched cards first, then oldest first', () => {
    const t = makeService();
    // Asks (outward): an inward agent-work card is `not-started`, with the agent, never in "Waiting on you" (agent-work-cards-default §1).
    const a = t.svc.createCard(AGENT, { ...card, outward: true, title: 'A' }); if (!a.ok) throw new Error('a');
    t.advance(1000);
    const b = t.svc.createCard(AGENT, { ...card, outward: true, title: 'B' }); if (!b.ok) throw new Error('b');
    t.advance(1000);
    t.svc.tap(OWNER, a.cardId, { action: 'hold' }); // A is started (held: still waiting on the owner)
    const board = boardJson(t.svc, VIEWER, () => true, name, { softOpenCards: 30 });
    const waiting = (board.lanes as Array<{ lane: string; cards: Array<{ title: string }> }>).find((l) => l.lane === 'waiting-on-you')!;
    expect(waiting.cards.map((c) => c.title)).toEqual(['B', 'A']);
  });
  it('the soft cut still keeps the oldest waiting cards; untouched-first only orders what is shown', () => {
    const t = makeService();
    const a = t.svc.createCard(AGENT, { ...card, outward: true, title: 'Old started' }); if (!a.ok) throw new Error('a');
    t.advance(1000);
    t.svc.tap(OWNER, a.cardId, { action: 'hold' });
    t.advance(1000);
    const b = t.svc.createCard(AGENT, { ...card, outward: true, title: 'Newer untouched' }); if (!b.ok) throw new Error('b');
    t.advance(1000);
    const c = t.svc.createCard(AGENT, { ...card, outward: true, title: 'Newest untouched' }); if (!c.ok) throw new Error('c');
    const board = boardJson(t.svc, VIEWER, () => true, name, { softOpenCards: 2 });
    const waiting = (board.lanes as Array<{ lane: string; cards: Array<{ title: string }>; more?: number }>).find((l) => l.lane === 'waiting-on-you')!;
    expect(waiting.cards.map((x) => x.title)).toEqual(['Newer untouched', 'Old started']);
    expect(waiting.more).toBe(1);
  });
  it('the card names its own conversation\'s existing read and send routes', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    const j = cardJson(t.svc, t.svc.view(r.cardId)!, VIEWER, name);
    expect(j.conversation).toEqual(conversationRef(r.conversationKey));
    expect(j.conversation).toMatchObject({ kind: 'app', key: r.conversationKey, messagesPath: `/mobile/chat/app/${r.conversationKey}/messages`, sendPath: `/mobile/chat/app/${r.conversationKey}` });
  });
});
