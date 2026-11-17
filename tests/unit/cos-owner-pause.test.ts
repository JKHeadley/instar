/**
 * Chief of Staff owner pause (docs/specs/cos-owner-pause-record.md): the store event and its fold, the loop's
 * skip / fence / resurfacing, the ask (source floor) and the owner's tap on the exact ask message.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, buildOwnerPauseEvent, buildLifecycleEvent, foldBindingState, unknownLifecycleEvents, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, planDue, boundProjects, ownerPause, type ChiefOfStaffLoopDeps, type EvidenceBundle, type PauseAsk } from '../../src/core/ChiefOfStaffLoop.js';
import { checkOwnerPauseSource, composePauseAsk, type OwnerPauseSource } from '../../src/core/cosOwnerPauseSource.js';
import type { ResolveResult } from '../../src/core/attribution/SourceResolver.js';
import type { SourceRef } from '../../src/core/attribution/marker.js';
import { chiefOfStaffNeedRows } from '../../dashboard/console/needs-model.js';

const CK = 'telegram:102965';
const OWNER = 7812716706;
const T0 = Date.parse('2026-11-16T08:05:00Z');
const H = 3_600_000;
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });
const MARKER = '[source: telegram 102965/142745 2026-11-13]';
const OWNER_TEXT = 'lets pause the Instar 2.0 work again until we get our throughput issues solved';

class FakeJournal {
  entries: UnionEntry[] = []; clock = 1; seq = 0; refuse = false; durableFails = false;
  emit(origin: string) {
    return (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
      if (this.refuse) return { outcome: 'refused' };
      const hlc: HlcTimestamp = { physical: ++this.clock, logical: 0, node: origin };
      const data = build(hlc, origin); if (!data) return { outcome: 'dropped' };
      const v = chiefOfStaffRecordStoreSchema.validate(data, ctx()); if (!v) return { outcome: 'dropped:schema' };
      this.entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin }, origin }); return { outcome: 'emitted', seq: ++this.seq };
    };
  }
}

function bundle(): EvidenceBundle {
  return { conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: 'none', unknown: false }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: 'fail' }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 };
}

interface W { j: FakeJournal; now: number; sent: Array<{ text: string; id: string; first?: string }>; asks: Record<string, PauseAsk>; source: OwnerPauseSource; sendResult: { chatId: string; messageId: number } | 'unconfirmed' | null; receives: boolean; asksOn: boolean; gathered: number; notes: string[] }
function w0(): W {
  return { j: new FakeJournal(), now: T0, sent: [], asks: {}, source: { ok: true, ref: { channel: 'telegram', conversation: '102965', message: '142745', date: '2026-11-13' }, marker: MARKER, at: '2026-11-13T16:52:10.000Z', ownerText: OWNER_TEXT }, sendResult: { chatId: '-100', messageId: 900 }, receives: true, asksOn: true, gathered: 0, notes: [] };
}
function loop(w: W, withAsk = true): ChiefOfStaffLoop {
  const config = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
  const deps: ChiefOfStaffLoopDeps = {
    now: () => w.now, machineId: 'm_a', enabled: () => true, holdsLease: () => true, config: () => config,
    journal: { emit: w.j.emit('m_a'), loadUnion: () => w.j.entries.slice(), awaitDurable: async () => { if (w.j.durableFails) throw new Error('not durable'); } },
    verifyRenewal: () => true,
    gather: async () => { w.gathered++; return bundle(); },
    judge: async () => ({ verdict: 'stalled', citedIds: ['run'], reason: 'r' }),
    protocol: { claim: async () => ({ outcome: 'started', runId: 'r' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => true } as unknown as ChiefOfStaffLoopDeps['protocol'],
    mirrorInitiativeStatus: () => {},
    sendNote: async (t) => { w.notes.push(t); }, sendImmediate: async () => {},
    statusUrl: () => null, localHour: () => 8,
    ...(withAsk ? { pauseAsk: {
      receivesCallbacks: () => w.receives, asksEnabled: () => w.asksOn, ownerName: () => 'Justin', olderMachines: () => [], conversationName: () => 'Instar 2.0',
      store: { load: () => JSON.parse(JSON.stringify(w.asks)), save: (a) => { w.asks = JSON.parse(JSON.stringify(a)); } },
      send: async (text, button, first) => { w.sent.push({ text, id: button.id, ...(first ? { first } : {}) }); return w.sendResult; },
    } } : {}),
  };
  const l = new ChiefOfStaffLoop(deps);
  l.bindPauseSourceCheck(async () => w.source);
  return l;
}
function bind(w: W) {
  w.j.emit('m_a')(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Instar 2.0', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }], linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date(T0 - H).toISOString() } as never));
}
const bs = (w: W) => foldBindingState(w.j.entries).get(CK)!;
const rec = { who: 'Justin', at: '2026-11-16T08:00:00.000Z', quote: OWNER_TEXT, messageRef: MARKER };
async function askAndTap(w: W, l: ChiefOfStaffLoop, action: 'pause' | 'resume' = 'pause') {
  const r = await l.requestOwnerPause(CK, action, MARKER);
  if (!r.ok) throw new Error(r.reason);
  const ask = w.asks[r.askId];
  return { askId: r.askId, result: await l.ownerTap(`cos:${action === 'pause' ? 'p' : 'r'}:${r.askId}`, 'owner-tap', { chatId: ask.chatId, messageId: ask.askMessageId }) };
}

describe('store: owner pause events', () => {
  it('validator: only the owner tap writes a pause; fields bounded; unknown events are kept, not rejected', () => {
    const hlc = { physical: 5, logical: 0, node: 'm' };
    const base = { recordType: 'binding-lifecycle', conversationKey: CK, bindingHlc: hlc, at: rec.at, who: 'Justin', quote: 'q', messageRef: MARKER, askId: 'a'.repeat(16) };
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'owner-tap' }, ctx())).not.toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'chief-of-staff' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'owner-tap', quote: '' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'owner-tap', quote: 'x'.repeat(4097) }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'owner-tap', quote: 'x'.repeat(4096) }, ctx())).not.toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-pause', by: 'owner-tap', askId: undefined }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'binding-lifecycle', conversationKey: CK, bindingHlc: hlc, at: rec.at, event: 'some-future-event', by: 'someone-new' }, ctx())).not.toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'binding-lifecycle', conversationKey: CK, bindingHlc: hlc, at: rec.at, event: 'Bad Event!', by: 'x' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'binding-lifecycle', conversationKey: CK, bindingHlc: hlc, at: rec.at, event: 'unpark', by: 'owner-message' }, ctx())).toBeNull();
  });
  it('fold: pause sets pausedBy, resume clears it, newest wins, one ask decides once, survives a re-bind, unknown events ignored', () => {
    const w = w0(); bind(w);
    const h = bs(w).bindingHlc!;
    w.j.emit('m_a')(`lc:1`, buildOwnerPauseEvent(CK, 'owner-pause', h, rec, 'a'.repeat(16)));
    expect(bs(w).pausedBy).toEqual(rec);
    w.j.emit('m_a')(`lc:x`, (hl, o) => ({ ...buildLifecycleEvent(CK, 'unpark', h, 'owner-tap', rec.at)(hl, o)!, event: 'some-future-event' }));
    expect(bs(w).pausedBy).toEqual(rec);
    w.j.emit('m_a')(`lc:2`, buildOwnerPauseEvent(CK, 'owner-resume', h, rec, 'b'.repeat(16)));
    expect(bs(w).pausedBy).toBeNull();
    // A replayed pause carrying an askId already used never re-pauses over the later resume.
    w.j.emit('m_a')(`lc:3`, buildOwnerPauseEvent(CK, 'owner-pause', h, rec, 'a'.repeat(16)));
    expect(bs(w).pausedBy).toBeNull();
    w.j.emit('m_a')(`lc:4`, buildOwnerPauseEvent(CK, 'owner-pause', h, { ...rec, quote: 'again' }, 'c'.repeat(16)));
    bind(w); // an owner edit of the binding
    expect(bs(w).pausedBy?.quote).toBe('again');
    // arrival order does not matter: the same entries reversed fold the same
    expect(foldBindingState(w.j.entries.slice().reverse()).get(CK)!.pausedBy?.quote).toBe('again');
  });
  it('unknown lifecycle events are counted by name, never silently ignored', () => {
    const w = w0(); bind(w); const h = bs(w).bindingHlc!;
    for (const k of ['a', 'b']) w.j.emit('m_a')(`lc:${k}`, (hl, o) => ({ ...buildLifecycleEvent(CK, 'unpark', h, 'owner-tap', rec.at)(hl, o)!, event: 'some-future-event' }));
    expect(unknownLifecycleEvents(w.j.entries)).toEqual({ 'some-future-event': 2 });
    expect(loop(w).status().unknownLifecycleEvents).toEqual({ 'some-future-event': 2 });
  });
  it('reader accepts a whole 4096-character owner message', () => {
    expect(ownerPause({ pausedBy: { ...rec, quote: 'x'.repeat(4096) } })?.quote.length).toBe(4096);
    expect(ownerPause({ pausedBy: { ...rec, quote: 'x'.repeat(4097) } })).toBeNull();
  });
});

describe('loop: a paused project is left alone', () => {
  it('planDue skips it; the tick gathers nothing and claims nothing; summary and detail show pausedBy', async () => {
    const w = w0(); bind(w);
    w.j.emit('m_a')('lc:1', buildOwnerPauseEvent(CK, 'owner-pause', bs(w).bindingHlc!, rec, 'a'.repeat(16)));
    const projects = boundProjects(w.j.entries);
    expect(planDue(projects, new Map(), new Set([CK]), T0, 30)).toHaveLength(0);
    const l = loop(w); await l.tick();
    expect(w.gathered).toBe(0);
    expect(w.j.entries.filter((e) => e.data.recordType === 'check-event')).toHaveLength(0);
    expect(l.projectsSummary()[0].pausedBy).toEqual(rec);
    expect((l.projectDetail(CK) as { pausedBy: unknown }).pausedBy).toEqual(rec);
    expect(l.actionGate(CK).paused).toBe(true);
    expect(l.isOwnerPaused(CK)).toBe(true);
  });
  it('derivedNeeds drops a paused, parked project', () => {
    const w = w0(); bind(w);
    w.j.emit('m_a')('lc:1', buildOwnerPauseEvent(CK, 'owner-pause', bs(w).bindingHlc!, rec, 'a'.repeat(16)));
    const l = loop(w); const projects = boundProjects(w.j.entries);
    const parked = new Map([[CK, { parked: true, breakerTripped: false, restartsWithoutProgress: 3, lastVerdict: 'stalled' } as never]]);
    expect(l.derivedNeeds(w.j.entries, projects, parked, clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS }), true)).toHaveLength(0);
  });
  it('the dashboard Needs-you rows skip a paused project', () => {
    const p = { conversationKey: CK, title: 'Instar 2.0', parked: true, restartsWithoutProgress: 3 };
    expect(chiefOfStaffNeedRows({ ok: true, data: { lease: { live: true }, projects: [p] } }, T0)).toHaveLength(1);
    expect(chiefOfStaffNeedRows({ ok: true, data: { lease: { live: true }, projects: [{ ...p, pausedBy: rec }] } }, T0)).toEqual([]);
  });
});

describe('the ask (source floor) and the tap', () => {
  it('ask sends one button message showing the whole owner message; the owner tap on that exact message pauses', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const { askId, result } = await askAndTap(w, l);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].text).toContain(`“${OWNER_TEXT}”`);
    expect(w.sent[0].text).toContain(MARKER);
    expect(w.sent[0].id).toBe(`cos:p:${askId}`);
    expect(result).toBe('paused');
    expect(bs(w).pausedBy).toMatchObject({ who: 'Justin', quote: OWNER_TEXT, messageRef: MARKER });
    expect(w.asks).toEqual({});
  });
  it('a tap on another message, an unknown nonce, the wrong action, or a redelivered callback does nothing new', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const r = await l.requestOwnerPause(CK, 'pause', MARKER); if (!r.ok) throw new Error(r.reason);
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 901 })).toBe('ignored');
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-200', messageId: 900 })).toBe('ignored');
    expect(await l.ownerTap(`cos:r:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
    expect(await l.ownerTap(`cos:p:${'f'.repeat(16)}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap')).toBe('ignored');
    expect(bs(w).pausedBy).toBeNull();
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('paused');
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
    expect(w.j.entries.filter((e) => e.data.event === 'owner-pause')).toHaveLength(1);
  });
  it('a crash between the write and the ask delete, then a resume, then a replayed pause tap: no re-pause', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const r = await l.requestOwnerPause(CK, 'pause', MARKER); if (!r.ok) throw new Error(r.reason);
    const saved = JSON.parse(JSON.stringify(w.asks));
    await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 });
    w.j.emit('m_a')('lc:resume', buildOwnerPauseEvent(CK, 'owner-resume', bs(w).bindingHlc!, rec, 'r'.repeat(16)));
    w.asks = saved; // as if the delete never happened
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
    expect(bs(w).pausedBy).toBeNull();
    expect(w.j.entries.filter((e) => e.data.askId === r.askId)).toHaveLength(1);
  });
  it('the tap re-check: an edited or no-longer-owner message refuses and keeps the ask; an unreachable resolver still records', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const r = await l.requestOwnerPause(CK, 'pause', MARKER); if (!r.ok) throw new Error(r.reason);
    const tap = () => l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 });
    w.source = { ...(w.source as Extract<OwnerPauseSource, { ok: true }>), ownerText: 'dont pause yet' };
    expect(await tap()).toBe('recheck-failed');
    w.source = { ok: false, reason: 'agent-authored' };
    expect(await tap()).toBe('recheck-failed');
    expect(Object.keys(w.asks)).toEqual([r.askId]);
    w.source = { ok: false, reason: 'unreachable' };
    expect(await tap()).toBe('paused');
    expect(bs(w).pausedBy?.quote).toBe(OWNER_TEXT);
  });
  it('a refused or non-durable write keeps the ask and never answers paused', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const r = await l.requestOwnerPause(CK, 'pause', MARKER); if (!r.ok) throw new Error(r.reason);
    w.j.refuse = true;
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('write-failed');
    expect(Object.keys(w.asks)).toEqual([r.askId]);
    w.j.refuse = false; w.j.durableFails = true;
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('write-failed');
    w.j.durableFails = false;
    expect(await l.ownerTap(`cos:p:${r.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('paused');
    expect(w.j.entries.filter((e) => e.data.event === 'owner-pause')).toHaveLength(1);
  });
  it('one open ask per project: a new ask replaces the old one, whose slow tap is then ignored', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const a = await l.requestOwnerPause(CK, 'pause', MARKER); if (!a.ok) throw new Error(a.reason);
    w.sendResult = { chatId: '-100', messageId: 901 };
    const b = await l.requestOwnerPause(CK, 'pause', MARKER); if (!b.ok) throw new Error(b.reason);
    expect(Object.keys(w.asks)).toEqual([b.askId]);
    expect(await l.ownerTap(`cos:p:${a.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
  });
  it('resume works on a closed, paused project; resume of an unpaused project is refused at ask time', async () => {
    const w = w0(); bind(w); const l = loop(w);
    expect(await l.requestOwnerPause(CK, 'resume', MARKER)).toEqual({ ok: false, status: 422, reason: 'not-paused' });
    await askAndTap(w, l, 'pause');
    w.j.emit('m_a')('lc:close', buildLifecycleEvent(CK, 'closed', bs(w).bindingHlc!, 'owner-tap', rec.at));
    expect(bs(w).closed).toBe(true);
    expect(await l.requestOwnerPause(CK, 'pause', MARKER)).toEqual({ ok: false, status: 422, reason: 'no-project' });
    const { result } = await askAndTap(w, l, 'resume');
    expect(result).toBe('resumed');
    expect(bs(w).pausedBy).toBeNull();
  });
  it('refusals: not the callback machine, asks off (pause only), attribution unbound, failed or unconfirmed send, no project, floor refusal', async () => {
    const w = w0(); bind(w);
    w.receives = false; expect((await loop(w).requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('not-callback-machine'); w.receives = true;
    expect((await loop(w, false).requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('not-callback-machine');
    w.asksOn = false; expect((await loop(w).requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('asks-off'); w.asksOn = true;
    const unbound = loop(w); unbound.bindPauseSourceCheck(null);
    expect((await unbound.requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('attribution-unavailable');
    w.sendResult = 'unconfirmed'; expect((await loop(w).requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('send-unconfirmed');
    w.sendResult = null; expect((await loop(w).requestOwnerPause(CK, 'pause', MARKER) as { reason: string }).reason).toBe('send-failed');
    expect(w.asks).toEqual({});
    w.sendResult = { chatId: '-100', messageId: 900 };
    expect((await loop(w).requestOwnerPause('telegram:1', 'pause', MARKER) as { reason: string }).reason).toBe('no-project');
    w.source = { ok: false, reason: 'not-owner' };
    expect(await loop(w).requestOwnerPause(CK, 'pause', MARKER)).toEqual({ ok: false, status: 422, reason: 'not-owner' });
  });
  it('asks off still allows resume', async () => {
    const w = w0(); bind(w); const l = loop(w);
    await askAndTap(w, l, 'pause');
    w.asksOn = false;
    expect((await askAndTap(w, l, 'resume')).result).toBe('resumed');
  });
  it('a long owner message is sent whole first and the ask points to it', () => {
    const long = 'x'.repeat(4000);
    const a = composePauseAsk({ action: 'pause', title: 'T', ownerText: long, marker: MARKER, writtenIn: null, date: '2026-11-13', olderMachines: [] });
    expect(a.separateOwnerMessage).toBe(true); expect(a.text).toContain('(above)'); expect(a.text.length).toBeLessThan(4096);
    const short = composePauseAsk({ action: 'pause', title: 'T', ownerText: 'pause it', marker: MARKER, writtenIn: 'Instar 2.0', date: '2026-11-13', olderMachines: ['Laptop'] });
    expect(short.separateOwnerMessage).toBe(false); expect(short.text).toContain('Not enforced on Laptop until it updates.'); expect(short.text).toContain('runs you started yourself are not affected');
  });
});

describe('source floor (checkOwnerPauseSource)', () => {
  const row = { text: OWNER_TEXT, fromUser: true, provenance: 'user', forwarded: false, telegramUserId: OWNER, timestamp: '2026-11-13T16:52:10.000Z' };
  const deps = (over: Partial<ResolveResult> = {}, r: Record<string, unknown> = row, ownerUid: number | null = OWNER) => ({
    resolve: async (_ref: SourceRef): Promise<ResolveResult> => ({ outcome: 'found', row: r, failed: [], authorship: 'human', ...over }),
    ownerUid: () => ownerUid,
    identity: (_c: string, id: string) => (id === String(OWNER) ? 'Justin Headley' : id === '555' ? 'Justin' : null),
  });
  it('accepts the owner own human message (numeric uid) and returns its whole text', async () => {
    const r = await checkOwnerPauseSource(deps(), MARKER);
    expect(r).toMatchObject({ ok: true, ownerText: OWNER_TEXT, marker: MARKER, at: '2026-11-13T16:52:10.000Z' });
  });
  it('refuses malformed, non-telegram, not-found, not-human, agent-authored, forwarded, another sender (incl. same first name), no owner', async () => {
    expect((await checkOwnerPauseSource(deps(), 'no marker') as { reason: string }).reason).toBe('marker-malformed');
    expect((await checkOwnerPauseSource(deps(), `${MARKER} ${MARKER}`) as { reason: string }).reason).toBe('marker-malformed');
    expect((await checkOwnerPauseSource(deps(), '[source: slack C1/1.2 2026-11-13]') as { reason: string }).reason).toBe('channel-not-supported');
    expect((await checkOwnerPauseSource(deps({ outcome: 'not-found', row: undefined }), MARKER) as { reason: string }).reason).toBe('not-found');
    expect((await checkOwnerPauseSource(deps({ outcome: 'pinned-copy' }), MARKER) as { reason: string }).reason).toBe('pinned-copy');
    expect((await checkOwnerPauseSource(deps({ authorship: 'agent-outbound' }), MARKER) as { reason: string }).reason).toBe('not-human');
    expect((await checkOwnerPauseSource(deps({ authorship: 'UNRESOLVED' }), MARKER) as { reason: string }).reason).toBe('not-human');
    expect((await checkOwnerPauseSource(deps({}, { ...row, forwarded: true }), MARKER) as { reason: string }).reason).toBe('forwarded');
    expect((await checkOwnerPauseSource(deps({}, { ...row, provenance: 'agent' }), MARKER) as { reason: string }).reason).toBe('unproven-provenance');
    expect((await checkOwnerPauseSource(deps({}, { ...row, telegramUserId: 555 }), MARKER) as { reason: string }).reason).toBe('not-owner');
    expect((await checkOwnerPauseSource(deps({}, row, null), MARKER) as { reason: string }).reason).toBe('owner-unknown');
    expect((await checkOwnerPauseSource(deps({}, { ...row, text: '' }), MARKER) as { reason: string }).reason).toBe('message-unreadable');
  });
});
