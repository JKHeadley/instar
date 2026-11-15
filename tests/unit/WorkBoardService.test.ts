/**
 * Work Board service (docs/specs/work-board-asks.md §3–§5, Fixed limits): who may write what,
 * the owner-set limits, the credential check, the daily ceiling and the soft budget, stale-tap
 * refusals, restricting taps always accepted, and the index staying in step with replicated applies.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, validateSettingsPatch, transcriptLineFor, lineIdFor, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, sha256Hex, type UnionEntry } from '../../src/core/WorkCardStore.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const MEMBER: WorkPrincipal = { kind: 'person', personKey: 'adriana', proof: 'presence', isOwner: false };
const AGENT: WorkPrincipal = { kind: 'agent' };

function makeService(over: Partial<{ maxAgentCardsPerDay: number; softOpenCards: number }> = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-12T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings({ maxAgentCardsPerDay: over.maxAgentCardsPerDay ?? 200, softOpenCards: over.softOpenCards ?? 30 });
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
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  return { svc, journal, advance: (ms: number) => { clock += ms; } };
}

const card = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked', certify: 'agent-may-certify' }], outward: false };

describe('WorkBoardService — who may write what', () => {
  let t: ReturnType<typeof makeService>;
  beforeEach(() => { t = makeService(); });

  it('the agent creates a card; it needs approval and is not workable', () => {
    const r = t.svc.createCard(AGENT, card);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = t.svc.view(r.cardId)!;
    expect(v.status).toBe('needs-approval');
    expect(v.card.workable).toBe(false);
  });
  it('a member cannot create a card or tap; a scoped session cannot create', () => {
    expect(t.svc.createCard(MEMBER, card)).toMatchObject({ ok: false, error: 'owner-required' });
    expect(t.svc.createCard({ kind: 'session', conversationKey: 'x' }, card)).toMatchObject({ ok: false, error: 'scoped-session-cannot-create' });
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    expect(t.svc.tap(MEMBER, r.cardId, { action: 'hold' })).toMatchObject({ ok: false, error: 'owner-required' });
  });
  it('the agent and a scoped session can never tap', () => {
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    expect(t.svc.tap(AGENT, r.cardId, { action: 'approve' })).toMatchObject({ ok: false, status: 403, error: 'person-required' });
    expect(t.svc.tap({ kind: 'session', conversationKey: r.conversationKey }, r.cardId, { action: 'approve' })).toMatchObject({ ok: false, error: 'person-required' });
  });
  it('a scoped session reaches only the card whose conversation is its own', () => {
    const a = t.svc.createCard(AGENT, card); if (!a.ok) throw new Error('create');
    const b = t.svc.createCard(AGENT, { ...card, title: 'Other' }); if (!b.ok) throw new Error('create');
    expect(t.svc.edit({ kind: 'session', conversationKey: a.conversationKey }, a.cardId, { recommendation: 'x' }).ok).toBe(true);
    expect(t.svc.edit({ kind: 'session', conversationKey: a.conversationKey }, b.cardId, { recommendation: 'x' })).toMatchObject({ ok: false, status: 404 });
  });
  it('only the agent or the team owner may carry a card', () => {
    expect(t.svc.createCard(AGENT, { ...card, carrier: { personKey: 'adriana' } })).toMatchObject({ ok: false, error: 'carrier-not-allowed' });
    expect(t.svc.createCard(AGENT, { ...card, carrier: { personKey: 'justin' } }).ok).toBe(true);
  });
  it('outward defaults to true when unsure', () => {
    const r = t.svc.createCard(AGENT, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }] }); if (!r.ok) throw new Error('create');
    expect(t.svc.view(r.cardId)!.card.outward).toBe(true);
  });
  it('a card with no done item is refused', () => {
    expect(t.svc.createCard(AGENT, { ...card, doneWhen: [] })).toMatchObject({ ok: false, error: 'done-item-required' });
  });
});

describe('WorkBoardService — limits and the credential check', () => {
  it('refuses a credential in the need, an answer or evidence, naming the field', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...card, need: 'use sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, error: 'credential-refused', detail: { field: 'need' } });
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    expect(t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'key sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, error: 'credential-refused' });
    const q = t.svc.setWaitingOn(AGENT, r.cardId, { principal: { personKey: 'justin' }, question: { text: 'Which?' } }); if (!q.ok) throw new Error('q');
    expect(t.svc.tap(OWNER, r.cardId, { action: 'answer', questionId: q.questionId, answer: 'sk-ant-abcdefghijklmnop' })).toMatchObject({ ok: false, error: 'credential-refused' });
  });
  it('refuses a field over its limit with the field and limit named; nothing is truncated', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...card, title: 'x'.repeat(301) })).toMatchObject({ ok: false, error: 'over-limit', detail: { field: 'title', limit: 300 } });
    expect(t.svc.createCard(AGENT, { ...card, title: 'x'.repeat(300) }).ok).toBe(true);
  });
  it('the daily ceiling refuses the agent with the reset time and ways through, and does not count person-written cards', () => {
    const t = makeService({ maxAgentCardsPerDay: 2 });
    expect(t.svc.createCard(AGENT, card).ok).toBe(true);
    expect(t.svc.createCard(OWNER, card).ok).toBe(true);
    expect(t.svc.createCard(AGENT, card).ok).toBe(true);
    const r = t.svc.createCard(AGENT, card);
    expect(r).toMatchObject({ ok: false, error: 'daily-card-ceiling' });
    expect(t.svc.createCard(OWNER, card).ok).toBe(true);
  });
  it('the soft budget never refuses; it reports overSoftBudget', () => {
    const t = makeService({ softOpenCards: 2 });
    t.svc.createCard(AGENT, card); t.svc.createCard(AGENT, card);
    const r = t.svc.createCard(AGENT, card);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overSoftBudget).toMatchObject({ softOpenCards: 2 });
  });
  it('settings patches must be positive whole numbers; a free check below 60 s is refused', () => {
    expect(validateSettingsPatch({ softOpenCards: 10 })).toEqual({ ok: true });
    expect(validateSettingsPatch({ softOpenCards: 0 })).toMatchObject({ ok: false, field: 'softOpenCards' });
    expect(validateSettingsPatch({ pickup: { freeCheckMinSeconds: 30 } })).toMatchObject({ ok: false, field: 'pickup.freeCheckMinSeconds' });
    expect(validateSettingsPatch({ pickup: { maxSpendingAttempts: 1 } })).toEqual({ ok: true });
    expect(validateSettingsPatch({ softOpenCard: 10 })).toMatchObject({ ok: false, field: 'softOpenCard' });
    expect(validateSettingsPatch({ limits: { titel: 10 } })).toMatchObject({ ok: false, field: 'limits.titel' });
    expect(resolveWorkBoardSettings({ pickup: { freeCheckMinSeconds: 5, maxSpendingAttempts: 0 } }).pickup).toMatchObject({ freeCheckMinSeconds: 60, maxSpendingAttempts: 3 });
  });
});

describe('WorkBoardService — taps', () => {
  it('an approve on a stale hash is refused stale-card; on the current hash it starts the card', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    expect(t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: 'f'.repeat(64) })).toMatchObject({ ok: false, error: 'stale-card' });
    const h = t.svc.view(r.cardId)!.card.materialHash;
    expect(t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: h }).ok).toBe(true);
    expect(t.svc.view(r.cardId)!.card.workable).toBe(true);
  });
  it('a tap whose title hash does not match the card is refused', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    const h = t.svc.view(r.cardId)!.card.materialHash;
    expect(t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: h, titleHash: sha256Hex('other title') })).toMatchObject({ ok: false, error: 'stale-card' });
    expect(t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: h, titleHash: sha256Hex(card.title) }).ok).toBe(true);
  });
  it('restricting taps are accepted whatever the card state', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    for (const action of ['hold', 'withdraw-approval', 'archive']) expect(t.svc.tap(OWNER, r.cardId, { action }).ok).toBe(true);
    expect(t.svc.tap(OWNER, r.cardId, { action: 'reopen', claimId: `wc:${r.cardId}:c:deadbeef` }).ok).toBe(true);
  });
  it('answering a replaced question says so and names the replacement', () => {
    const t = makeService();
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    const q1 = t.svc.setWaitingOn(AGENT, r.cardId, { principal: { personKey: 'justin' }, question: { text: 'A?' } }); if (!q1.ok) throw new Error('q1');
    expect(t.svc.setWaitingOn(AGENT, r.cardId, { principal: { personKey: 'justin' }, question: { text: 'B?' } })).toMatchObject({ ok: false, error: 'question-open' });
    const q2 = t.svc.setWaitingOn(AGENT, r.cardId, { principal: { personKey: 'justin' }, question: { text: 'B?' }, supersedes: q1.questionId, reason: 'changed my mind' }); if (!q2.ok) throw new Error('q2');
    expect(t.svc.tap(OWNER, r.cardId, { action: 'answer', questionId: q1.questionId, answer: 'yes' })).toMatchObject({ ok: false, error: 'question-replaced', detail: { replacement: q2.questionId } });
  });
  it('the agent cannot materially edit a finished card; a person can, and it unfinishes', () => {
    const t = makeService();
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    expect(t.svc.addEvidence(AGENT, r.cardId, { itemId: 'd1', text: 'booked #42' }).ok).toBe(true);
    expect(t.svc.claimDone(AGENT, r.cardId).ok).toBe(true);
    expect(t.svc.view(r.cardId)!.status).toBe('done');
    expect(t.svc.edit(AGENT, r.cardId, { need: 'more' })).toMatchObject({ ok: false, error: 'reopen-required' });
    expect(t.svc.edit(OWNER, r.cardId, { need: 'more' }).ok).toBe(true);
    expect(t.svc.view(r.cardId)!.status).not.toBe('done');
  });
  it('a claim before approval is refused not-approved; with missing evidence, evidence-missing', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    expect(t.svc.claimDone(AGENT, r.cardId)).toMatchObject({ ok: false, error: 'not-approved' });
    const o = t.svc.createCard(OWNER, card); if (!o.ok) throw new Error('create');
    expect(t.svc.claimDone(AGENT, o.cardId)).toMatchObject({ ok: false, error: 'evidence-missing' });
  });
  it('an edit that posts every field records only the field that changed', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    const e = t.svc.edit(OWNER, r.cardId, { ...card, title: 'Fixed' });
    expect(e).toMatchObject({ ok: true, changed: ['title'] });
  });
  it('a redacted card refuses every later agent write', () => {
    const t = makeService();
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    expect(t.svc.tap(OWNER, r.cardId, { action: 'redact' }).ok).toBe(true);
    expect(t.svc.edit(AGENT, r.cardId, { recommendation: 'x' })).toMatchObject({ ok: false, error: 'card-removed' });
    expect(t.svc.view(r.cardId)!.status).toBe('removed');
    expect(t.svc.hiddenConversationKeys().has(r.conversationKey)).toBe(true);
  });
  it('a policy change reports how many waiting cards would start', () => {
    const t = makeService();
    t.svc.createCard(AGENT, card); t.svc.createCard(AGENT, { ...card, outward: true });
    expect(t.svc.cardsStartingUnder('outward-only')).toBe(1);
    expect(t.svc.setPolicy(AGENT, 'outward-only')).toMatchObject({ ok: false, error: 'owner-required' });
    expect(t.svc.setPolicy(OWNER, 'outward-only')).toMatchObject({ ok: true, wouldStart: 1 });
  });
});

describe('WorkBoardService — index', () => {
  it('rebuild from the journal reproduces the same views', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, card); if (!r.ok) throw new Error('create');
    t.svc.tap(OWNER, r.cardId, { action: 'approve', materialHash: t.svc.view(r.cardId)!.card.materialHash });
    const before = t.svc.view(r.cardId)!;
    t.svc.rebuild();
    const after = t.svc.view(r.cardId)!;
    expect(after.card.materialHash).toBe(before.card.materialHash);
    expect(after.card.approvalValid).toBe(true);
  });
  it('quiet moves lanes at read time', () => {
    const t = makeService();
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    // A pending pickup exists for the owner-written card, so it is not quiet yet.
    expect(t.svc.view(r.cardId)!.status).toBe('with-agent');
  });
});

describe('transcript lines', () => {
  it('server lines start "Work board:" and the line id is derived from the record id', () => {
    const line = transcriptLineFor('tap', { action: 'approve', by: { kind: 'person', personKey: 'justin', proof: 'pin' }, at: '2026-11-12T20:00:00Z' }, { name: () => 'Justin', when: () => '12:00' });
    expect(line).toBe('Work board: approved by Justin · 12:00');
    expect(lineIdFor('wc:x')).toBe(lineIdFor('wc:x'));
    const ans = transcriptLineFor('tap', { action: 'answer', answer: 'y'.repeat(200), by: { kind: 'person', personKey: 'justin', proof: 'pin' }, at: 'x' }, { name: () => 'Justin', when: () => 'w' })!;
    expect(ans.length).toBeLessThan(200);
  });
});

describe('graduation (Maturation plan)', () => {
  it('nothing is due before day 7; day 7 then day 14 are written once each, from the store', () => {
    const t = makeService();
    expect(t.svc.graduationState()).toMatchObject({ pilotStartedAt: null, due: [] });
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    t.advance(6 * 86_400_000);
    expect(t.svc.graduationState().due).toEqual([]);
    t.advance(2 * 86_400_000);
    expect(t.svc.graduationState().due).toEqual([7]);
    expect(t.svc.graduationPass()).toMatchObject({ written: [7] });
    expect(t.svc.graduationPass()).toMatchObject({ written: [] });
    t.advance(7 * 86_400_000);
    expect(t.svc.graduationPass()).toMatchObject({ written: [14] });
    const st = t.svc.graduationState();
    expect(st.records.map((x) => x.day).sort()).toEqual([14, 7]);
    expect(st.due).toEqual([]);
    t.svc.rebuild();
    expect(t.svc.graduationState().records).toHaveLength(2);
  });
  it('a week with no cards in the window is incomplete, never a pass; an open pickup is counted as not closed', () => {
    const t = makeService();
    expect(t.svc.graduationMetrics(7).decision).toBe('incomplete');
    const r = t.svc.createCard(OWNER, card); if (!r.ok) throw new Error('create');
    const g = t.svc.graduationMetrics(7);
    expect(g.decision).toBe('measured');
    expect(g.metrics).toMatchObject({ cards: 1, pickupCauses: 1, pickupCausesClosed: 0, everyCauseClosed: false });
  });
  it('a graduation record cannot be written by the agent or a person through the store schema', () => {
    const bad = { recordKey: 'wb-graduation:day7', recordType: 'graduation', by: { kind: 'agent' }, at: '2026-11-12T20:00:00Z', day: 7, decision: 'measured', metrics: {} };
    expect(workCardRecordStoreSchema.validate(bad, { countDroppedField: () => {}, countJailReject: () => {} } as never)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...bad, by: { kind: 'system' }, decision: 'pass' }, { countDroppedField: () => {}, countJailReject: () => {} } as never)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...bad, by: { kind: 'system' } }, { countDroppedField: () => {}, countJailReject: () => {} } as never)).not.toBeNull();
  });
  it('a malformed write is the caller\'s mistake (400 invalid-record), never "store unavailable"', () => {
    const t = makeService();
    for (const bad of [{ ...card, need: undefined }, { ...card, links: [{ label: 'x', url: 'http://insecure.example' }] }, { ...card, doneWhen: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, { ...card, due: 'tomorrow' }]) {
      expect(t.svc.createCard(AGENT, bad as never)).toMatchObject({ ok: false, status: 400, error: 'invalid-record' });
    }
    expect(t.journal).toHaveLength(0);
  });
  it('identifier-shaped fields are credential-checked too', () => {
    const t = makeService();
    expect(t.svc.createCard(AGENT, { ...card, source: { conversationKey: 'app:x', messageId: 'sk-ant-abcdefghijklmnop' } })).toMatchObject({ ok: false, error: 'credential-refused', detail: { field: 'source.messageId' } });
  });
  it('the agent names the team owner as "owner"; the server resolves who that is', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, { ...card, carrier: 'owner' }); if (!r.ok) throw new Error('create');
    expect(t.svc.view(r.cardId)!.card.carrier).toEqual({ personKey: 'justin' });
    const o = t.svc.createCard(OWNER, card); if (!o.ok) throw new Error('create');
    const q = t.svc.setWaitingOn(AGENT, o.cardId, { principal: 'owner', question: { text: 'Which?' } });
    expect(q.ok).toBe(true);
    expect(t.svc.view(o.cardId)!.card.openQuestion?.principal).toEqual({ personKey: 'justin' });
  });
});
