/**
 * Work Board cards appear (docs/specs/work-board-cards-appear.md §2, §3): the approval amendment on both sides,
 * the person-carried claim rule, the `created`-first fold, which Needs-you items a card may cover, the required
 * recommendation and why-you on route writes, the graduation exclusion, and each need once in Needs-you.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, foldCard, toFoldRecords, partitionRecords, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { cardJson } from '../../src/core/workBoardViews.js';
import { linkCoveredRows, HAS_CARD_LABEL } from '../../dashboard/console/needs-model.js';
import { workBoardNeedRows } from '../../dashboard/console/work-model.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const SERVER: WorkPrincipal = { kind: 'agent', server: true };

function makeService() {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-18T03:00:00Z');
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
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => k,
  });
  return { svc, journal, advance: (ms: number) => { clock += ms; } };
}

const ASK = { recommendation: 'Tuesday', whyYou: 'Only you know the calendar.' };
const yours = { title: 'Pick a date', need: 'Which date?', doneWhen: [{ id: 'd1', text: 'Chosen', certify: 'agent-may-certify' as const }], carrier: 'owner', outward: false, ...ASK };

describe('approval: a card a person carries that sends nothing outward needs no approve tap', () => {
  it('an agent card the owner carries is the owner\'s to do at once', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    const v = t.svc.view(r.cardId)!;
    expect(v.card.approvalRequired).toBe(false);
    expect(v.status).toBe('with-person');
    expect(v.card.workable).toBe(false); // nothing for the agent to start
  });
  it('moving the carrier to the agent brings approval back before any work', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    expect(t.svc.edit(AGENT, r.cardId, { carrier: 'agent' }).ok).toBe(true);
    const v = t.svc.view(r.cardId)!;
    expect(v.card.approvalRequired).toBe(true);
    expect(v.status).toBe('needs-approval');
    expect(v.card.workable).toBe(false);
  });
  it('an outward card the owner carries still needs its own approve tap', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, { ...yours, outward: true }); if (!r.ok) throw new Error(r.error);
    expect(t.svc.view(r.cardId)!.status).toBe('needs-approval');
  });
  it('an agent-carried agent card still needs approval', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, { ...yours, carrier: 'agent' }); if (!r.ok) throw new Error(r.error);
    expect(t.svc.view(r.cardId)!.status).toBe('needs-approval');
  });
});

describe('the person-carried claim rule: only the person finishes such a card', () => {
  it('an agent claim on an owner-carried card with an agent-may-certify item waits for Confirm done', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    expect(t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'Chosen: Tuesday' }).ok).toBe(true);
    const c = t.svc.claimDone(AGENT, r.cardId); if (!c.ok) throw new Error(c.error);
    expect(c.needsConfirm).toBe(true);
    const v = t.svc.view(r.cardId)!;
    expect(v.card.done).toBe(false);
    expect(v.status).toBe('claims-done');
    expect(t.svc.tap(OWNER, r.cardId, { action: 'confirm-done', claimId: c.claimId, materialHash: v.card.materialHash }).ok).toBe(true);
    expect(t.svc.view(r.cardId)!.card.done).toBe(true);
  });
  it('the same holds for a person-written card the agent edited', () => {
    const t = makeService();
    const r = t.svc.createCard(OWNER, { ...yours, carrier: { personKey: 'justin' } }); if (!r.ok) throw new Error(r.error);
    expect(t.svc.edit(AGENT, r.cardId, { need: 'Which date? (rewritten)' }).ok).toBe(true);
    t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'done' });
    const c = t.svc.claimDone(AGENT, r.cardId); if (!c.ok) throw new Error(c.error);
    expect(t.svc.view(r.cardId)!.card.done).toBe(false);
  });
  it('an outward, approved card closes on an agent claim as today (project-app version cards)', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, { ...yours, outward: true }); if (!r.ok) throw new Error(r.error);
    const v = t.svc.view(r.cardId)!;
    expect(t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: v.card.materialHash }).ok).toBe(true);
    t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'done' });
    const c = t.svc.claimDone(AGENT, r.cardId); if (!c.ok) throw new Error(c.error);
    expect(t.svc.view(r.cardId)!.card.done).toBe(true);
  });
});

describe('created is folded first, whatever its clock', () => {
  it('a second created with a newer clock leaves the card\'s earlier records readable', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    t.advance(1000);
    t.svc.edit(AGENT, r.cardId, { need: 'edited need' });
    // A racing writer's `created` under the same fixed key, with a later clock.
    const created = t.journal.find((e) => e.data.recordType === 'created')!;
    const later = { ...created.data, hlc: { physical: Date.parse('2026-11-18T04:00:00Z'), logical: 0, node: 'm_b' }, origin: 'm_b' };
    const union = [...t.journal, { data: later, origin: 'm_b' }];
    const recs = toFoldRecords(union);
    const { byCard, policies } = partitionRecords(recs);
    const f = foldCard(r.cardId, byCard.get(r.cardId)!, policies);
    expect(f.unknown).toEqual([]);
    expect(f.need).toBe('edited need');
  });
});

describe('what a writer may put on a card', () => {
  it('covers: plans and pull requests only; cos: is the server\'s; position keys and sensitive sources are refused', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...yours, covers: ['plan:INI-7', 'pr:3361'] }).ok).toBe(true);
    for (const k of ['secret:0', 'health:x', 'account:a', 'feedback:act:0', 'cos:waiting:telegram:1', 'spending', 'promise:own:CMT-1']) {
      expect(t.svc.createCard(AGENT, { ...yours, covers: [k] }), k).toMatchObject({ ok: false, error: 'covers-not-allowed' });
    }
    expect(t.svc.createCard(SERVER, { ...yours, covers: ['cos:waiting:telegram:1'] }, { cardId: 'wc_00000000000000aa' }).ok).toBe(true);
  });
  it('mirror is the server writer\'s only', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...yours, mirror: { ref: 'x', hlc: { physical: 1, logical: 0, node: 'm' } } })).toMatchObject({ ok: false, error: 'mirror-not-allowed' });
  });
  it('a deterministic record key is refused from anyone but the server writer', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    expect(t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'x' }, { recordKey: `wc:${r.cardId}:v:cos-1` })).toMatchObject({ ok: false, error: 'record-key-not-allowed' });
  });
  it('route writes by the agent need a recommendation and why-you; a person\'s do not; an edit cannot clear them', () => {
    const t = makeService();
    expect(t.svc.askFieldsRefusal(AGENT, { title: 'x' }, null)).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { recommendation: 'y' }, null)).toMatchObject({ error: 'why-you-required' });
    expect(t.svc.askFieldsRefusal(AGENT, ASK, null)).toBeNull();
    expect(t.svc.askFieldsRefusal(OWNER, {}, null)).toBeNull();
    const r = t.svc.createCard(AGENT, yours); if (!r.ok) throw new Error(r.error);
    expect(t.svc.askFieldsRefusal({ kind: 'session', conversationKey: r.conversationKey }, { whyYou: '' }, r.cardId)).toMatchObject({ error: 'why-you-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { need: 'x' }, r.cardId)).toBeNull();
  });
  it('whyYou is credential-checked and shown in the card read with covers', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...yours, whyYou: 'key sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, error: 'credential-refused', detail: { field: 'whyYou' } });
    const r = t.svc.createCard(AGENT, { ...yours, covers: ['pr:1'] }); if (!r.ok) throw new Error(r.error);
    const j = cardJson(t.svc, t.svc.view(r.cardId)!, { isOwner: true, isAgent: false, personKey: 'justin' }, (k) => k);
    expect(j.whyYou).toBe('Only you know the calendar.');
    expect(j.covers).toEqual(['pr:1']);
    expect(j.serverOwned).toBeUndefined();
  });
  it('server-owned cards are left out of the graduation pilot and counted on their own', () => {
    const t = makeService();
    t.svc.createCard(SERVER, { ...yours, covers: ['cos:waiting:telegram:1'] }, { cardId: 'wc_00000000000000ab' });
    expect(t.svc.graduationState().pilotStartedAt).toBeNull();
    expect(t.svc.graduationMetrics(7).metrics.serverOwnedCards).toBe(1);
    expect(t.svc.graduationMetrics(7).metrics.cards).toBe(0);
  });
});

describe('each need once in Needs you', () => {
  const cardRow = (id: string, covers: string[], status = 'with-person', extra: Record<string, unknown> = {}) => ({ id, title: 'Agent words', needLine: 'x', status, outward: false, question: null, covers, createdAt: '2026-11-18T03:00:00.000Z', serverOwned: true, ...extra });
  const board = (cards: Array<Record<string, unknown>>) => ({ ok: true, data: { lanes: [{ lane: 'waiting-on-you', cards }], settings: { softOpenCards: 30 } } });
  const asNeedRows = (cards: Array<Record<string, unknown>>) => (workBoardNeedRows(board(cards)) ?? []).map((r: Record<string, unknown>) => ({ key: `need:${r.key}`, main: r.main, sub: r.sub, action: { kind: 'href', href: r.href }, board: { cardId: r.cardId, href: r.href, covers: r.covers, linkable: r.linkable, serverOwned: r.serverOwned, createdAt: r.createdAt } }));
  const cosRow = { key: 'need:cos:waiting:telegram:135786', main: 'Instar Agent Creation is waiting on you', sub: '', action: { kind: 'href', href: '#/work/chats?c=telegram%3A135786' } };
  const planRow = { key: 'need:plan:plan:INI-7', main: 'Plan INI-7 waits for your OK', sub: 'its own words', action: { kind: 'href', href: '#/work/plans?s=needsYou' } };

  it('a covered row keeps its words and action, gains a fixed-label link; the card row is dropped', () => {
    const rows = linkCoveredRows([cosRow, ...asNeedRows([cardRow('wc_00000000000000a1', ['cos:waiting:telegram:135786'])])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].main).toBe(cosRow.main);
    expect(rows[0].action).toEqual(cosRow.action);
    expect(rows[0].card).toEqual({ id: 'wc_00000000000000a1', href: '#/work/board?card=wc_00000000000000a1', label: HAS_CARD_LABEL });
  });
  it('a plan row (keyed plan:plan:<id> by its source) links to a card covering plan:<id>', () => {
    const rows = linkCoveredRows([planRow, ...asNeedRows([cardRow('wc_00000000000000a2', ['plan:INI-7'])])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].card?.id).toBe('wc_00000000000000a2');
  });
  it('a card that asks for Approve, Confirm done, an answer, or something outward keeps its own row', () => {
    for (const extra of [{ status: 'needs-approval' }, { status: 'claims-done' }, { question: { id: 'q', text: 'Which?' } }, { outward: true }]) {
      const rows = linkCoveredRows([planRow, ...asNeedRows([cardRow('wc_00000000000000a3', ['plan:INI-7'], 'with-person', extra)])]);
      expect(rows, JSON.stringify(extra)).toHaveLength(2);
      expect(rows.find((r: Record<string, unknown>) => r.card)).toBeUndefined();
    }
  });
  it('two cards on one row: the older links it, the other keeps its own row; nothing is mutated', () => {
    const input = [planRow, ...asNeedRows([cardRow('wc_00000000000000b2', ['plan:INI-7'], 'with-person', { createdAt: '2026-11-18T05:00:00.000Z' }), cardRow('wc_00000000000000b1', ['plan:INI-7'])])];
    const snapshot = JSON.stringify(input);
    const rows = linkCoveredRows(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: Record<string, unknown>) => r.card)?.card.id).toBe('wc_00000000000000b1');
  });
  it('an agent session\'s card links the row it covers but keeps its own row (it can never hide an ask)', () => {
    const rows = linkCoveredRows([planRow, ...asNeedRows([cardRow('wc_00000000000000d1', ['plan:INI-7'], 'with-person', { serverOwned: false })])]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: Record<string, unknown>) => r.key === planRow.key)?.card?.id).toBe('wc_00000000000000d1');
    expect(rows.find((r: Record<string, unknown>) => r.key === 'need:work:wc_00000000000000d1')).toBeTruthy();
  });
  it('a card whose covered rows are absent keeps its own row', () => {
    const rows = linkCoveredRows(asNeedRows([cardRow('wc_00000000000000c1', ['pr:9'])]));
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('need:work:wc_00000000000000c1');
  });
});
