/**
 * Project rows that say something (docs/specs/work-door-project-rows.md): the row's new fields, the owner item-check
 * and check-request events and their fold, the loop's Ask for an update / phone Pause / Mark checked / Finish, and the
 * phone action lines.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import {
  chiefOfStaffRecordStoreSchema, buildBindingPut, buildOwnerPauseEvent, buildOwnerItemCheckEvent, buildCheckRequestedEvent, buildLifecycleEvent,
  foldBindingState, doneItemCheckRef, hlcKey, unknownLifecycleEvents, type UnionEntry,
} from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, planDue, boundProjects, APP_PAUSE_QUOTE, type ChiefOfStaffLoopDeps, type EvidenceBundle, type PauseAsk } from '../../src/core/ChiefOfStaffLoop.js';
import { composeProjects, rowExtras, reportWords, projectState, PROJECTS_SCHEMA_VERSION, type CosProjectRow } from '../../src/server/workProjectsRoutes.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';

const CK = 'telegram:144900';
const T0 = Date.parse('2026-11-18T08:05:00Z');
const MIN = 60_000;
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });
const GOAL = 'Project rows that say something.';
const DONE = [
  { id: 'pr', kind: 'deterministic' as const, text: 'PR merged' },
  { id: 'feel', kind: 'judgment' as const, text: 'Feels right on a phone' },
  { id: 'deleg', kind: 'judgment' as const, text: 'Docs read well', certify: 'agent-may-certify' as const },
];

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

interface W { j: FakeJournal; now: number; holds: boolean; prDone: 'pass' | 'fail'; gathered: number; claims: number; asks: Record<string, PauseAsk>; judgeVerdict: string }
function w0(): W { return { j: new FakeJournal(), now: T0, holds: true, prDone: 'pass', gathered: 0, claims: 0, asks: {}, judgeVerdict: 'stalled' }; }
function bundle(w: W): EvidenceBundle {
  return { conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: `n${w.gathered}`, unknown: false }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: w.prDone }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 };
}
function loop(w: W): ChiefOfStaffLoop {
  const config = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
  const deps: ChiefOfStaffLoopDeps = {
    now: () => w.now, machineId: 'm_a', enabled: () => true, holdsLease: () => w.holds, config: () => config,
    journal: { emit: w.j.emit('m_a'), loadUnion: () => w.j.entries.slice(), awaitDurable: async () => { if (w.j.durableFails) throw new Error('not durable'); } },
    verifyRenewal: () => true,
    gather: async () => { w.gathered++; return bundle(w); },
    judge: async () => ({ verdict: w.judgeVerdict as never, citedIds: ['run'], reason: 'The release is waiting on the store review.' }),
    protocol: { claim: async () => { w.claims++; return { outcome: 'started', runId: 'r' }; }, standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => true } as unknown as ChiefOfStaffLoopDeps['protocol'],
    mirrorInitiativeStatus: () => {},
    sendNote: async () => {}, sendImmediate: async () => {},
    statusUrl: () => null, localHour: () => 3, sign: (c) => `sig:${c.length}`,
    pauseAsk: {
      receivesCallbacks: () => true, asksEnabled: () => true, ownerName: () => 'Justin', olderMachines: () => [], conversationName: () => 'Rows',
      store: { load: () => JSON.parse(JSON.stringify(w.asks)), save: (a) => { w.asks = JSON.parse(JSON.stringify(a)); } },
      send: async () => ({ chatId: '-100', messageId: 900 }),
    },
  };
  return new ChiefOfStaffLoop(deps);
}
function bind(w: W, done = DONE, goal = GOAL) {
  w.j.emit('m_a')(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal, checkCadenceHours: 24, doneDefinition: done, linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date(T0 - 60 * MIN).toISOString() } as never));
}
const bs = (w: W) => foldBindingState(w.j.entries).get(CK)!;
const ref = (id: string, text: string, goal = GOAL) => doneItemCheckRef(goal, id, text);
const checkItem = (w: W, id: string, text: string, checked = true, askId = `app-${Math.random().toString(16).slice(2, 18).padEnd(16, '0')}`, goal = GOAL) =>
  w.j.emit('m_a')(`lc:${askId}`, buildOwnerItemCheckEvent(CK, bs(w).bindingHlc!, { who: 'owner', at: new Date(w.now).toISOString(), messageRef: 'instar-app:dev1', itemId: id, checked, checkRef: ref(id, text, goal) }, askId));

describe('store: owner item checks and check requests', () => {
  const hlc = { physical: 5, logical: 0, node: 'm' };
  const base = { recordType: 'binding-lifecycle', conversationKey: CK, bindingHlc: hlc, at: '2026-11-18T08:00:00.000Z', who: 'owner', messageRef: 'instar-app:d', askId: 'app-1', itemId: 'feel', itemChecked: true, checkRef: 'a'.repeat(64) };
  it('only an owner tap writes an item check, with a boolean value and a 64-hex checkRef', () => {
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'owner-tap' }, ctx())).toMatchObject({ itemId: 'feel', itemChecked: true, checkRef: 'a'.repeat(64) });
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'chief-of-staff' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'owner-tap', itemChecked: 'yes' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'owner-tap', checkRef: 'nope' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'owner-tap', itemId: '' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, event: 'owner-item-check', by: 'owner-tap', askId: undefined }, ctx())).toBeNull();
  });
  it('a check request is a known lifecycle event from the owner tap or the Chief of Staff', () => {
    const w = w0(); bind(w);
    expect(w.j.emit('m_a')('lc:r', buildCheckRequestedEvent(CK, bs(w).bindingHlc!, 'owner-tap', new Date(T0).toISOString())).outcome).toBe('emitted');
    expect(bs(w).lastCheckRequestAt).toBe(new Date(T0).toISOString());
    expect(unknownLifecycleEvents(w.j.entries)).toEqual({});
  });
  it('fold: newest wins, uncheck clears, one tap decides once, and only judgment items count', () => {
    const w = w0(); bind(w);
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    expect(Object.keys(bs(w).ownerChecks)).toEqual(['feel']);
    checkItem(w, 'feel', 'Feels right on a phone', false, 'app-b');
    expect(bs(w).ownerChecks).toEqual({});
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a'); // a replayed tap id
    expect(bs(w).ownerChecks).toEqual({});
    checkItem(w, 'pr', 'PR merged', true, 'app-c'); // an automatic check cannot be owner-checked
    expect(bs(w).ownerChecks).toEqual({});
  });
  it('fold: a check is void when that item or the goal changes, kept when another item changes, and restored by the same wording', () => {
    const w = w0(); bind(w);
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    bind(w, DONE.map((d) => d.id === 'deleg' ? { ...d, text: 'Docs read very well' } : d));
    expect(Object.keys(bs(w).ownerChecks)).toEqual(['feel']);
    bind(w, DONE.map((d) => d.id === 'feel' ? { ...d, text: 'Feels great on a phone' } : d));
    expect(bs(w).ownerChecks).toEqual({});
    bind(w); // the same wording again: the owner judged exactly this content
    expect(Object.keys(bs(w).ownerChecks)).toEqual(['feel']);
    bind(w, DONE, 'A different goal.');
    expect(bs(w).ownerChecks).toEqual({});
  });
  it('fold: an uncheck made under other wording is not skipped, so a withdrawn check never comes back after a revert', () => {
    const w = w0(); bind(w);
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    bind(w, DONE.map((d) => d.id === 'feel' ? { ...d, text: 'B wording' } : d));
    checkItem(w, 'feel', 'B wording', false, 'app-b');
    bind(w); // back to the first wording
    expect(bs(w).ownerChecks).toEqual({});
  });
  it('fold: a reopen clears the checks made before it; a shared id cannot be checked', () => {
    const w = w0(); bind(w);
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    w.j.emit('m_a')('lc:re', buildLifecycleEvent(CK, 'reopened', bs(w).bindingHlc!, 'owner-tap', new Date(T0).toISOString()));
    expect(bs(w).ownerChecks).toEqual({});
    const dup = [...DONE, { id: 'feel', kind: 'judgment' as const, text: 'Second item, same id' }];
    const w2 = w0(); bind(w2, dup);
    checkItem(w2, 'feel', 'Feels right on a phone', true, 'app-a');
    expect(foldBindingState(w2.j.entries).get(CK)!.ownerChecks).toEqual({});
  });
});

describe('planDue: a queued check request', () => {
  it('is due once the last check is older than the gap, never sooner, and only when newer than that check', () => {
    const w = w0(); bind(w);
    const l = loop(w);
    w.j.emit('m_a')('c1', (hlc, o) => ({ recordType: 'check-event', conversationKey: CK, verdict: 'moving', evidenceHash: 'a'.repeat(64), evidenceIds: [], progressSeen: false, machine: 'm_a', at: new Date(T0).toISOString(), recordKey: 'c1', hlc, origin: o }) as never);
    const projects = boundProjects(w.j.entries);
    const st = (now: number) => new Map([[CK, { conversationKey: CK, lastCheckAt: new Date(T0).toISOString(), nextCheckAt: new Date(T0 + 24 * 60 * MIN).toISOString(), lastCheckHlc: { physical: 3, logical: 0, node: 'm_a' } } as never]]);
    void l;
    expect(planDue(projects, st(T0), new Set(), T0 + 20 * MIN, 30, 14)).toEqual([]);
    w.j.emit('m_a')('lc:r', buildCheckRequestedEvent(CK, bs(w).bindingHlc!, 'owner-tap', new Date(T0 + MIN).toISOString()));
    const withReq = boundProjects(w.j.entries);
    expect(planDue(withReq, st(T0), new Set(), T0 + 5 * MIN, 30, 14)).toEqual([]);
    expect(planDue(withReq, st(T0), new Set(), T0 + 15 * MIN, 30, 14).map((p) => p.conversationKey)).toEqual([CK]);
    // Without the tick argument (an older caller), requests are not honoured.
    expect(planDue(withReq, st(T0), new Set(), T0 + 15 * MIN, 30)).toEqual([]);
  });
});

describe('the loop: Ask for an update', () => {
  it('runs one check now on the holder, then queues inside the gap (one record), and refuses paused / closed / unknown', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const r1 = await l.checkNow(CK, 'owner-tap');
    expect(r1).toMatchObject({ ok: true, queued: false });
    expect(w.gathered).toBe(1);
    const r2 = await l.checkNow(CK, 'owner-tap');
    expect(r2).toMatchObject({ ok: true, queued: true });
    expect(w.gathered).toBe(1);
    const reqs = () => w.j.entries.filter((e) => e.data.event === 'check-requested').length;
    expect(reqs()).toBe(1);
    await l.checkNow(CK, 'chief-of-staff');
    expect(reqs()).toBe(1); // a request already waiting is enough
    expect(await l.checkNow('telegram:1', 'owner-tap')).toEqual({ ok: false, reason: 'no-project' });
    w.j.emit('m_a')('lc:p', buildOwnerPauseEvent(CK, 'owner-pause', bs(w).bindingHlc!, { who: 'o', at: new Date(T0).toISOString(), quote: 'q', messageRef: 'instar-app:d' }, 'app-p'));
    expect(await l.checkNow(CK, 'owner-tap')).toEqual({ ok: false, reason: 'paused' });
  });
  it('queues on a machine that does not run checks, and a closed project answers done', async () => {
    const w = w0(); bind(w); w.holds = false; const l = loop(w);
    expect(await l.checkNow(CK, 'owner-tap')).toMatchObject({ ok: true, queued: true });
    expect(w.gathered).toBe(0);
    w.j.emit('m_a')('lc:c', buildLifecycleEvent(CK, 'closed', bs(w).bindingHlc!, 'owner-tap', new Date(T0).toISOString()));
    expect(await l.checkNow(CK, 'owner-tap')).toEqual({ ok: false, reason: 'done' });
  });
  it('a durable-write failure on the queued record answers not-recorded', async () => {
    const w = w0(); bind(w); w.holds = false; w.j.durableFails = true; const l = loop(w);
    expect(await l.checkNow(CK, 'owner-tap')).toEqual({ ok: false, reason: 'not-recorded' });
  });
});

describe('the loop: phone Pause, Mark checked, Finish', () => {
  it('a phone pause writes the existing owner-pause event, and records even when already paused', async () => {
    const w = w0(); bind(w); const l = loop(w);
    expect(await l.appPause({ conversationKey: CK, action: 'pause', who: 'owner', note: null, deviceId: 'dev1', tapId: 'app-1' })).toMatchObject({ ok: true });
    expect(bs(w).pausedBy).toMatchObject({ quote: APP_PAUSE_QUOTE, messageRef: 'instar-app:dev1' });
    expect(await l.appPause({ conversationKey: CK, action: 'pause', who: 'owner', note: 'until Monday', deviceId: 'dev1', tapId: 'app-2' })).toMatchObject({ ok: true });
    expect(bs(w).pausedBy?.quote).toBe('until Monday');
    expect(w.j.entries.filter((e) => e.data.event === 'owner-pause')).toHaveLength(2);
    expect(await l.appPause({ conversationKey: CK, action: 'resume', who: 'owner', note: null, deviceId: 'dev1', tapId: 'app-3' })).toMatchObject({ ok: true });
    expect(bs(w).pausedBy).toBeNull();
    expect(await l.appPause({ conversationKey: CK, action: 'resume', who: 'owner', note: null, deviceId: 'dev1', tapId: 'app-4' })).toEqual({ ok: false, reason: 'not-paused' });
  });
  it('a Telegram pause ask older than the phone decision no longer applies', async () => {
    const w = w0(); bind(w); const l = loop(w);
    l.bindPauseSourceCheck(async () => ({ ok: true, ref: { channel: 'telegram', conversation: '144900', message: '1', date: '2026-11-18' }, marker: '[source: telegram 144900/1 2026-11-18]', at: '2026-11-18T07:00:00.000Z', ownerText: 'pause it' }));
    const ask = await l.requestOwnerPause(CK, 'pause', '[source: telegram 144900/1 2026-11-18]');
    if (!ask.ok) throw new Error(ask.reason);
    w.now = T0 + MIN;
    await l.appPause({ conversationKey: CK, action: 'pause', who: 'owner', note: null, deviceId: 'd', tapId: 'app-p' });
    await l.appPause({ conversationKey: CK, action: 'resume', who: 'owner', note: null, deviceId: 'd', tapId: 'app-r' });
    // appPause cleared this machine's asks; put the ask back to model an ask on another machine's store.
    w.asks[ask.askId] = { key: CK, action: 'pause', marker: 'm', ownerText: 'pause it', writtenIn: null, sentAt: new Date(T0).toISOString(), chatId: '-100', askMessageId: 900 };
    expect(await l.ownerTap(`cos:p:${ask.askId}`, 'owner-tap', { chatId: '-100', messageId: 900 })).toBe('ignored');
    expect(bs(w).pausedBy).toBeNull();
  });
  it('Mark checked records every tap, refuses an automatic item and a changed item, and never closes the project', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const feel = ref('feel', 'Feels right on a phone');
    expect(await l.appItemCheck({ conversationKey: CK, itemId: 'feel', checkRef: feel, checked: true, who: 'owner', deviceId: 'd', tapId: 'app-1' })).toMatchObject({ ok: true });
    expect(await l.appItemCheck({ conversationKey: CK, itemId: 'feel', checkRef: feel, checked: true, who: 'owner', deviceId: 'd', tapId: 'app-2' })).toMatchObject({ ok: true });
    expect(w.j.entries.filter((e) => e.data.event === 'owner-item-check')).toHaveLength(2);
    expect(l.appTapPrecheck({ conversationKey: CK, kind: 'item', itemId: 'pr', checkRef: ref('pr', 'PR merged') })).toEqual({ ok: false, reason: 'not-owner-judged' });
    expect(l.appTapPrecheck({ conversationKey: CK, kind: 'item', itemId: 'feel', checkRef: ref('feel', 'old text') })).toEqual({ ok: false, reason: 'item-changed' });
    expect(l.appTapPrecheck({ conversationKey: CK, kind: 'item', itemId: 'nope', checkRef: feel })).toEqual({ ok: false, reason: 'no-item' });
    expect(bs(w).closed).toBe(false);
  });
  it('Finish needs every owner-judged item checked and the binding the owner saw, then closes through confirm-done', async () => {
    const w = w0(); bind(w); const l = loop(w);
    const bindingRef = hlcKey(bs(w).bindingHlc!);
    expect(l.checkIn({ renewedVia: 'app', principal: 'device:d' }).ok).toBe(true);
    expect(await l.appFinish({ conversationKey: CK, bindingRef })).toEqual({ ok: false, reason: 'not-all-checked' });
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a'); // the delegated item need not be checked
    expect(await l.appFinish({ conversationKey: CK, bindingRef: '1.0.m_x' })).toEqual({ ok: false, reason: 'project-changed' });
    w.prDone = 'fail';
    expect(await l.appFinish({ conversationKey: CK, bindingRef })).toEqual({ ok: false, reason: 'checks-fail', failing: ['PR merged'] });
    w.prDone = 'pass';
    expect(await l.appFinish({ conversationKey: CK, bindingRef })).toMatchObject({ ok: true });
    expect(bs(w).closed).toBe(true);
    expect(w.j.entries.some((e) => e.data.recordType === 'check-event' && e.data.note === 'owner-confirmed')).toBe(true);
  });
  it('Finish without a live check-in lease is refused by the shared steps (the route checks in first)', async () => {
    const w = w0(); bind(w); const l = loop(w);
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    expect(await l.appFinish({ conversationKey: CK, bindingRef: hlcKey(bs(w).bindingHlc!) })).toEqual({ ok: false, reason: 'chief-of-staff-paused' });
    expect(bs(w).closed).toBe(false);
  });
  it('a close write that is not durable answers not-recorded', async () => {
    const w = w0(); bind(w); const l = loop(w);
    l.checkIn({ renewedVia: 'app', principal: 'device:d' });
    checkItem(w, 'feel', 'Feels right on a phone', true, 'app-a');
    w.j.durableFails = true;
    expect(await l.appFinish({ conversationKey: CK, bindingRef: hlcKey(bs(w).bindingHlc!) })).toEqual({ ok: false, reason: 'not-recorded' });
  });
});

describe('the read: new row fields', () => {
  const row = (over: Partial<CosProjectRow> = {}): CosProjectRow => ({
    conversationKey: CK, title: 'Rows', goal: GOAL, lastVerdict: 'waiting-on-user', lastCheckAt: new Date(T0).toISOString(), parked: false,
    doneDefinition: [{ id: 'pr', text: 'PR merged', kind: 'deterministic' }, { id: 'feel', text: 'Feels right on a phone', kind: 'judgment', certify: 'owner-confirms' }, { id: 'deleg', text: 'Docs read well', kind: 'judgment', certify: 'agent-may-certify' }], doneItems: { pr: 'pass' },
    nextCheckAt: new Date(T0 + 24 * 60 * MIN).toISOString(), breakerTripped: false, restartsWithoutProgress: 0, ownerChecks: {}, bindingRef: '5.0.m_a',
    lastReport: { at: new Date(T0).toISOString(), note: 'every deterministic done item passes; judgment items pending', verdict: 'waiting-on-user' }, ...over,
  });
  const ctxNow = { here: true, tickMs: 14 * MIN, now: T0 + 5 * MIN };
  it('schema version unchanged (additive); existing fields keep their meaning', () => {
    const a = composeProjects([row({ ownerChecks: { feel: { at: 'x', who: 'owner' } } })], null, ctxNow);
    expect(a.schemaVersion).toBe(PROJECTS_SCHEMA_VERSION);
    expect(PROJECTS_SCHEMA_VERSION).toBe(1);
    const p = a.projects[0];
    expect(p.done.met).toBe(1); // an owner check is not a pass
    expect(p.done.items.find((i) => i.id === 'feel')).toMatchObject({ state: 'unknown', kind: 'owner-judged', stateWords: 'Checked by you', checkedByYou: { at: 'x' }, canMark: true, checkRef: ref('feel', 'Feels right on a phone') });
    expect(p.done.items.find((i) => i.id === 'deleg')).toMatchObject({ kind: 'agent-may-certify', stateWords: 'You let me certify this; until I can, it waits for you' });
    expect(p.done.items.find((i) => i.id === 'pr')).toMatchObject({ kind: 'check', stateWords: 'Passes', canMark: false, checkRef: null });
  });
  it('latest report: codes in words, never cut, and marked when that check was not confirmed', () => {
    expect(reportWords('gather-failed')).toBe("The last check could not read the project's evidence.");
    expect(reportWords('some-other-code')).toBe('The last check could not run.');
    const long = 'word '.repeat(99).trim();
    expect(reportWords(long)).toBe(long);
    const p = composeProjects([row({ lastVerdict: 'unknown', lastReport: { at: 'a', note: 'It looks stalled.', verdict: 'unknown' } })], null, ctxNow).projects[0];
    expect(p.latestReport).toEqual({ text: 'Not confirmed: It looks stalled.', at: 'a', confirmed: false });
  });
  it('waiting on you: what for, and the unchecked owner-judged items', () => {
    const p = composeProjects([row()], null, ctxNow).projects[0];
    expect(p.waitingOnYou).toEqual({ why: 'Every automatic check passes. It needs you to check 1 item.', items: ['feel'] });
    const q = composeProjects([row({ ownerChecks: { feel: { at: 'x', who: 'o' } } })], null, ctxNow).projects[0];
    expect(q.waitingOnYou?.why).toBe('Every automatic check passes and you checked the rest. Tap Finish to close it.');
    expect(q.actions.finish).toEqual({ allowed: true, why: null });
    expect(p.actions.finish).toEqual({ allowed: false, why: '1 item still needs your check.' });
    const r = composeProjects([row({ doneItems: { pr: 'fail' }, lastReport: { at: 'a', note: 'Waiting on the store review.', verdict: 'waiting-on-user' } })], null, ctxNow).projects[0];
    expect(r.waitingOnYou?.why).toBe('Waiting on the store review.');
    expect(r.actions.finish.allowed).toBe(false);
  });
  it('checks, stopped and actions', () => {
    const p = composeProjects([row({ lastVerdict: 'stalled', parked: true, restartsWithoutProgress: 3 })], null, ctxNow).projects[0];
    expect(p.state).toBe('stopped-retrying');
    expect(p.stopped).toMatchObject({ reason: 'no-progress', restarts: 3 });
    expect(p.checks).toMatchObject({ last: new Date(T0).toISOString(), here: true });
    expect(p.actions.checkNow).toEqual({ allowed: true, why: null, notBefore: new Date(T0 + 14 * MIN).toISOString() });
    expect(p.actions.pause).toBe('pause');
    const b = composeProjects([row({ lastVerdict: 'stalled', parked: true, breakerTripped: true })], null, { ...ctxNow, here: false }).projects[0];
    expect(b.stopped?.reason).toBe('breaker');
    expect(b.actions.checkNow.notBefore).toBeNull();
    const pause = { who: 'owner', at: 'x', quote: APP_PAUSE_QUOTE, messageRef: 'instar-app:d' };
    const pz = composeProjects([row({ pausedBy: pause })], null, ctxNow).projects[0];
    expect(pz.paused).toEqual({ at: 'x', quote: APP_PAUSE_QUOTE, via: 'app' });
    expect(pz.actions).toMatchObject({ pause: 'resume', checkNow: { allowed: false, why: 'It is paused.' } });
    expect(pz.checks).toMatchObject({ next: null, nextWords: 'Paused, so it is not checked' });
  });
  it('a queued Ask for an update moves the shown next check to its eligible tick', () => {
    const p = composeProjects([row({ checkRequested: true })], null, ctxNow).projects[0];
    expect(p.checks).toMatchObject({ next: new Date(T0 + 14 * MIN).toISOString(), nextWords: 'You asked for an update; checked on the next round', requested: { eligibleAt: new Date(T0 + 14 * MIN).toISOString() } });
    expect(composeProjects([row()], null, ctxNow).projects[0].checks.requested).toBeNull();
  });
  it('an automatic item that a check could not read says so; a duplicate id cannot be marked', () => {
    const p = composeProjects([row({ doneItems: { pr: 'unknown' } })], null, ctxNow).projects[0];
    expect(p.done.items.find((i) => i.id === 'pr')?.stateWords).toBe('Could not be checked at the last check');
    const n = composeProjects([row({ doneItems: null, lastCheckAt: null })], null, ctxNow).projects[0];
    expect(n.done.items.find((i) => i.id === 'pr')?.stateWords).toBe('Not checked yet');
    const dup = row({ doneDefinition: [...row().doneDefinition, { id: 'feel', text: 'Twin', kind: 'judgment', certify: 'owner-confirms' }] });
    const d = rowExtras(dup, projectState(dup), ctxNow).items.filter((i) => i.id === 'feel');
    expect(d.every((i) => !i.canMark && i.checkRef === null)).toBe(true);
  });
  it('an older loop row (no new fields) still composes', () => {
    const p = composeProjects([{ conversationKey: CK, title: 't', goal: 'g', lastVerdict: 'moving', lastCheckAt: null, parked: false, doneDefinition: [{ id: 'a', text: 'A' }], doneItems: null }], null, ctxNow).projects[0];
    expect(p.done.items[0]).toMatchObject({ kind: 'check', stateWords: 'Not checked yet' });
    expect(p.latestReport).toBeNull();
  });
});

describe('phone action lines', () => {
  const h = 'c'.repeat(64);
  it('builds the three project actions and their exact lines', () => {
    const a = buildAction('project-pause', 'slack:C0ABC:123', { value: 'pause', noteHash: h });
    expect(a.ok && actionLine(a.action)).toBe(`project-pause slack:C0ABC:123 pause ${h}`);
    const b = buildAction('project-pause', CK, { value: 'resume' });
    expect(b.ok && actionLine(b.action)).toBe(`project-pause ${CK} resume none`);
    const c = buildAction('project-item-check', CK, { itemId: 'an id with spaces', checkRef: h, value: 'checked' });
    expect(c.ok && actionLine(c.action)).toBe(`project-item-check ${CK} ${h} checked`);
    const d = buildAction('project-finish', CK, { bindingRef: '1763452800000.0.m_03b30f5b' });
    expect(d.ok && actionLine(d.action)).toBe(`project-finish ${CK} 1763452800000.0.m_03b30f5b`);
  });
  it('refuses bad parts', () => {
    expect(buildAction('project-pause', 'not a key', { value: 'pause' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('project-pause', CK, { value: 'stop' })).toEqual({ ok: false, error: 'bad-value' });
    expect(buildAction('project-pause', CK, { value: 'pause', noteHash: 'x' })).toEqual({ ok: false, error: 'bad-note-hash' });
    expect(buildAction('project-item-check', CK, { itemId: '', checkRef: h, value: 'checked' })).toEqual({ ok: false, error: 'bad-item' });
    expect(buildAction('project-item-check', CK, { itemId: 'a', checkRef: 'x', value: 'checked' })).toEqual({ ok: false, error: 'bad-check-ref' });
    expect(buildAction('project-item-check', CK, { itemId: 'a', checkRef: h, value: 'maybe' })).toEqual({ ok: false, error: 'bad-value' });
    expect(buildAction('project-finish', CK, { bindingRef: 'one two' })).toEqual({ ok: false, error: 'bad-binding-ref' });
  });
});
