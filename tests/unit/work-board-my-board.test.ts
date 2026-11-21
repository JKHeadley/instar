/**
 * My board (docs/specs/work-board-my-board.md): each person's board shows only the cards that need them, each card
 * once under its most pressing reason (approval > reply > own > added; a held card under "Held for later"), and in
 * every section untouched cards first, then started ones, newest activity first.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal, type CardView } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { boardJson, myBoardReason, MY_BOARD_WORDS, MY_BOARD_ORDER } from '../../src/core/workBoardViews.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const OWNER_VIEW = { personKey: 'justin', isOwner: true, isAgent: false };
const AGENT_VIEW = { personKey: 'justin', isOwner: false, isAgent: true };
const MEMBER_VIEW = { personKey: 'ana', isOwner: false, isAgent: false };
const name = (k: string) => (k === 'justin' ? 'Justin' : k);

function makeService() {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-18T10:00:00Z');
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
    detectCredential: () => null,
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: name,
  });
  return { svc, advance: (ms: number) => { clock += ms; } };
}

const base = { need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked', certify: 'agent-may-certify' }], outward: false };
type Sections = Array<{ reason: string; words: string; cardIds: string[]; notStarted: number; more?: number }>;
const sectionsOf = (b: Record<string, unknown>) => (b.myBoard as { sections: Sections }).sections;
const section = (b: Record<string, unknown>, reason: string) => sectionsOf(b).find((s) => s.reason === reason)!;

function make(t: ReturnType<typeof makeService>, title: string, extra: Record<string, unknown> = {}, by: WorkPrincipal = AGENT): string {
  const r = t.svc.createCard(by, { ...base, title, ...extra }); if (!r.ok) throw new Error(`create ${title}: ${r.error}`);
  t.advance(1000);
  return r.cardId;
}
function approve(t: ReturnType<typeof makeService>, id: string) {
  const r = t.svc.tap(OWNER, id, { action: 'approve', materialHash: t.svc.view(id)!.card.materialHash }); if (!r.ok) throw new Error(`approve: ${r.error}`);
  t.advance(1000);
}

describe('My board: each card once, under its most pressing reason', () => {
  it('sorts the owner\'s cards into approval, reply, own and held; cards with the agent and finished cards are not on it', () => {
    const t = makeService();
    const needsApproval = make(t, 'Needs approval');
    const asks = make(t, 'Asks a question'); approve(t, asks);
    const q = t.svc.setWaitingOn(AGENT, asks, { principal: { personKey: 'justin' }, question: { text: 'Which hall?' } }); if (!q.ok) throw new Error('q');
    t.advance(1000);
    const mine = make(t, 'Carried by Justin', { carrier: { personKey: 'justin' } }, OWNER);
    const held = make(t, 'Held'); t.svc.tap(OWNER, held, { action: 'hold' }); t.advance(1000);
    const working = make(t, 'Agent working'); approve(t, working);
    const finished = make(t, 'Finished'); t.svc.tap(OWNER, finished, { action: 'archive', closeAs: 'done', note: 'Booked it' }); t.advance(1000);

    const b = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 30 });
    expect(section(b, 'approval').cardIds).toEqual([needsApproval]);
    expect(section(b, 'reply').cardIds).toEqual([asks]);
    expect(section(b, 'own').cardIds).toEqual([mine]);
    expect(section(b, 'held').cardIds).toEqual([held]);
    expect(section(b, 'added').cardIds).toEqual([]);
    const all = sectionsOf(b).flatMap((s) => s.cardIds);
    expect(new Set(all).size).toBe(all.length); // each card once
    expect(all).not.toContain(working);
    expect(all).not.toContain(finished);
  });

  it('lists every section in a fixed order with its words, so a client can hide the empty ones', () => {
    const t = makeService();
    const b = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 30 });
    expect(sectionsOf(b).map((s) => [s.reason, s.words])).toEqual(MY_BOARD_ORDER.map((r) => [r, MY_BOARD_WORDS[r]]));
    expect(MY_BOARD_WORDS).toEqual({ approval: 'Waiting for your approval', reply: 'Waiting for your reply', own: 'Your cards', added: 'Cards you were added to', held: 'Held for later' });
  });

  it('approval outranks your own card: a card Justin carries that still needs his approve tap sits under approval', () => {
    const t = makeService();
    const id = make(t, 'Outward and mine', { carrier: { personKey: 'justin' }, outward: true }, OWNER);
    const b = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 30 });
    expect(t.svc.view(id)!.status).toBe('needs-approval');
    expect(section(b, 'approval').cardIds).toEqual([id]);
    expect(section(b, 'own').cardIds).toEqual([]);
  });

  it('the agent reading on the owner\'s behalf gets the owner\'s board', () => {
    const t = makeService();
    const id = make(t, 'Needs approval');
    const b = boardJson(t.svc, AGENT_VIEW, () => true, name, { softOpenCards: 30 });
    expect(section(b, 'approval').cardIds).toEqual([id]);
  });
});

describe('My board for a team member: only what was shared with them', () => {
  it('a card whose conversation was shared is one they were added to; a card not shared does not exist for them', () => {
    const t = makeService();
    const shared = make(t, 'Shared');
    const hidden = make(t, 'Not shared');
    const sharedKey = t.svc.view(shared)!.card.conversationKey;
    const b = boardJson(t.svc, MEMBER_VIEW, (ck) => ck === sharedKey, name, { softOpenCards: 30 });
    expect(section(b, 'added').cardIds).toEqual([shared]);
    expect(section(b, 'approval').cardIds).toEqual([]); // only the owner approves in this phase
    expect(sectionsOf(b).flatMap((s) => s.cardIds)).not.toContain(hidden);
  });

  it('a question addressed to the member is theirs to reply to; one addressed to the owner is not', () => {
    const t = makeService();
    const id = make(t, 'Asks'); approve(t, id);
    const v = t.svc.view(id)!;
    const askAna = { ...v, status: 'waiting-on-person', card: { ...v.card, openQuestion: { id: 'q1', text: 'Ana?', principal: { personKey: 'ana' }, state: 'open', at: '' } } } as unknown as CardView;
    const askJustin = { ...askAna, card: { ...askAna.card, openQuestion: { ...askAna.card.openQuestion!, principal: { personKey: 'justin' } } } } as unknown as CardView;
    expect(myBoardReason(askAna, MEMBER_VIEW, 'waiting-on-you')).toBe('reply');
    expect(myBoardReason(askJustin, MEMBER_VIEW, 'waiting-on-others')).toBe('added');
    // The owner's view of a question put to a member: still on his board (his lane says waiting on you), but not as his reply.
    expect(myBoardReason(askAna, OWNER_VIEW, 'waiting-on-you')).toBe('own');
    expect(myBoardReason(askJustin, OWNER_VIEW, 'waiting-on-you')).toBe('reply');
    expect(myBoardReason(askJustin, MEMBER_VIEW, 'done')).toBeNull();
    // A solo agent with no team record: the owner's read has no personKey, and he is the only person a question can be put to.
    expect(myBoardReason(askJustin, { personKey: null, isOwner: true, isAgent: false }, 'waiting-on-you')).toBe('reply');
    // A hold outranks everything else (a held card that also needs approval is listed as held).
    expect(myBoardReason({ ...v, status: 'held' } as CardView, OWNER_VIEW, 'waiting-on-you')).toBe('held');
  });
});

describe('order inside a section, and the soft cut', () => {
  it('untouched cards first, then started ones; each group newest activity first', () => {
    const t = makeService();
    const a = make(t, 'A'); const b2 = make(t, 'B'); const c = make(t, 'C'); const d = make(t, 'D');
    // B and D are started (a person tapped them); A and C are untouched. Hold-then-release starts a card and leaves it waiting.
    for (const id of [b2, d]) {
      t.svc.tap(OWNER, id, { action: 'hold' }); t.advance(1000);
      const r = t.svc.tap(OWNER, id, { action: 'unhold', names: t.svc.view(id)!.card.holds[0] }); if (!r.ok) throw new Error(`unhold: ${r.error}`);
      t.advance(1000);
    }
    const board = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 30 });
    const s = section(board, 'approval');
    expect(s.cardIds).toEqual([c, a, d, b2]);
    expect(s.notStarted).toBe(2);
  });

  it('cards with the same activity time are cut by card id, so every machine keeps the same ones', () => {
    const t = makeService();
    const ids = ['A', 'B', 'C'].map((title) => { const r = t.svc.createCard(AGENT, { ...base, title }); if (!r.ok) throw new Error(title); return r.cardId; });
    const board = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 2 });
    expect([...section(board, 'approval').cardIds].sort()).toEqual([...ids].sort().slice(0, 2));
  });

  it('a card cut from the waiting lane by the soft budget is counted as more, never listed by an id the read does not carry', () => {
    const t = makeService();
    make(t, 'One'); make(t, 'Two'); make(t, 'Three');
    const board = boardJson(t.svc, OWNER_VIEW, () => true, name, { softOpenCards: 2 });
    const carried = new Set((board.lanes as Array<{ cards: Array<{ id: string }> }>).flatMap((l) => l.cards.map((c) => c.id)));
    const s = section(board, 'approval');
    expect(s.cardIds.length).toBe(2);
    expect(s.more).toBe(1);
    for (const id of s.cardIds) expect(carried.has(id)).toBe(true);
    // For the owner every waiting card gets a reason, so the sections' more add up to the lane's more.
    const laneMore = (board.lanes as Array<{ lane: string; more?: number }>).find((l) => l.lane === 'waiting-on-you')!.more ?? 0;
    expect(sectionsOf(board).reduce((n, x) => n + (x.more ?? 0), 0)).toBe(laneMore);
  });
});
