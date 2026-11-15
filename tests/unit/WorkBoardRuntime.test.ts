/**
 * Work Board runtime (docs/specs/work-board-asks.md §2, §6, Multi-machine posture) — two machines
 * replicating to each other through the same records:
 *   a card created on the standby gets ONE conversation; a tap on the non-owning machine is
 *   dispatched once, by the owner; each machine writes one ledger note per hand-over, carrying no
 *   title, and a ledger that throws does not fail the pickup; an edit replicated after dispatch
 *   causes a stop; a hold that lands during the durability wait stops the work brief; a redact is
 *   honoured by the other machine's reads; "previous owner caught up" by its exact definition;
 *   `behind`; server-written lines pass the credential guard; the 64 MB signal fires once.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { workCardRecordStoreSchema, WORK_CARD_RECORD_KIND, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { WorkPrincipal } from '../../src/core/WorkBoardService.js';
import type { DeliverOutcome } from '../../src/core/WorkBoardPickupController.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const CARD = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false };

interface Machine {
  id: string; rt: WorkBoardRuntime; journal: UnionEntry[]; conversations: Map<string, string[]>; briefs: string[]; stops: string[]; notes: string[]; degr: string[];
  setServes: (b: boolean) => void; setLive: (b: boolean) => void; holder: { current: string | null }; durable: { hook: (() => void) | null }; bytes: { n: number };
}

const world = { clock: Date.parse('2026-11-12T20:00:00Z'), logical: 0 };

function machine(id: string, opts: { serves: boolean; ledgerThrows?: boolean; deliver?: () => DeliverOutcome } = { serves: true }): Machine {
  const journal: UnionEntry[] = []; const conversations = new Map<string, string[]>();
  const briefs: string[] = []; const stops: string[] = []; const notes: string[] = []; const degr: string[] = [];
  let serves = opts.serves; let live = false;
  const holder = { current: null as string | null }; const durable = { hook: null as (() => void) | null }; const bytes = { n: 0 };
  const seams: WorkBoardRuntimeSeams = {
    machineId: id, enabled: () => true, rawSettings: () => ({}), saveSettings: () => true,
    emit: (_k, build) => {
      const hlc: HlcTimestamp = { physical: (world.clock += 1000), logical: world.logical++, node: id };
      const data = build(hlc, id); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) throw new Error(`invalid ${JSON.stringify(data)}`);
      journal.push({ data, origin: id });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    awaitDurable: async () => { durable.hook?.(); },
    loadUnion: () => journal,
    journalBytes: () => bytes.n,
    conversation: {
      create: (_cardId, key) => { if (!conversations.has(key)) conversations.set(key, []); },
      exists: (key) => conversations.has(key),
      appendSystemLine: (key, _id, text) => { conversations.get(key)?.push(text); },
      remove: (key) => { conversations.delete(key); },
      serves: () => serves, aliasFor: () => 7, hasLiveSession: () => live,
      dispatchSystem: async (input) => { briefs.push(input.text); return opts.deliver ? opts.deliver() : { outcome: 'spawned' }; },
      injectLive: (_alias, line) => { stops.push(line); return live; },
      attachment: () => null, lastPersonMessageAt: () => null,
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }),
    ownerPersonKey: () => 'justin', displayName: () => 'Justin', timezone: () => 'America/Los_Angeles',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    ledgerNote: (cardId, causeId) => { if (opts.ledgerThrows) throw new Error('ledger off'); notes.push(`${cardId}|${causeId}`); },
    degradation: (e) => { degr.push(e); }, leaseHolder: () => holder.current, now: () => world.clock,
  };
  const rt = new WorkBoardRuntime(seams);
  rt.start(); rt.controller.stop(); // the tests drive ticks themselves
  return { id, rt, journal, conversations, briefs, stops, notes, degr, setServes: (b) => { serves = b; }, setLive: (b) => { live = b; }, holder, durable, bytes };
}

/** Deliver every record `from` has written that `to` has not yet seen (journal sync). */
function sync(from: Machine, to: Machine, seen: { n: number }) {
  const fresh = from.journal.slice(seen.n); seen.n = from.journal.length;
  if (fresh.length) to.rt.onCommitted(fresh.map((e) => ({ data: e.data })), from.id);
}
async function settle(...ms: Machine[]) { for (let i = 0; i < 3; i++) for (const m of ms) await m.rt.controller.tick(); }

describe('two machines', () => {
  it('a card created on the standby gets one conversation on each machine, under the same derived key', async () => {
    const owner = machine('m_owner', { serves: true }); const standby = machine('m_standby', { serves: false });
    const c = standby.rt.svc.createCard(AGENT, CARD); if (!c.ok) throw new Error('c');
    standby.rt.ensureConversation(c.cardId); standby.rt.ensureConversation(c.cardId);
    expect(standby.conversations.size).toBe(1);
    sync(standby, owner, { n: 0 });
    expect([...owner.conversations.keys()]).toEqual([c.conversationKey]);
    expect([...standby.conversations.keys()]).toEqual([c.conversationKey]);
  });

  it('a tap on the non-owning machine is dispatched once, by the owner; each machine notes the hand-over once, with no title', async () => {
    const owner = machine('m_owner', { serves: true }); const standby = machine('m_standby', { serves: false });
    const a = { n: 0 }; const b = { n: 0 };
    const c = standby.rt.svc.createCard(AGENT, CARD); if (!c.ok) throw new Error('c');
    const tap = standby.rt.svc.tap(OWNER, c.cardId, { action: 'approve', materialHash: standby.rt.svc.view(c.cardId)!.card.materialHash });
    expect(tap.ok).toBe(true);
    await settle(standby);
    expect(standby.briefs).toHaveLength(0); // the standby does not serve the conversation
    sync(standby, owner, a);
    await settle(owner);
    expect(owner.briefs).toHaveLength(1);
    sync(owner, standby, b); sync(owner, standby, b);
    await settle(owner, standby);
    expect(owner.briefs).toHaveLength(1); expect(standby.briefs).toHaveLength(0);
    expect(owner.notes).toHaveLength(1); expect(standby.notes).toHaveLength(1);
    for (const n of [...owner.notes, ...standby.notes]) { expect(n.startsWith(c.cardId)).toBe(true); expect(n).not.toContain('Pick a venue'); }
    expect(standby.rt.svc.view(c.cardId)!.pickups.find((p) => p.cause.kind === 'work')!.status).toBe('settled');
  });

  it('a ledger that throws does not fail the pickup', async () => {
    const m = machine('m_owner', { serves: true, ledgerThrows: true });
    const c = m.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    await settle(m);
    expect(m.briefs).toHaveLength(1);
    expect(m.rt.svc.view(c.cardId)!.pickups[0].closed).toBe('spawned');
  });

  it('an edit made on another machine that arrives after dispatch causes a stop and voids the approval', async () => {
    const owner = machine('m_owner', { serves: true }); const other = machine('m_other', { serves: false });
    const a = { n: 0 }; const b = { n: 0 };
    const c = owner.rt.svc.createCard(AGENT, CARD); if (!c.ok) throw new Error('c');
    sync(owner, other, a);
    // The other machine edits the need while the owner approves and dispatches.
    expect(other.rt.svc.edit(AGENT, c.cardId, { need: 'A different need' }).ok).toBe(true);
    owner.rt.svc.tap(OWNER, c.cardId, { action: 'approve', materialHash: owner.rt.svc.view(c.cardId)!.card.materialHash });
    owner.setLive(true);
    await settle(owner);
    expect(owner.briefs, JSON.stringify(owner.rt.svc.view(c.cardId)!.pickups.map((p) => ({ k: p.cause.kind, s: p.status, c: p.closed, r: p.closedReason, a: p.attempts })))).toHaveLength(1);
    sync(other, owner, b);
    await settle(owner);
    expect(owner.rt.svc.view(c.cardId)!.card.approvalValid).toBe(false);
    expect(owner.stops).toHaveLength(1);
    expect(owner.stops[0]).toContain('system:work-board');
    expect(owner.briefs).toHaveLength(1);
  });

  it('a hold that lands during the durability wait stops the work brief', async () => {
    const m = machine('m_owner', { serves: true });
    const c = m.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    m.durable.hook = () => { m.durable.hook = null; m.rt.svc.tap(OWNER, c.cardId, { action: 'hold' }); };
    await settle(m);
    expect(m.briefs).toHaveLength(0);
    expect(m.rt.svc.view(c.cardId)!.status).toBe('held');
  });

  it('a redact on one machine is honoured by the other machine\'s reads and removes its conversation text source', async () => {
    const owner = machine('m_owner', { serves: true }); const other = machine('m_other', { serves: false });
    const a = { n: 0 };
    const c = owner.rt.svc.createCard(OWNER, { ...CARD, title: 'Sensitive' }); if (!c.ok) throw new Error('c');
    owner.rt.svc.tap(OWNER, c.cardId, { action: 'redact' });
    sync(owner, other, a);
    const v = other.rt.svc.view(c.cardId)!;
    expect(v.status).toBe('removed');
    expect(other.rt.svc.hiddenConversationKeys().has(c.conversationKey)).toBe(true);
    expect(other.rt.svc.edit(AGENT, c.cardId, { recommendation: 'x' })).toMatchObject({ ok: false, error: 'card-removed' });
    other.rt.ensureConversation(c.cardId);
    expect(other.conversations.has(c.conversationKey)).toBe(false); // a removed card never recreates its conversation
  });
});

describe('an answer that raced a replacement', () => {
  it('is voided with a line, and the session is never told the question was answered', async () => {
    const owner = machine('m_owner', { serves: true }); const other = machine('m_other', { serves: false });
    const a = { n: 0 }; const b = { n: 0 };
    owner.setLive(true);
    const c = owner.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    owner.rt.ensureConversation(c.cardId);
    await settle(owner);
    const q = owner.rt.svc.setWaitingOn(AGENT, c.cardId, { principal: { personKey: 'justin' }, question: { text: 'Which?' } }); if (!q.ok) throw new Error('q');
    sync(owner, other, a);
    // The other machine replaces the question; before that arrives, the owner answers the old one here.
    const q2 = other.rt.svc.setWaitingOn(AGENT, c.cardId, { principal: { personKey: 'justin' }, question: { text: 'Budget?' }, supersedes: q.questionId, reason: 'need the budget first' }); if (!q2.ok) throw new Error('q2');
    const before = owner.briefs.length;
    expect(owner.rt.svc.tap(OWNER, c.cardId, { action: 'answer', questionId: q.questionId, answer: 'B' }).ok).toBe(true);
    sync(other, owner, b); // the replacement sorts BEFORE the answer tap
    await settle(owner);
    expect(owner.briefs.length).toBe(before);
    expect(owner.rt.svc.view(c.cardId)!.card.openQuestion?.text).toBe('Budget?');
    expect([...owner.conversations.values()].flat().some((l) => /answer no longer applies; the card changed first/.test(l))).toBe(true);
  });
});

describe('previous owner caught up (§6, the exact definition)', () => {
  const adv = (seq: number, inc = 'i1') => ({ [WORK_CARD_RECORD_KIND]: { incarnation: inc, lastSeq: seq } });
  it('needs an exchange completed AFTER the takeover that reaches the head it advertised, on the same incarnation', () => {
    const m = machine('m_new', { serves: true });
    m.holder.current = 'm_old'; m.rt.noteLeaseHolder();
    const takeover = world.clock;
    expect(m.rt.previousOwnerCaughtUp('any', takeover)).toBe(false); // no exchange at all
    m.rt.noteJournalExchange('m_old', adv(10), adv(10));
    expect(m.rt.previousOwnerCaughtUp('any', world.clock + 1)).toBe(false); // the exchange predates the takeover
    world.clock += 5000;
    m.rt.noteJournalExchange('m_old', adv(10), adv(7));
    expect(m.rt.previousOwnerCaughtUp('any', takeover)).toBe(false); // behind the advertised head (a gap)
    world.clock += 5000;
    m.rt.noteJournalExchange('m_old', adv(10, 'i2'), adv(10, 'i1'));
    expect(m.rt.previousOwnerCaughtUp('any', takeover)).toBe(false); // a different incarnation
    world.clock += 5000;
    m.rt.noteJournalExchange('m_old', adv(10), adv(10));
    expect(m.rt.previousOwnerCaughtUp('any', takeover)).toBe(true);
  });
  it('a peer that advertised no work-card stream holds nothing to wait for; with no previous owner there is no wait', () => {
    const m = machine('m_solo', { serves: true });
    expect(m.rt.previousOwnerCaughtUp('any', world.clock)).toBe(true);
    m.holder.current = 'm_old'; m.rt.noteLeaseHolder();
    const t = world.clock; world.clock += 1000;
    m.rt.noteJournalExchange('m_old', {}, {});
    expect(m.rt.previousOwnerCaughtUp('any', t)).toBe(true);
  });
  it('behind names a machine whose stream this one has not caught up with for more than a sync interval', () => {
    const m = machine('m_x', { serves: true });
    m.rt.noteJournalExchange('m_peer', adv(20), adv(12));
    expect(m.rt.behind()).toBeNull();
    world.clock += 120_000;
    expect(m.rt.behind()).toMatchObject({ machineId: 'm_peer' });
    m.rt.noteJournalExchange('m_peer', adv(20), adv(20));
    world.clock += 120_000;
    expect(m.rt.behind()).toBeNull();
  });
  it('a lease change re-arms a failure park once', async () => {
    const m = machine('m_o', { serves: true, deliver: () => ({ outcome: 'refused', reason: 'nope' }) });
    const c = m.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    await settle(m); await settle(m);
    expect(m.briefs).toHaveLength(3);
    m.holder.current = 'm_o'; m.rt.noteLeaseHolder(); await settle(m);
    m.holder.current = 'm_other'; m.rt.noteLeaseHolder(); m.holder.current = 'm_o'; m.rt.noteLeaseHolder(); await settle(m);
    expect(m.briefs).toHaveLength(4);
    expect(m.rt.svc.view(c.cardId)!.status).toBe('parked');
  });
});

describe('lines and signals', () => {
  it('a server-written line that would carry a credential is not appended', () => {
    const m = machine('m_l', { serves: true });
    const c = m.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    m.rt.ensureConversation(c.cardId);
    m.rt.appendLine(c.conversationKey, 'wb-1', 'Work board: Justin answered "sk-ant-abcdefghijklmnop"');
    m.rt.appendLine(c.conversationKey, 'wb-2', 'Work board: approved by Justin');
    expect(m.conversations.get(c.conversationKey)).toEqual(['Work board: approved by Justin']);
  });
  it('the journal-size signal fires once past 64 MB', () => {
    const m = machine('m_j', { serves: true });
    m.bytes.n = 65 * 1024 * 1024;
    m.rt.svc.createCard(OWNER, CARD); m.rt.onCommitted([], null);
    const other = machine('m_j2', { serves: false });
    const c = other.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    m.rt.onCommitted(other.journal.map((e) => ({ data: e.data })), 'm_j2');
    m.rt.onCommitted(other.journal.map((e) => ({ data: e.data })), 'm_j2');
    expect(m.degr.filter((e) => e === 'work-board-journal-large')).toHaveLength(1);
  });
  it('the daily ceiling follows the agent\'s timezone day and names when it resets', () => {
    const m = machine('m_tz', { serves: true });
    const d = m.rt.dayOf(Date.parse('2026-11-13T05:30:00Z')); // 21:30 on the 12th in Los Angeles
    expect(d.day).toBe('2026-11-12');
    expect(d.resetsAt).toBe('2026-11-13T08:00:00.000Z');
  });
  it('switched off live, the controller hands nothing over and writes nothing; switched back on, it does', async () => {
    let on = true;
    const base = machine('m_sw', { serves: true });
    // Rebuild a machine whose switch we control.
    const { WorkBoardRuntime } = await import('../../src/core/WorkBoardRuntime.js');
    const seams = (base.rt as unknown as { seams: WorkBoardRuntimeSeams }).seams;
    const rt = new WorkBoardRuntime({ ...seams, enabled: () => on });
    rt.start(); rt.controller.stop();
    const c = rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    on = false;
    const before = base.journal.length;
    for (let i = 0; i < 3; i++) await rt.controller.tick();
    expect(base.briefs).toHaveLength(0);
    expect(base.journal.length).toBe(before);
    expect(rt.hiddenConversationKeys().size).toBe(0);
    on = true;
    for (let i = 0; i < 3; i++) await rt.controller.tick();
    expect(base.briefs).toHaveLength(1);
  });
  it('a plain restart is not an ownership change: it does not spend a failure park\'s one automatic re-try', async () => {
    const m = machine('m_r', { serves: true, deliver: () => ({ outcome: 'refused', reason: 'nope' }) });
    m.holder.current = 'm_r';
    const c = m.rt.svc.createCard(OWNER, CARD); if (!c.ok) throw new Error('c');
    await settle(m); await settle(m);
    expect(m.rt.svc.view(c.cardId)!.status).toBe('parked');
    // "Restart": a fresh runtime over the same journal, the same holder.
    const { WorkBoardRuntime } = await import('../../src/core/WorkBoardRuntime.js');
    const seams = (m.rt as unknown as { seams: WorkBoardRuntimeSeams }).seams;
    const again = new WorkBoardRuntime(seams);
    again.start(); again.controller.stop();
    again.noteLeaseHolder(); again.noteLeaseHolder();
    for (let i = 0; i < 3; i++) await again.controller.tick();
    expect(m.journal.filter((e) => e.data.outcome === 'rearmed')).toHaveLength(0);
    expect(m.briefs).toHaveLength(3);
    expect(again.svc.view(c.cardId)!.status).toBe('parked');
  });
});
