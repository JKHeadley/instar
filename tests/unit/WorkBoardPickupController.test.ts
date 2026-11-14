/**
 * Work Board pickups (docs/specs/work-board-asks.md §6): every transition into workable causes
 * exactly one pickup; waiting for capacity writes nothing and never parks; three spending failures
 * park; a retry is one attempt; a stop never spawns; a crash between the durable intent and the
 * close yields a recovery brief (and parks an outward card); an ownership change re-tries a
 * failure park once; an agent that keeps changing the card parks; a redact voids everything.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { WorkBoardPickupController, type DeliverOutcome } from '../../src/core/WorkBoardPickupController.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const card = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false };

function rig(opts: { deliver?: () => DeliverOutcome; capacity?: () => { ok: true } | { ok: false; reason: string; retryAt?: number }; live?: boolean; caughtUp?: boolean } = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-12T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings({});
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_k, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a'); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) throw new Error(`invalid ${JSON.stringify(data)}`);
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: () => null, dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }), displayName: () => 'Justin',
  });
  const delivered: Array<{ brief: string }> = []; const stops: string[] = []; const lines: string[] = []; const notes: string[] = []; const degr: string[] = [];
  let live = opts.live ?? false;
  const ctl = new WorkBoardPickupController({
    svc, machineId: 'm_a', settings: () => settings.pickup, now: () => clock,
    ownsConversation: () => true, relayReady: () => true, admits: () => true, hasLiveSession: () => live,
    capacityProbe: opts.capacity ?? (() => ({ ok: true })), awaitDurable: async () => {},
    appendLine: async (_c, _id, t) => { lines.push(t); },
    deliver: async (_c, brief) => { delivered.push({ brief }); return opts.deliver ? opts.deliver() : { outcome: 'spawned' }; },
    injectStop: async (_c, brief) => { stops.push(brief); return live; },
    ledgerNote: (id) => { notes.push(id); }, degradation: (e) => { degr.push(e); },
    previousOwnerCaughtUp: () => opts.caughtUp ?? true, name: () => 'Justin', when: (s) => s,
  });
  return { svc, ctl, journal, delivered, stops, lines, notes, degr, advance: (ms: number) => { clock += ms; }, setLive: (b: boolean) => { live = b; } };
}

function approve(t: ReturnType<typeof rig>, id: string) {
  const r = t.svc.tap(OWNER, id, { action: 'approve', materialHash: t.svc.view(id)!.card.materialHash });
  if (!r.ok) throw new Error(JSON.stringify(r));
}

describe('pickups', () => {
  it('an approved card is handed over exactly once, with a pointer brief and a ledger note', async () => {
    const t = rig();
    const c = t.svc.createCard(AGENT, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(0); // needs approval
    approve(t, c.cardId);
    await t.ctl.tick(); await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0].brief).toContain(`GET /work-board/cards/${c.cardId}`);
    expect(t.delivered[0].brief).not.toContain('Choose one'); // no card text beyond the title
    expect(t.notes).toEqual([c.cardId]);
  });
  it('a pre-check refusal writes nothing, never parks, and honours a stated reset time', async () => {
    let n = 0;
    const t = rig({ capacity: () => { n++; return { ok: false, reason: 'quota', retryAt: Date.parse('2026-11-12T22:00:00Z') }; } });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    const before = t.journal.length;
    await t.ctl.tick(); await t.ctl.tick(); await t.ctl.tick();
    expect(t.journal.length).toBe(before);
    expect(n).toBe(1); // second and third ticks wait for the stated time
    t.advance(3 * 3_600_000);
    await t.ctl.tick();
    expect(n).toBe(2);
    expect(t.svc.view(c.cardId)!.status).not.toBe('parked');
    expect(t.ctl.status().waitingForCapacity).toBe(1);
  });
  it('a live session needs no free slot', async () => {
    const t = rig({ capacity: () => ({ ok: false, reason: 'full' }), live: true });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
  });
  it('three spending failures park, with one transcript line and a degradation event; a retry is exactly one attempt', async () => {
    const t = rig({ deliver: () => ({ outcome: 'refused', reason: 'spawn refused' }) });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    for (let i = 0; i < 5; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(3);
    const v = t.svc.view(c.cardId)!;
    expect(v.status).toBe('parked');
    expect(t.lines.filter((l) => l.startsWith('Work board: this could not be handed to the agent'))).toHaveLength(1);
    expect(t.degr).toContain('work-board-pickup-parked');
    const parkId = v.pickups.find((p) => p.status === 'parked')!.parkId!;
    expect(t.svc.tap(OWNER, c.cardId, { action: 'retry', retryOf: parkId }).ok).toBe(true);
    for (let i = 0; i < 3; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(4);
    expect(t.svc.view(c.cardId)!.status).toBe('parked');
  });
  it('the park and the count survive a restart (a fresh index from the journal)', async () => {
    const t = rig({ deliver: () => ({ outcome: 'refused', reason: 'nope' }) });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    for (let i = 0; i < 4; i++) await t.ctl.tick();
    t.svc.rebuild();
    for (let i = 0; i < 3; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(3);
  });
  it('an ownership change re-tries a failure park once and only once', async () => {
    const t = rig({ deliver: () => ({ outcome: 'refused', reason: 'nope' }) });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    for (let i = 0; i < 4; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(3);
    t.ctl.onOwnershipChange(); await t.ctl.tick(); await t.ctl.tick();
    t.ctl.onOwnershipChange(); await t.ctl.tick(); await t.ctl.tick();
    expect(t.delivered).toHaveLength(4);
  });
  it('a hold is a stop that reaches only a live session, and never spawns', async () => {
    const t = rig({ live: true });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    t.svc.tap(OWNER, c.cardId, { action: 'hold' });
    await t.ctl.tick();
    expect(t.stops).toHaveLength(1);
    expect(t.delivered).toHaveLength(1);
  });
  it('a crash between the durable intent and the close yields a recovery brief', async () => {
    const t = rig();
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    const cause = t.svc.view(c.cardId)!.pickups[0].cause;
    t.svc.writeSystem('dispatching', c.cardId, { for: cause.id, attempt: 1 }); // the machine died here
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0].brief).toContain('may already have been handed to a session');
    expect(t.svc.view(c.cardId)!.mayHaveBeenHandedOver).toBe(false);
  });
  it('the same crash on an outward card parks it for the person; their retry delivers the recovery brief', async () => {
    const t = rig();
    const c = t.svc.createCard(OWNER, { ...card, outward: true }); if (!c.ok) throw new Error('c');
    approve(t, c.cardId);
    const cause = t.svc.view(c.cardId)!.pickups.find((p) => p.cause.kind === 'work')!.cause;
    t.svc.writeSystem('dispatching', c.cardId, { for: cause.id, attempt: 1 });
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(0);
    const v = t.svc.view(c.cardId)!;
    expect(v.status).toBe('parked');
    expect(v.mayHaveBeenHandedOver).toBe(true);
    const parkId = v.pickups.find((p) => p.status === 'parked')!.parkId!;
    t.svc.tap(OWNER, c.cardId, { action: 'retry', retryOf: parkId });
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0].brief).toContain('may already have been handed');
  });
  it('an answer on an unapproved card is delivered as answer-only', async () => {
    const t = rig({ live: true });
    const c = t.svc.createCard(AGENT, card); if (!c.ok) throw new Error('c');
    const q = t.svc.setWaitingOn(AGENT, c.cardId, { principal: { personKey: 'justin' }, question: { text: 'Which?' } }); if (!q.ok) throw new Error('q');
    t.svc.tap(OWNER, c.cardId, { action: 'answer', questionId: q.questionId, answer: 'B' });
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0].brief).toContain('Answer only; do not start work');
  });
  it('a second agent-caused work pickup between person records parks the card', async () => {
    const t = rig({ live: true });
    t.svc.setPolicy(OWNER, 'outward-only');
    const c = t.svc.createCard(AGENT, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    // The agent makes the card unworkable (outward) then workable again (not outward), twice.
    t.svc.edit(AGENT, c.cardId, { outward: true }); await t.ctl.tick();
    t.svc.edit(AGENT, c.cardId, { outward: false }); await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.svc.view(c.cardId)!.status).toBe('parked');
  });
  it('a redact sends a stop that names no title and voids pending pickups', async () => {
    const t = rig({ live: true, capacity: () => ({ ok: false, reason: 'full' }) });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    t.svc.tap(OWNER, c.cardId, { action: 'redact' });
    await t.ctl.tick();
    expect(t.stops.some((s) => s.includes('removed') && !s.includes('Pick a venue'))).toBe(true);
    expect(t.ctl.status().pending).toBe(0);
  });
  it('a new owner that cannot see the previous owner\'s stream waits, then treats the pickup as uncertain', async () => {
    const t = rig({ caughtUp: false });
    const c = t.svc.createCard(OWNER, { ...card, outward: true });
    if (!c.ok) throw new Error('c');
    approve(t, c.cardId);
    t.advance(60_000); // the cause predates this controller's ownership
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(0);
    t.advance(11 * 60_000);
    await t.ctl.tick();
    expect(t.svc.view(c.cardId)!.status).toBe('parked');
  });
  it('a quiet card moves to the owner; Try again causes one recovery-brief pickup and restarts the window', async () => {
    const t = rig({ live: true });
    const c = t.svc.createCard(OWNER, card); if (!c.ok) throw new Error('c');
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    t.advance(25 * 3_600_000);
    const v = t.svc.view(c.cardId)!;
    expect(v.status).toBe('quiet');
    const newest = t.svc.recordsOf(c.cardId).at(-1)!.id;
    expect(t.svc.tap(OWNER, c.cardId, { action: 'retry', retryOf: newest }).ok).toBe(true);
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(2);
    expect(t.delivered[1].brief).toContain('may already have been handed');
    expect(t.svc.view(c.cardId)!.status).toBe('with-agent');
  });
  it('a Try again on a pickup waiting for capacity releases that same pickup: the card is handed over once', async () => {
    let free = false;
    const t = rig({ capacity: () => (free ? { ok: true } : { ok: false, reason: 'full' }) });
    const c = t.svc.createCard(AGENT, card); if (!c.ok) throw new Error('c');
    approve(t, c.cardId);
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(0);
    const waiting = t.svc.view(c.cardId)!.pickups.find((p) => p.status === 'pending')!;
    // The approve tap is the card's newest record AND the waiting pickup's cause: the tap must not mint a second pickup.
    expect(t.svc.tap(OWNER, c.cardId, { action: 'retry', retryOf: waiting.cause.id }).ok).toBe(true);
    expect(t.svc.view(c.cardId)!.pickups.filter((p) => p.cause.kind === 'retry')).toHaveLength(0);
    free = true;
    for (let i = 0; i < 4; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.journal.filter((e) => e.data.recordType === 'dispatching')).toHaveLength(1);
  });
  it('an answer-only delivery on a card that is not workable is never followed by a stop', async () => {
    const t = rig({ live: true });
    const c = t.svc.createCard(AGENT, card); if (!c.ok) throw new Error('c');
    const q = t.svc.setWaitingOn(AGENT, c.cardId, { principal: { personKey: 'justin' }, question: { text: 'Which?' } }); if (!q.ok) throw new Error('q');
    t.svc.tap(OWNER, c.cardId, { action: 'answer', questionId: q.questionId, answer: 'B' });
    for (let i = 0; i < 4; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);
    expect(t.stops).toHaveLength(0);
    expect(t.svc.view(c.cardId)!.pickups.filter((p) => p.cause.kind === 'stop')).toHaveLength(0);
  });
  it('an earlier recovery never clears a later uncertainty: a second crash on an outward card parks again, even after withdraw-and-approve', async () => {
    const t = rig();
    const c = t.svc.createCard(OWNER, { ...card, outward: true }); if (!c.ok) throw new Error('c');
    approve(t, c.cardId);
    const cause1 = t.svc.view(c.cardId)!.pickups.find((p) => p.cause.kind === 'work')!.cause;
    t.svc.writeSystem('dispatching', c.cardId, { for: cause1.id, attempt: 1 });          // crash #1
    await t.ctl.tick();
    const park1 = t.svc.view(c.cardId)!.pickups.find((p) => p.status === 'parked')!.parkId!;
    t.svc.tap(OWNER, c.cardId, { action: 'retry', retryOf: park1 });
    await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);                                               // the recovery brief
    expect(t.svc.view(c.cardId)!.mayHaveBeenHandedOver).toBe(false);
    // Crash #2 on a fresh cause, then the owner withdraws and approves again.
    t.svc.tap(OWNER, c.cardId, { action: 'withdraw-approval' });
    approve(t, c.cardId);
    const cause2 = t.svc.view(c.cardId)!.pickups.filter((p) => p.cause.kind === 'work').at(-1)!.cause;
    t.svc.writeSystem('dispatching', c.cardId, { for: cause2.id, attempt: 1 });          // crash #2
    expect(t.svc.view(c.cardId)!.mayHaveBeenHandedOver).toBe(true);
    t.svc.tap(OWNER, c.cardId, { action: 'withdraw-approval' });
    approve(t, c.cardId);
    for (let i = 0; i < 3; i++) await t.ctl.tick();
    expect(t.delivered).toHaveLength(1);                                               // nothing ordinary went out
    expect(t.svc.view(c.cardId)!.status).toBe('parked');
  });
});
