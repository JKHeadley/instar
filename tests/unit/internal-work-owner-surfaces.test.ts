import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal, type CardView } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, requestTextHashOf, laneFor, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { sourceCardsJson } from '../../src/core/workSourceCards.js';
import { cardJson, boardJson, needLine } from '../../src/core/workBoardViews.js';
import { workBoardNeedRows } from '../../dashboard/console/work-model.js';
const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const SERVER: WorkPrincipal = { kind: 'agent', server: true };
const viewer = { personKey: 'justin', isOwner: true, isAgent: false };
const name = (key: string) => key;
function makeService(over: Record<string, unknown> = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-20T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings(over);
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
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  svc.rebuild();
  return { svc, journal, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const work = { title: 'Keep the registry current', need: 'Keep the registry current', carrier: 'agent', outward: false, doneWhen: [{ id: 'd1', text: 'Updated and checked', certify: 'agent-may-certify' }] };
function create(t: ReturnType<typeof makeService>, extra: Record<string, unknown> = {}, server = false) {
  const result = t.svc.createCard(server ? SERVER : AGENT, { ...work, ...extra });
  if (!result.ok) throw new Error(result.error);
  return t.svc.view(result.cardId)!;
}
const json = (t: ReturnType<typeof makeService>, v: CardView) => cardJson(t.svc, v, viewer, name);
const all = (b: any) => b.lanes.flatMap((l: any) => l.cards);
describe('Internal cards stay off owner surfaces', () => {
  it('filters source-linked internal cards before totals and source revision', () => {
    const t = makeService(); const source = { conversationKey: 'telegram:42', messageId: '1001' };
    const baseline = sourceCardsJson(t.svc, viewer, source.conversationKey, 0, name);
    create(t, { source });
    const hidden = sourceCardsJson(t.svc, viewer, source.conversationKey, 0, name);
    expect(hidden.cards).toEqual([]); expect(hidden.total).toBe(0);
    expect(hidden.sourceRevision).toBe(baseline.sourceRevision);
    const ask = create(t, { source, outward: true, recommendation: 'Renew the service', whyYou: 'A spending decision is needed' });
    expect(sourceCardsJson(t.svc, viewer, source.conversationKey, 0, name).cards.map(c => c.id)).toEqual([ask.card.cardId]);
  });
  it('describes withdrawn internal approval without instructing the owner to approve again', () => {
    const t = makeService(); const v = create(t);
    expect(t.svc.tap(OWNER, v.card.cardId, { action: 'approve', materialHash: v.card.materialHash }).ok).toBe(true);
    expect(t.svc.tap(OWNER, v.card.cardId, { action: 'withdraw-approval' }).ok).toBe(true);
    const latest = t.svc.view(v.card.cardId)!;
    expect(latest.status).toBe('needs-approval');
    expect(json(t, latest).agentInternal).toBe(true);
    expect(needLine(latest)).toBe('Agent work is stopped after approval was withdrawn.');
  });
  it('keeps an internal card internal when it includes an agent recommendation', () => {
    const t = makeService(); const v = create(t, { recommendation: 'Use the current model', whyYou: 'Routine registry maintenance' });
    expect(json(t, v)).toMatchObject({ agentInternal: true, ownerAction: false });
    expect(all(boardJson(t.svc, { personKey: null, isOwner: false, isAgent: true }, () => true, name, {
      softOpenCards: 30, agentCardsOnly: true,
    })).map((c: any) => c.id)).toContain(v.card.cardId);
    expect(t.svc.view(v.card.cardId)?.card.approvalValid).toBe(v.card.approvalValid);
    expect(all(boardJson(t.svc, viewer, () => true, name, { softOpenCards: 30 })).map((c: any) => c.id)).not.toContain(v.card.cardId);
    expect(t.svc.hiddenConversationKeys().has(v.card.conversationKey)).toBe(true);
  });
  it('keeps a future owner confirmation in agent work until a claim actually needs it', () => {
    const t = makeService();
    const v = create(t, {
      recommendation: 'Use the current model',
      whyYou: 'Routine registry maintenance',
      doneWhen: [{ id: 'd1', text: 'Review the completed work', certify: 'owner-confirms' }],
    });
    expect(v.card).toMatchObject({ approvalRequired: true, approvalValid: false, workable: false, currentClaim: null });
    expect(laneFor(v.status, true, v.card, 'justin')).toBe('with-agent');
    expect(json(t, v)).toMatchObject({ agentInternal: true, ownerAction: false });
    const owner = boardJson(t.svc, viewer, () => true, name, { softOpenCards: 30, full: true });
    expect(owner.waitingOnYou).toBe(0);
    expect(workBoardNeedRows({ ok: true, data: owner })).toEqual([]);
    const agent = boardJson(t.svc, { ...viewer, isAgent: true }, () => true, name, { softOpenCards: 30, agentCardsOnly: true, full: true });
    expect(all(agent)).toEqual([expect.objectContaining({ id: v.card.cardId, lane: 'with-agent', ownerAction: false })]);
    const claimed = { ...v.card, currentClaim: { id: 'claim' }, needsConfirm: true } as typeof v.card;
    expect(laneFor('claims-done', true, claimed, 'justin')).toBe('waiting-on-you');
    expect(t.svc.view(v.card.cardId)?.card).toMatchObject({ approvalRequired: true, approvalValid: false, workable: false });
  });

  it('classifies pure agent work but keeps verified requester provenance separate', () => {
    const t = makeService(); const internal = create(t);
    expect(json(t, internal).agentInternal).toBe(true);
    const need = 'Please update the registry.';
    const requested = create(t, { title: 'Requested registry update', need, requester: { personKey: 'justin', isOwner: true }, requestTextHash: requestTextHashOf(need), recordedAsHash: requestTextHashOf(need) }, true);
    expect(requested.card.agentWork).toBe(true);
    expect(json(t, requested).agentInternal).toBe(false);
    expect(requested.card.requestApproved).toBe(true);
  });
  it('filters internal cards before default board cuts and counts, including full reads', () => {
    const t = makeService();const internal = create(t);
    const ask = create(t, { title: 'Approve a purchase', outward: true, recommendation: 'Buy the approved service', whyYou: 'This spends money' });
    for (const full of [false, true]) {
      const b = boardJson(t.svc, viewer, () => true, name, { softOpenCards: 1, full });
      expect(all(b).map((c: any) => c.id)).toEqual([ask.card.cardId]);
      expect(b.waitingOnYou).toBe(1);
      expect(b.notStartedCards).toMatchObject({ count: 0, cardIds: [] });
      expect(JSON.stringify(b)).not.toContain(internal.card.cardId);
    }
  });
  it('returns internal cards only in the deliberate agent view', () => {
    const t = makeService();const internal = create(t);
    create(t, { title: 'Approve a purchase', outward: true, recommendation: 'Buy it', whyYou: 'This spends money' });
    const b = boardJson(t.svc, viewer, () => true, name, { softOpenCards: 1, agentCardsOnly: true });
    expect(all(b).map((c: any) => c.id)).toEqual([internal.card.cardId]);
    expect(b.waitingOnYou).toBe(0);
    expect(all(b)[0].agentInternal).toBe(true);
  });
  it.each(['not-started', 'held', 'quiet', 'parked', 'unknown', 'needs-approval'] as const)('keeps internal %s and capacity waits out of owner attention', status => {
    const t = makeService(); const v = create(t);
    expect(laneFor(status, true, v.card, 'justin', false)).toBe('with-agent');
    expect(laneFor(status, true, v.card, 'justin', true)).toBe('with-agent');
  });
  it('preserves a genuine member request requiring the owner approval', () => {
    const t = makeService();const need = 'Please update the registry.';
    const v = create(t, { need, requester: { personKey: 'adriana', isOwner: false }, requestTextHash: requestTextHashOf(need), recordedAsHash: requestTextHashOf(need) }, true);
    expect(json(t, v).agentInternal).toBe(false);
    expect(laneFor(v.status, true, v.card, 'justin')).toBe('waiting-on-you');
    expect(needLine(v)).toBe('Needs your approval before the agent starts');
  });
  it('does not turn requested agent progress or quiet/capacity into another owner decision', () => {
    const t = makeService();const need='Please update the registry.';
    const v=create(t,{need,requester:{personKey:'justin',isOwner:true},requestTextHash:requestTextHashOf(need),recordedAsHash:requestTextHashOf(need)},true);
    expect(laneFor('quiet',true,v.card,'justin',true)).toBe('with-agent');
  });
  it('retains legacy owner questions and confirmations even if agentWork remains true', () => {
    const t=makeService();const v=create(t);
    const question={...v,status:'waiting-on-person',card:{...v.card,openQuestion:{id:'q',text:'Which deadline?',principal:{personKey:'justin'},state:'open',at:''}}} as unknown as CardView;
    expect(json(t,question).agentInternal).toBe(false);
    expect(laneFor(question.status,true,question.card,'justin')).toBe('waiting-on-you');
    const claim={...v,status:'claims-done',card:{...v.card,currentClaim:{id:'claim'},needsConfirm:true}} as unknown as CardView;
    expect(json(t,claim).agentInternal).toBe(false);
    expect(laneFor(claim.status,true,claim.card,'justin')).toBe('waiting-on-you');
  });
  it('hides old empty internal chats while preserving requester-backed conversation access', () => {
    const t=makeService();const internal=create(t);const need='Please update the registry.';
    const requested=create(t,{need,requester:{personKey:'justin',isOwner:true},requestTextHash:requestTextHashOf(need),recordedAsHash:requestTextHashOf(need)},true);
    expect(t.svc.hiddenConversationKeys().has(internal.card.conversationKey)).toBe(true);
    expect(t.svc.hiddenConversationKeys().has(requested.card.conversationKey)).toBe(false);
  });
  it('says the real policy-blocked state without asking the owner', () => {
    const t=makeService();const internal=create(t);
    expect(needLine(internal)).toBe('The agent has not started this under the current board policy.');
    expect(needLine(internal)).not.toMatch(/your approval/);
    expect(t.svc.stats.notStartedRefusals).toBe(0);
  });
  it('never creates a Needs-you aggregate from internal not-started diagnostic data', () => {
    const lanes=['waiting-on-you','with-agent','waiting-on-others','done','archived'].map(lane=>({lane,cards:[]}));
    const result=workBoardNeedRows({ok:true,data:{lanes,waitingOnYou:0,policy:'every-agent-card',notStartedCards:{count:35,cardIds:['internal'],shown:[],more:35}}});
    expect(result).toEqual([]);
  });
});
