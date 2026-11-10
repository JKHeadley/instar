/**
 * Chief of Staff check-in loop (docs/specs/chief-of-staff-topic.md §2.1–§2.9, §3, §4) with every
 * seam faked: scheduling (due by cadence / dirty gap), progress vs activity, judge skip, the
 * authority floors over the judge signal, every verdict's action through the protocol, the
 * brakes and per-tick cap, the lease gate (paused ⇒ no action, needs-you line), done
 * verification (deterministic vs judgment items), the note (sections, caps, silent day, the
 * pre-pause line), immediate-message budget, owner taps, and lease renewal + derivation.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, buildRenewal, foldIntentState, type UnionEntry, buildLastTick } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, applyVerdictFloors, detectProgress, planDue, composeNote, boundProjects, evidenceHash, type ChiefOfStaffLoopDeps, type EvidenceBundle, type JudgeOutput, type NoteItem, outcomeStarted, rejectionReason } from '../../src/core/ChiefOfStaffLoop.js';

const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-10T08:05:00Z'); // 08:xx so the note clock is "due" when localHour says 8
const H = 3_600_000;
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

class FakeJournal {
  entries: UnionEntry[] = []; clock = 1; seq = 0;
  emit(origin: string) {
    return (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
      const hlc: HlcTimestamp = { physical: ++this.clock, logical: 0, node: origin };
      const data = build(hlc, origin); if (!data) return { outcome: 'dropped' };
      const v = chiefOfStaffRecordStoreSchema.validate(data, ctx()); if (!v) return { outcome: 'dropped:schema' };
      this.entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin }, origin }); return { outcome: 'emitted', seq: ++this.seq };
    };
  }
}

interface World {
  j: FakeJournal; now: number; holds: boolean; enabled: boolean;
  bundle: Partial<EvidenceBundle>; judge: JudgeOutput | null | 'throw';
  claims: Array<{ conversationKey: string; action: string; text?: string }>; claimOutcome: 'started' | 'rejected';
  notes: string[]; immediates: string[]; mirrored: Array<[string, string]>; hour: number; settled: string[];
}

function bundle(w: World): EvidenceBundle {
  return { conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: 'none', unknown: false }, { id: 'tail', source: 'owner-message', ageMs: 1000, value: 'x', unknown: false, conversation: true }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: 'fail' }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0, ...w.bundle };
}

function world(over: Partial<World> = {}): World {
  return { j: new FakeJournal(), now: T0, holds: true, enabled: true, bundle: {}, judge: null, claims: [], claimOutcome: 'started', notes: [], immediates: [], mirrored: [], hour: 8, settled: [], ...over };
}

function loop(w: World, cfg: Partial<typeof CHIEF_OF_STAFF_LOOP_DEFAULTS> = {}): ChiefOfStaffLoop {
  const config = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS, ...cfg });
  const deps: ChiefOfStaffLoopDeps = {
    now: () => w.now, machineId: 'm_a', enabled: () => w.enabled, holdsLease: () => w.holds, config: () => config,
    journal: { emit: w.j.emit('m_a'), loadUnion: () => w.j.entries.slice() },
    verifyRenewal: (r) => String(r.machineSignature).startsWith('sig:'),
    gather: async () => bundle(w),
    judge: async () => { if (w.judge === 'throw') throw new Error('llm down'); return w.judge; },
    protocol: {
      claim: async ({ conversationKey, action, payload }) => { w.claims.push({ conversationKey, action, text: payload.text }); return w.claimOutcome === 'started' ? { outcome: 'started', runId: 'r' } : { outcome: 'rejected', reason: 'stand-down' }; },
      standDown: () => null,
      settleOpenIntent: async (st) => { w.settled.push(st.intentKey); return 'lost'; },
      operatorLeaseLive: () => true,
    } as unknown as ChiefOfStaffLoopDeps['protocol'],
    mirrorInitiativeStatus: (id, s) => { w.mirrored.push([id, s]); },
    sendNote: async (t) => { w.notes.push(t); },
    sendImmediate: async (t) => { w.immediates.push(t); },
    statusUrl: () => 'https://x/chief-of-staff',
    localHour: () => w.hour,
  };
  return new ChiefOfStaffLoop(deps);
}

function bind(w: World, over: Record<string, unknown> = {}) {
  w.j.emit('m_a')(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Ship the thing', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }], linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date(T0 - H).toISOString(), initiativeId: 'init-1', ...over } as never));
}
function renew(w: World, atMs: number, ok = true) {
  w.j.emit('m_a')(`renewal:${atMs}`, buildRenewal({ renewedAt: new Date(atMs).toISOString(), renewedVia: 'telegram', principal: 'owner:1', machine: 'm_a', machineSignature: ok ? 'sig:good' : 'bad' }));
}
const checks = (w: World) => w.j.entries.filter((e) => e.data.recordType === 'check-event').map((e) => e.data.verdict);

describe('clampLoopConfig', () => {
  it('applies the floors and the breaker upper bound', () => {
    const c = clampLoopConfig({ tickMinutes: 1, minCadenceHours: 0.1, breakerRestartsPerWeek: 9999, maxRunHours: 0, noteTime: 'bogus' });
    expect(c.tickMinutes).toBe(5); expect(c.minCadenceHours).toBe(1); expect(c.breakerRestartsPerWeek).toBe(Math.floor((7 * 24 * 60) / 5 / 10)); expect(c.maxRunHours).toBe(0.25); expect(c.noteTime).toBe('08:00');
  });
});

describe('pure pieces', () => {
  it('applyVerdictFloors: no judge ⇒ unknown; unresolvable citation ⇒ unknown; stalled on conversation-only evidence ⇒ unknown; done-verified from a judge ⇒ claims-done', () => {
    const w = world(); const b = bundle(w);
    expect(applyVerdictFloors(null, b, H).verdict).toBe('unknown');
    expect(applyVerdictFloors({ verdict: 'stalled', citedIds: ['nope'], reason: 'r' }, b, H).floored).toBe('unresolvable-citation');
    expect(applyVerdictFloors({ verdict: 'stalled', citedIds: ['tail'], reason: 'r' }, b, H).verdict).toBe('unknown');
    expect(applyVerdictFloors({ verdict: 'stalled', citedIds: ['run'], reason: 'r' }, b, H).verdict).toBe('stalled');
    expect(applyVerdictFloors({ verdict: 'done-verified', citedIds: ['run'], reason: 'r' }, b, H).verdict).toBe('claims-done');
    expect(applyVerdictFloors({ verdict: 'moving', citedIds: [], reason: 'r' }, b, H).verdict).toBe('moving');
  });
  it('detectProgress: merged PR, done flip, or net diff past the high-water mark; churn and shrink are activity', () => {
    const w = world(); const b = bundle(w);
    expect(detectProgress({ ...b, netDiffLines: 25 }, null, 20, null).progress).toBe(true);
    expect(detectProgress({ ...b, netDiffLines: 25 }, { netDiffHighWater: 30 } as never, 20, null).progress).toBe(false);
    expect(detectProgress({ ...b, mergedPrsSinceLastCheck: 1 }, null, 20, null).progress).toBe(true);
    expect(detectProgress({ ...b, doneItems: { pr: 'pass' } }, null, 20, { pr: 'fail' }).progress).toBe(true);
    expect(detectProgress({ ...b, doneItems: { pr: 'pass' } }, null, 20, { pr: 'pass' }).progress).toBe(false);
  });
  it('planDue: never-checked projects are due; cadence due; dirty due only past the gap', () => {
    const p = { conversationKey: CK } as never;
    expect(planDue([p], new Map(), new Set(), T0, 30)).toHaveLength(1);
    const st = { lastCheckAt: new Date(T0 - 2 * H).toISOString(), nextCheckAt: new Date(T0 + 20 * H).toISOString() } as never;
    expect(planDue([p], new Map([[CK, st]]), new Set(), T0, 30)).toHaveLength(0);
    expect(planDue([p], new Map([[CK, st]]), new Set([CK]), T0, 30)).toHaveLength(1);
    const recent = { lastCheckAt: new Date(T0 - 10 * 60_000).toISOString(), nextCheckAt: new Date(T0 + 20 * H).toISOString() } as never;
    expect(planDue([p], new Map([[CK, recent]]), new Set([CK]), T0, 30)).toHaveLength(0);
  });
  it('composeNote: sections capped with +N more; empty ⇒ null; the one pre-pause line', () => {
    const items: NoteItem[] = Array.from({ length: 7 }, (_, i) => ({ kind: 'needs-you' as const, text: `item ${i}` }));
    const t = composeNote(items, 5, 'https://x', null)!;
    expect(t).toContain('Needs you'); expect(t).toContain('+2 more: https://x'); expect(t).not.toContain('item 6');
    expect(composeNote([], 5, 'https://x', null)).toBeNull();
    expect(composeNote([], 5, 'https://x', 10 * H)).toMatch(/pause in about 10h/);
    expect(composeNote([], 5, 'https://x', 30 * H)).toBeNull();
  });
  it('boundProjects: only confirmed, open bindings', () => {
    const w = world(); bind(w); expect(boundProjects(w.j.entries)).toHaveLength(1);
    const w2 = world(); bind(w2, { confirmedBy: undefined, confirmedAt: undefined }); expect(boundProjects(w2.j.entries)).toHaveLength(0);
  });
});

describe('ChiefOfStaffLoop — gates', () => {
  it('does nothing when disabled or not the lease holder', async () => {
    const w = world({ enabled: false }); bind(w); const l = loop(w); await l.tick(); expect(checks(w)).toEqual([]);
    const w2 = world({ holds: false }); bind(w2); await loop(w2).tick(); expect(checks(w2)).toEqual([]);
  });
  it('lease: no renewals ⇒ paused; a stalled verdict then produces a needs-you line and NO claim', async () => {
    const w = world({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'nothing moved' } }); bind(w);
    const l = loop(w); await l.tick();
    expect(w.claims).toEqual([]); expect(checks(w)).toEqual(['stalled']);
    expect(l.status().lease.live).toBe(false);
    // The note (clock is at 08) carries the paused line.
    expect(w.notes.join('\n')).toMatch(/paused; check in here/);
  });
  it('lease: a signature-valid renewal makes it live; an invalid one does not', async () => {
    const w = world(); renew(w, T0 - H, false); expect(loop(w).lease(T0).live).toBe(false);
    renew(w, T0 - H, true); expect(loop(w).lease(T0).live).toBe(true);
    expect(loop(w).lease(T0 + 72 * H).live).toBe(false);
  });
  it('recordRenewal writes a renewal signed by this machine', async () => {
    const w = world(); const l = loop(w);
    expect(l.recordRenewal({ renewedVia: 'telegram', principal: 'owner:1', sign: (c) => `sig:${c.length}` })).toBe(true);
    expect(l.lease(T0).live).toBe(true);
  });
});

describe('ChiefOfStaffLoop — verdicts → actions (lease live)', () => {
  const live = (over: Partial<World> = {}) => { const w = world(over); bind(w); renew(w, T0 - H); return w; };
  it('stalled with no live session ⇒ restart-run claim with the goal and remaining items', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'quiet' } }); await loop(w).tick();
    expect(w.claims).toHaveLength(1); expect(w.claims[0].action).toBe('restart-run'); expect(w.claims[0].text).toContain('Ship the thing'); expect(w.claims[0].text).toContain('PR merged');
  });
  it('stalled with a live session ⇒ restart-inject', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'quiet' }, bundle: { liveSession: true } }); await loop(w).tick();
    expect(w.claims[0].action).toBe('restart-inject');
  });
  it('drifting ⇒ redirect carrying the goal, the remaining items and the cited evidence ids — never the judge\'s free text (§2.6)', async () => {
    const w = live({ judge: { verdict: 'drifting', citedIds: ['run'], reason: 'working on docs instead' } }); await loop(w).tick();
    expect(w.claims[0].action).toBe('redirect'); expect(w.claims[0].text).toContain('Ship the thing'); expect(w.claims[0].text).toContain('run'); expect(w.claims[0].text).not.toContain('working on docs instead');
  });
  it('moving ⇒ no claim, check recorded', async () => {
    const w = live({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'pr opened' } }); await loop(w).tick();
    expect(w.claims).toEqual([]); expect(checks(w)).toEqual(['moving']);
  });
  it('judge unavailable ⇒ unknown, no claim; three in a row ⇒ one "can\'t see" line', async () => {
    const w = live({ judge: 'throw' }); const l = loop(w);
    for (let i = 0; i < 3; i++) { w.bundle = { netDiffLines: i }; await l.tick(); w.now += 25 * H; }
    expect(w.claims).toEqual([]); expect(checks(w)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(w.notes.join('\n')).toMatch(/Can't see/);
  });
  it('unchanged evidence carries the previous verdict forward without calling the judge', async () => {
    let calls = 0; const w = live({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'r' } });
    const l = loop(w); (l as unknown as { d: ChiefOfStaffLoopDeps }).d.judge = async () => { calls++; return w.judge as JudgeOutput; };
    await l.tick(); w.now += 25 * H; await l.tick();
    expect(calls).toBe(1); expect(checks(w)).toEqual(['moving', 'moving']);
  });
  it('every deterministic item passing and no judgment items ⇒ done-verified: closed, mirrored, result line (no judge call)', async () => {
    const w = live({ bundle: { doneItems: { pr: 'pass' } } }); await loop(w).tick();
    expect(checks(w)).toEqual(['done-verified']); expect(w.mirrored).toEqual([['init-1', 'completed']]);
    expect(boundProjects(w.j.entries)).toHaveLength(0); // closed bindings are no longer bound
    expect(w.notes.join('\n')).toMatch(/Finished and verified/);
  });
  it('judgment item marked owner-confirms ⇒ waiting-on-user with a Confirm done action, nothing closed', async () => {
    const w = world({ bundle: { doneItems: { pr: 'pass' } } }); renew(w, T0 - H);
    bind(w, { doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }, { id: 'ok', kind: 'judgment', text: 'Owner happy' }] });
    await loop(w).tick();
    expect(checks(w)).toEqual(['waiting-on-user']); expect(w.mirrored).toEqual([]); expect(w.notes.join('\n')).toMatch(/Confirm it's done/);
  });
  it('claims-done with a failing deterministic item ⇒ redirect; a second refutation ⇒ needs-you', async () => {
    const w = live({ judge: { verdict: 'claims-done', citedIds: ['run'], reason: 'says done' } }); const l = loop(w);
    await l.tick(); expect(w.claims[0]?.action).toBe('redirect');
    w.now += 25 * H; w.bundle = { netDiffLines: 1 }; await l.tick();
    expect(w.claims).toHaveLength(1); expect(w.notes.join('\n')).toMatch(/still fail/);
  });
  it('per-tick restart cap: a third stalled project waits for the next tick', async () => {
    const w = world({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'q' } }); renew(w, T0 - H);
    for (const k of ['telegram:1', 'telegram:2', 'telegram:3']) w.j.emit('m_a')(`binding:${k}`, buildBindingPut({ conversationKey: k, goal: `g ${k}`, checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR' }], linked: {}, confirmedBy: 'owner', confirmedAt: new Date(T0 - H).toISOString() }));
    const l = loop(w, { restartsPerTick: 2 }); await l.tick();
    expect(w.claims).toHaveLength(2);
    w.now += 16 * 60_000; await l.tick(); // dirty ⇒ due after the gap? gap is 30 min: not yet
    expect(w.claims).toHaveLength(2);
    w.now += 20 * 60_000; await l.tick();
    expect(w.claims).toHaveLength(3);
  });
  it('a parked project is never restarted; the note offers Unpark; an owner tap unparks', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'q' } });
    // Three prior attempts without progress: write intents + started outcomes by hand.
    const { buildIntent, buildOutcome } = await import('../../src/core/ChiefOfStaffStore.js');
    for (let s = 1; s <= 3; s++) {
      w.j.emit('m_a')(`${CK}:1:${s}`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: s, claimedAt: new Date(T0 - (4 - s) * H).toISOString(), machine: 'm_a', holderSignature: 's' }));
      w.j.emit('m_a')(`${CK}:1:${s}:outcome:executing`, buildOutcome({ intentKey: `${CK}:1:${s}`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString() }));
      w.j.emit('m_a')(`${CK}:1:${s}:outcome:started`, buildOutcome({ intentKey: `${CK}:1:${s}`, transition: 'started', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString(), runId: `r${s}` }));
    }
    const l = loop(w); await l.tick();
    expect(w.claims).toEqual([]); expect(w.notes.join('\n')).toMatch(/parked after 3 restarts/);
    expect(await l.ownerTap(`cos:unpark:${CK}`, 'owner-tap')).toBe('ok');
    expect(w.j.entries.some((e) => e.data.recordType === 'binding-lifecycle' && e.data.event === 'unpark' && e.data.by === 'owner-tap')).toBe(true);
  });
  it('open intents older than a tick are settled before acting', async () => {
    const w = live({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'r' } });
    const { buildIntent } = await import('../../src/core/ChiefOfStaffStore.js');
    w.j.emit('m_a')(`${CK}:1:9`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: 9, claimedAt: new Date(T0 - H).toISOString(), machine: 'm_a', holderSignature: 's' }));
    await loop(w).tick();
    expect(w.settled).toEqual([`${CK}:1:9`]);
  });
});

describe('ChiefOfStaffLoop — note + immediate budget + owner tap', () => {
  it('a quiet day sends no note; the note goes out only at the configured hour', async () => {
    const w = world({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'r' }, hour: 13 }); bind(w); renew(w, T0 - H);
    const l = loop(w); await l.tick(); expect(w.notes).toEqual([]);
    w.hour = 8; w.now += 25 * H; await l.tick(); expect(w.notes).toEqual([]); // moving ⇒ nothing to say, lease has 46h left
  });
  it('immediate messages are budgeted; overflow goes to the note', async () => {
    const w = world(); const l = loop(w, { immediateMessagesPerDay: 2 });
    expect(await l.immediate('a')).toBe(true); expect(await l.immediate('b')).toBe(true); expect(await l.immediate('c')).toBe(false);
    expect(w.immediates).toEqual(['a', 'b']);
  });
  it('a non-owner tap is ignored; a confirm-done tap closes and mirrors', async () => {
    const w = world(); bind(w); const l = loop(w);
    expect(await l.ownerTap(`cos:confirm-done:${CK}`, 'member' as never)).toBe('ignored');
    expect(await l.ownerTap(`cos:confirm-done:${CK}`, 'owner-tap')).toBe('ok');
    expect(w.mirrored).toEqual([['init-1', 'completed']]); expect(boundProjects(w.j.entries)).toHaveLength(0);
  });
  it('evidenceHash is stable for equal bundles and differs when evidence changes', () => {
    const w = world(); const a = evidenceHash(bundle(w)); const b = evidenceHash(bundle(w)); expect(a).toBe(b);
    expect(evidenceHash({ ...bundle(w), netDiffLines: 3 })).not.toBe(a);
  });
  it('status() reports the tick, lease and project count', async () => {
    const w = world({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'r' } }); bind(w); renew(w, T0 - H);
    const l = loop(w); await l.tick(); const s = l.status();
    expect(s.ticks).toBe(1); expect(s.projects).toBe(1); expect(s.lease.live).toBe(true); expect(s.lastTickMachine).toBe('m_a');
    expect(foldIntentState(w.j.entries).size).toBe(0);
  });
});

describe('ChiefOfStaffLoop — second-pass review fixes (2026-11-09)', () => {
  const live = (over: Partial<World> = {}) => { const w = world(over); bind(w); renew(w, T0 - H); return w; };
  it('a judgment item marked agent-may-certify still pends on the owner: waiting-on-user, nothing closed, no mirror', async () => {
    const w = live({ bundle: { doneItems: { pr: 'pass' } } });
    bind(w, { doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }, { id: 'ok', kind: 'judgment', text: 'owner happy', certify: 'agent-may-certify' }] });
    await loop(w).tick();
    expect(checks(w)).toEqual(['waiting-on-user']); expect(w.mirrored).toEqual([]); expect(w.claims).toEqual([]);
    expect(w.j.entries.some((e) => e.data.recordType === 'binding-lifecycle')).toBe(false);
  });
  it('detectProgress: no durable baseline ⇒ a passing item is NOT a flip (restart caps survive a process restart)', () => {
    const b = { ...bundle(world()), doneItems: { pr: 'pass' as const } };
    expect(detectProgress(b, null, 20, null).progress).toBe(false);
    expect(detectProgress(b, null, 20, { pr: 'fail' }).progress).toBe(true);
    expect(detectProgress(b, null, 20, { pr: 'pass' }).progress).toBe(false);
  });
  it('the check-event carries doneItems and the next tick reads the baseline from the FOLD, not memory', async () => {
    const w = live({ judge: { verdict: 'moving', citedIds: ['run'], reason: 'r' }, bundle: { doneItems: { pr: 'fail' } } });
    await loop(w).tick();
    const first = w.j.entries.find((e) => e.data.recordType === 'check-event')!;
    expect(first.data.doneItems).toEqual({ pr: 'fail' });
    w.now += 25 * H; w.bundle = { doneItems: { pr: 'pass' } }; w.judge = { verdict: 'moving', citedIds: ['run'], reason: 'r2' };
    await loop(w).tick(); // a NEW loop instance: no in-memory baseline
    const second = w.j.entries.filter((e) => e.data.recordType === 'check-event').pop()!;
    expect(second.data.progressSeen).toBe(true);
  });
  it('applyVerdictFloors: an item with unknown age cannot make stalled fresh', () => {
    const b = { ...bundle(world()), items: [{ id: 'run', source: 'run' as const, ageMs: null, value: 'none', unknown: false }] };
    expect(applyVerdictFloors({ verdict: 'stalled', citedIds: ['run'], reason: 'r' }, b, H).verdict).toBe('unknown');
  });
  it('outcomeStarted / rejectionReason: routed counts only when the owner actually started; rejections surface', () => {
    expect(outcomeStarted({ outcome: 'routed', result: { outcome: 'started', runId: 'r' } } as never)).toBe(true);
    expect(outcomeStarted({ outcome: 'routed', result: { outcome: 'rejected', reason: 'lagging-fold' } } as never)).toBe(false);
    expect(rejectionReason({ outcome: 'routed', result: { outcome: 'rejected', reason: 'lagging-fold' } } as never)).toBe('lagging-fold');
    expect(rejectionReason({ outcome: 'started', runId: 'r' } as never)).toBeNull();
  });
  it('a routed claim the owner rejected is not a restart and lands in the note as a can\'t-see line', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'quiet' } });
    const l = loop(w);
    (l as unknown as { d: { protocol: { claim: unknown } } }).d.protocol.claim = async () => ({ outcome: 'routed', owner: 'm_b', result: { outcome: 'rejected', reason: 'lagging-fold' } });
    await l.tick();
    w.now += 1; w.hour = 8; await l.tick();
    expect(w.notes.join('\n')).toContain('lagging-fold');
  });
  it('grace tick: when the newest last-tick was another machine\'s, the first tick checks but does not act; the next tick acts', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'quiet' } });
    w.j.emit('m_b')('last-tick:m_b', buildLastTick('m_b', new Date(T0 - 15 * 60_000).toISOString()));
    const l = loop(w);
    await l.tick();
    expect(checks(w)).toEqual(['stalled']); expect(w.claims).toEqual([]);
    w.now += 25 * H; await l.tick();
    expect(w.claims).toHaveLength(1);
  });
  it('a check the journal did not accept ⇒ no action this tick', async () => {
    const w = live({ judge: { verdict: 'stalled', citedIds: ['run'], reason: 'quiet' } });
    const l = loop(w);
    const realEmit = (l as unknown as { d: { journal: { emit: (k: string, b: never) => { outcome: string; seq?: number } } } }).d.journal.emit;
    (l as unknown as { d: { journal: { emit: unknown } } }).d.journal.emit = (k: string, b: never) => (k.startsWith('check:') ? { outcome: 'dropped:schema' } : realEmit(k, b));
    await l.tick();
    expect(w.claims).toEqual([]);
  });
  it('the note goes out on the first tick AT OR AFTER the note hour, not only inside it', async () => {
    const w = live({ judge: { verdict: 'waiting-on-user', citedIds: ['run'], reason: 'needs a decision' }, hour: 11 });
    await loop(w).tick();
    expect(w.notes).toHaveLength(1);
  });
});
