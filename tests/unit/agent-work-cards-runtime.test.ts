/**
 * agent-work-cards-default §2/§3 — the runtime: notes land in the conversation first (emit reserved, nothing written
 * on a refused emit), the holder's paced pointer drain reconciled by event id (and coalescing above the daily ceiling),
 * the pickup hold (no card session while the recording conversation is live; one lift per tick; the lift is the cause),
 * the one automatic re-pickup before the quiet row (and the park that makes the row), and the holder pass being
 * synchronous so a boot tick never swallows the first poke.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { workCardRecordStoreSchema, requestCardId, requestTextHashOf, NOTE_EVENT_PREFIX, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { WorkPrincipal } from '../../src/core/WorkBoardService.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const SERVER: WorkPrincipal = { kind: 'agent', server: true };
const TEXT = 'Please fix the venue list before Friday.';

function machine(opts: { live?: () => boolean | null; rateLimit?: () => boolean; settings?: Record<string, unknown>; holder?: string } = {}) {
  const journal: UnionEntry[] = [];
  const world = { clock: Date.parse('2026-11-20T20:00:00Z'), logical: 0 };
  const events = new Map<string, Array<{ eventId: string; text: string; at: string; writer: string }>>();
  const briefs: Array<{ ck: string; text: string }> = [];
  const logs: string[] = [];
  let holder = opts.holder ?? 'm1';
  const seams: WorkBoardRuntimeSeams = {
    machineId: 'm1', enabled: () => true, rawSettings: () => opts.settings ?? {}, saveSettings: () => true,
    emit: (_k, build) => {
      const hlc: HlcTimestamp = { physical: world.clock, logical: world.logical++, node: 'm1' };
      const data = build(hlc, 'm1'); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm1' }); return { outcome: 'emitted', seq: journal.length, hlc };
    },
    awaitDurable: async () => {}, loadUnion: () => journal, journalBytes: () => 0,
    conversation: {
      create: () => {}, exists: () => true, appendSystemLine: () => {}, remove: () => {}, serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
      dispatchSystem: async (i) => { briefs.push({ ck: i.conversationKey, text: i.text }); return { outcome: 'spawned' }; },
      injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
      appendNoteEvent: (ck, eventId, text, writer) => {
        if (opts.rateLimit?.()) return 'rate-limited';
        const list = events.get(ck) ?? []; if (list.some((e) => e.eventId === eventId)) return 'duplicate';
        list.push({ eventId, text, at: new Date(world.clock).toISOString(), writer }); events.set(ck, list); return 'appended';
      },
      noteEvent: (ck, eventId) => { const e = events.get(ck)?.find((x) => x.eventId === eventId); return e ? { text: e.text, at: e.at } : null; },
      noteEventIds: (ck) => (events.get(ck) ?? []).map((e) => ({ eventId: e.eventId, at: e.at })),
      recordingSessionLive: (ck) => (opts.live ? opts.live() : false) ?? (ck ? null : null),
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'justin', displayName: () => 'Justin', timezone: () => 'UTC',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {},
    leaseHolder: () => holder, now: () => world.clock, log: (e, d) => logs.push(`${e} ${JSON.stringify(d)}`),
  };
  const rt = new WorkBoardRuntime(seams); rt.start();
  const ownerCard = (id = 'CMT-001') => {
    const r = rt.svc.createCard(SERVER, { title: 'Fix the venue list', need: TEXT, doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false, source: { conversationKey: 'telegram:42', messageId: '1001' }, requester: { personKey: 'justin', isOwner: true }, requestTextHash: requestTextHashOf(TEXT), recordedAsHash: requestTextHashOf(TEXT), pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' }, refs: [{ kind: 'commitment', id: `m1:${id}` }] }, { cardId: requestCardId('m1', id) });
    if (!r.ok) throw new Error(r.error); return r.cardId;
  };
  return { rt, journal, events, briefs, logs, world, ownerCard, advance: (ms: number) => { world.clock += ms; }, setHolder: (h: string) => { holder = h; } };
}

describe('progress notes', () => {
  it('a note lands in the card\'s conversation at once with the prefix and the writer\'s binding; the holder\'s pointer follows on the tick; the card read shows it as the last note', async () => {
    const m = machine();
    const id = m.ownerCard();
    const ck = m.rt.svc.view(id)!.card.conversationKey;
    const w = m.rt.writeNote(AGENT, id, 'Started on the list', 'bearer:agent');
    expect(w.ok).toBe(true); if (!w.ok) return;
    expect(m.events.get(ck)![0]).toMatchObject({ eventId: w.eventId, text: `${NOTE_EVENT_PREFIX}Started on the list`, writer: 'bearer:agent' });
    expect(m.rt.svc.notedEventIds(id).size).toBe(0);
    expect(m.rt.pendingNoteCount()).toBe(1);
    expect(m.rt.lastNote(id)).toMatchObject({ text: 'Started on the list', eventId: w.eventId });
    await m.rt.controller.tick();
    expect(m.rt.svc.notedEventIds(id).has(w.eventId)).toBe(true);
    expect(m.rt.pendingNoteCount()).toBe(0);
    expect(m.rt.svc.view(id)!.card.notes).toHaveLength(1);
    // a pointer counts as agent activity; a note is never evidence
    expect(m.rt.svc.view(id)!.card.newestAgentRecordId).toBe(m.rt.svc.view(id)!.card.notes[0].id);
    expect(m.rt.svc.view(id)!.card.evidence).toHaveLength(0);
  });
  it('a rate-limited emit writes nothing anywhere and is returned to retry; a not-started card refuses a note; the scoped session bound to the card\'s own conversation may write', () => {
    let limited = true;
    const m = machine({ rateLimit: () => limited });
    const id = m.ownerCard();
    const ck = m.rt.svc.view(id)!.card.conversationKey;
    expect(m.rt.writeNote(AGENT, id, 'x', 'bearer:agent')).toMatchObject({ ok: false, status: 503, error: 'rate-limited' });
    expect(m.events.get(ck) ?? []).toHaveLength(0);
    expect(m.rt.pendingNoteCount()).toBe(0);
    limited = false;
    expect(m.rt.writeNote({ kind: 'session', conversationKey: ck }, id, 'x', 'session:app:' + ck).ok).toBe(true);
    const member = m.rt.svc.createCard(SERVER, { title: 'm', need: 'n', doneWhen: [{ id: 'd1', text: 't', certify: 'agent-may-certify' }], outward: false, requester: { personKey: 'adriana', isOwner: false }, requestTextHash: requestTextHashOf('n'), recordedAsHash: requestTextHashOf('n') }, { cardId: requestCardId('m1', 'CMT-009') });
    if (!member.ok) throw new Error(member.error);
    expect(m.rt.writeNote(AGENT, member.cardId, 'x', 'bearer:agent')).toMatchObject({ ok: false, error: 'not-started' });
    expect(m.rt.writeNote(OWNER, id, 'x', 'pin')).toMatchObject({ ok: false, error: 'agent-only' });
    expect(m.rt.writeNote(AGENT, id, 'has sk-ant-abcdefghijklmnop', 'bearer:agent')).toMatchObject({ ok: false, error: 'credential-refused' });
  });
  it('the pending set is reconciled by event id across a takeover (a boot seed scan), at most noteDrainPerTick per tick, oldest first; above the daily ceiling pointers coalesce per interval and no text is dropped', async () => {
    const m = machine({ settings: { noteDrainPerTick: 2, maxNotesPerCardPerDay: 3, noteCoalesceMinutes: 1 } });
    const id = m.ownerCard();
    const ck = m.rt.svc.view(id)!.card.conversationKey;
    for (let i = 0; i < 6; i++) { const w = m.rt.writeNote(AGENT, id, `note ${i}`, 'bearer:agent'); expect(w.ok).toBe(true); m.advance(1000); }
    expect(m.events.get(ck)).toHaveLength(6);
    await m.rt.controller.tick();
    expect(m.rt.svc.view(id)!.card.notes).toHaveLength(2); // paced
    await m.rt.controller.tick();
    expect(m.rt.svc.view(id)!.card.notes).toHaveLength(3); // the daily ceiling
    await m.rt.controller.tick();
    expect(m.rt.svc.view(id)!.card.notes).toHaveLength(3); // the coalesce interval has not passed
    m.advance(61_000);
    await m.rt.controller.tick();
    const notes = m.rt.svc.view(id)!.card.notes;
    expect(notes).toHaveLength(4);
    expect(notes[3].eventIds).toHaveLength(3); // the remaining three in one pointer
    expect(m.rt.pendingNoteCount()).toBe(0);
    // a second runtime (a takeover) seeds its pending set from the conversation by event id: nothing is re-pointed, nothing missed
    const takeover = new WorkBoardRuntime({ ...(m.rt as unknown as { seams: WorkBoardRuntimeSeams }).seams, machineId: 'm2' });
    takeover.start();
    expect(takeover.pendingNoteCount()).toBe(0);
    await takeover.controller.tick();
    expect(takeover.pendingNoteCount()).toBe(0);
    expect(takeover.svc.notedEventIds(id).size).toBe(6);
  });
});

describe('the pickup hold', () => {
  it('a held card is not handed to a card session while the recording conversation is live; the quiet lift comes after quietAfterHours with no agent record and the lift is the pickup\'s cause; one lift per tick', async () => {
    let live = true;
    const m = machine({ live: () => live, settings: { quietAfterHours: 1 } });
    const a = m.ownerCard('CMT-001'); m.advance(1000); const b = m.ownerCard('CMT-002');
    await m.rt.controller.tick();
    expect(m.briefs).toHaveLength(0);
    expect(m.rt.svc.view(a)!.card.pickupHeld).toBe(true);
    m.advance(2 * 3_600_000);
    await m.rt.controller.tick(); // the live session still owns it: no lift while the session is live (a long silent tool run is not a dead session)
    expect(m.rt.svc.view(a)!.card.pickupHeld).toBe(true);
    live = false;
    await m.rt.controller.tick();
    expect(m.rt.svc.view(a)!.card.pickupHeld).toBe(false); // oldest first
    expect(m.rt.svc.view(b)!.card.pickupHeld).toBe(true); // one per tick, and a work pickup is now pending
    expect(m.briefs).toHaveLength(1);
    expect(m.briefs[0].text).toContain('no longer carrying it');
    expect(m.rt.holderStats.holdsLifted).toBe(1);
    await m.rt.controller.tick();
    expect(m.rt.svc.view(b)!.card.pickupHeld).toBe(false);
    expect(m.briefs).toHaveLength(2);
  });
  it('a person\'s cause (an approve on a not-started gate card) lifts the hold only when no live session can take it; the agent\'s own records never lift it', async () => {
    let live = true;
    const m = machine({ live: () => live });
    const member = m.rt.svc.createCard(SERVER, { title: 'm', need: 'n', doneWhen: [{ id: 'd1', text: 't', certify: 'agent-may-certify' }], outward: false, requester: { personKey: 'adriana', isOwner: false }, requestTextHash: requestTextHashOf('n'), recordedAsHash: requestTextHashOf('n'), pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' } }, { cardId: requestCardId('m1', 'CMT-005') });
    if (!member.ok) throw new Error(member.error);
    expect(m.rt.svc.view(member.cardId)!.status).toBe('not-started');
    m.rt.svc.tap(OWNER, member.cardId, { action: 'approve', materialHash: m.rt.svc.view(member.cardId)!.card.materialHash });
    await m.rt.controller.tick();
    expect(m.rt.svc.view(member.cardId)!.card.pickupHeld).toBe(true); // live: the recording conversation carries the approval (injection is slice 2)
    expect(m.briefs).toHaveLength(0);
    live = false;
    await m.rt.controller.tick();
    expect(m.rt.svc.view(member.cardId)!.card.holdLifted).toMatchObject({ reason: 'person-cause' });
    expect(m.briefs).toHaveLength(1);
    // the agent's own edit never lifts a hold
    const other = m.ownerCard('CMT-006');
    m.rt.svc.edit(AGENT, other, { title: 'Renamed' });
    await m.rt.controller.tick();
    expect(m.rt.svc.view(other)!.card.pickupHeld).toBe(true);
  });
  it('the holder pass is synchronous: the boot tick does not swallow a poke that arrives right after start', async () => {
    const m = machine();
    const o = m.rt.svc.createCard(OWNER, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }], outward: false }); if (!o.ok) throw new Error(o.error);
    for (let i = 0; i < 3; i++) await m.rt.controller.tick();
    expect(m.briefs).toHaveLength(1);
    expect(m.rt.svc.view(o.cardId)!.pickups[0].closed).toBe('spawned');
    expect(m.rt.holderStats.lastPassAt).not.toBeNull();
  });
  it('a non-holder machine runs no pass', async () => {
    const m = machine({ holder: 'm9' });
    m.ownerCard();
    await m.rt.controller.tick();
    expect(m.rt.holderStats.lastPassAt).toBeNull();
  });
});

describe('quiet, with one self-heal first', () => {
  it('a workable unheld card with no agent record for quietAfterHours gets one automatic re-pickup with the recovery brief; a second quiet period parks into the quiet row; a Try again restarts', async () => {
    const m = machine({ settings: { quietAfterHours: 1 } });
    const o = m.rt.svc.createCard(OWNER, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }], outward: false }); if (!o.ok) throw new Error(o.error);
    await m.rt.controller.tick();
    expect(m.briefs).toHaveLength(1);
    m.advance(2 * 3_600_000);
    await m.rt.controller.tick(); // writes quiet-repickup → a pending work cause
    await m.rt.controller.tick(); // and delivers it
    expect(m.briefs).toHaveLength(2);
    expect(m.briefs[1].text).toContain('went quiet');
    expect(m.rt.svc.view(o.cardId)!.status).toBe('with-agent');
    expect(m.rt.holderStats.quietRepickups).toBe(1);
    m.advance(2 * 3_600_000);
    await m.rt.controller.tick(); await m.rt.controller.tick();
    expect(m.briefs).toHaveLength(2); // the second re-pickup parks: no third brief
    const v = m.rt.svc.view(o.cardId)!;
    expect(v.status).toBe('quiet');
    expect(v.pickups.some((p) => p.status === 'parked' && p.cause.repickup && /agent-churn/.test(p.closedReason ?? ''))).toBe(true);
    await m.rt.controller.tick();
    expect(m.rt.holderStats.quietRepickups).toBe(2); // none written while the park stands
    // the owner's Try again on the park releases it: one recovery pickup
    const park = v.pickups.find((p) => p.status === 'parked')!;
    expect(m.rt.svc.tap(OWNER, o.cardId, { action: 'retry', retryOf: park.parkId! }).ok).toBe(true);
    await m.rt.controller.tick();
    expect(m.briefs).toHaveLength(3);
    expect(m.rt.svc.view(o.cardId)!.status).toBe('with-agent');
  });
});
