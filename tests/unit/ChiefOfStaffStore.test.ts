/**
 * Chief of Staff store (docs/specs/chief-of-staff-topic.md §1.2, §2.4, §2.7) — the pure
 * half: schema, builders, legal transitions and the folds that derive every mutable view
 * from immutable event records. Both sides of every decision boundary are covered, and the
 * convergence tests prove arrival order cannot change a derived view.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import {
  CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY,
  chiefOfStaffRecordStoreSchema, LEGAL_TRANSITIONS, isLegalTransition,
  buildTreePut, buildTreeTombstone, buildBindingPut, buildLifecycleEvent, buildCheckEvent, buildIntent, buildOutcome, buildRenewal, buildGraduation, buildLastTick,
  foldBindingState, foldIntentState, foldProjectCheckState, deriveLeaseExpiry, foldLastTicks, latestPerKey, deriveIntentKey, deriveOutcomeKey,
  type UnionEntry,
} from '../../src/core/ChiefOfStaffStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';

const hlc = (physical: number, logical = 0, node = 'm_a'): HlcTimestamp => ({ physical, logical, node });
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });
const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-09T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const SHA = 'a'.repeat(64);

function entry(build: (h: HlcTimestamp, o: string) => Record<string, unknown> | null, h: HlcTimestamp, origin = h.node): UnionEntry {
  const data = build(h, origin);
  if (!data) throw new Error('builder returned null');
  const validated = chiefOfStaffRecordStoreSchema.validate(data, ctx());
  if (!validated) throw new Error(`schema rejected: ${JSON.stringify(data)}`);
  return { data: { ...validated, recordKey: data.recordKey, hlc: data.hlc, op: data.op, origin: data.origin }, origin };
}

const bindingInput = {
  conversationKey: CK, goal: 'Ship the thing', checkCadenceHours: 24,
  doneDefinition: [{ id: 'pr', kind: 'deterministic' as const, text: 'PR merged' }, { id: 'ok', kind: 'judgment' as const, text: 'Owner happy' }],
  linked: { repos: ['JKHeadley/instar'], branches: ['echo/x'] }, confirmedBy: 'owner' as const, confirmedAt: iso(T0),
};

describe('ChiefOfStaffStore — registration + retention', () => {
  it('registers kind + store + schema, and the kind is in the static JOURNAL_KINDS half', () => {
    expect(CHIEF_OF_STAFF_KIND_REGISTRATION.kind).toBe('chief-of-staff-record');
    expect(CHIEF_OF_STAFF_KIND_REGISTRATION.store).toBe('chiefOfStaff');
    expect(CHIEF_OF_STAFF_KIND_REGISTRATION.schema).toBe(chiefOfStaffRecordStoreSchema);
    expect(JOURNAL_KINDS).toContain(CHIEF_OF_STAFF_RECORD_KIND);
    expect(CHIEF_OF_STAFF_STORE_KEY).toBe('chiefOfStaff');
  });
  it('retention is never-delete (rotateKeep 0) at 8 MiB — a dropped archive would erase bindings and the breaker window', () => {
    expect(DEFAULT_RETENTION['chief-of-staff-record']).toEqual({ maxFileBytes: 8 * 1024 * 1024, rotateKeep: 0 });
  });
});

describe('ChiefOfStaffStore — schema (both sides of each boundary)', () => {
  it('accepts every record type via its builder', () => {
    expect(() => entry(buildTreePut(CK, 'app:cos', 'project'), hlc(1))).not.toThrow();
    expect(() => entry(buildBindingPut(bindingInput), hlc(2))).not.toThrow();
    expect(() => entry(buildLifecycleEvent(CK, 'closed', hlc(2), 'chief-of-staff', iso(T0)), hlc(3))).not.toThrow();
    expect(() => entry(buildCheckEvent({ conversationKey: CK, verdict: 'moving', evidenceHash: SHA, evidenceIds: ['pr#1'], progressSeen: true, machine: 'm_a', at: iso(T0) }), hlc(4))).not.toThrow();
    expect(() => entry(buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: 1, claimedAt: iso(T0), machine: 'm_a', holderSignature: 'sig' }), hlc(5))).not.toThrow();
    expect(() => entry(buildOutcome({ intentKey: `${CK}:1:1`, transition: 'executing', writer: 'ownership-machine', machine: 'm_b', at: iso(T0) }), hlc(6))).not.toThrow();
    expect(() => entry(buildRenewal({ renewedAt: iso(T0), renewedVia: 'telegram', principal: 'owner:1', machine: 'm_a', machineSignature: 'sig' }), hlc(7))).not.toThrow();
    expect(() => entry(buildGraduation('2026-11-23', { restarts: 3 }, 'pass'), hlc(8))).not.toThrow();
    expect(() => entry(buildLastTick('m_a', iso(T0)), hlc(9))).not.toThrow();
  });
  it('rejects an unknown recordType, a bad conversation key, and a path-shaped machine', () => {
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'bogus' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'tree', conversationKey: '../etc', parentConversationKey: null }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'last-tick', machine: '../x', tickAt: iso(T0) }, ctx())).toBeNull();
    expect(buildTreePut('not-a-key', null)(hlc(1), 'm_a')).toBeNull();
  });
  it('rejects a binding without a done definition, with a cadence under 1h, or a non-owner confirmedBy', () => {
    const base = buildBindingPut(bindingInput)(hlc(1), 'm_a')!;
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, doneDefinition: [] }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, checkCadenceHours: 0.5 }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, confirmedBy: 'member' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...base, doneDefinition: [{ id: 'x', kind: 'judgment', text: 't', certify: 'anyone' }] }, ctx())).toBeNull();
  });
  it('judgment items default to owner-confirms', () => {
    const v = chiefOfStaffRecordStoreSchema.validate(buildBindingPut(bindingInput)(hlc(1), 'm_a')!, ctx())!;
    const items = v.doneDefinition as Array<{ id: string; certify?: string }>;
    expect(items.find((i) => i.id === 'ok')?.certify).toBe('owner-confirms');
  });
  it('rejects an outcome whose transition is `claimed`, or whose writer is not a known role', () => {
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'outcome', intentKey: 'k', transition: 'claimed', writer: 'holder', machine: 'm', at: iso(T0) }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ recordType: 'outcome', intentKey: 'k', transition: 'started', writer: 'anyone', machine: 'm', at: iso(T0) }, ctx())).toBeNull();
  });
  it('rejects a check-event with a non-sha256 evidence hash or an unknown verdict', () => {
    const ok = buildCheckEvent({ conversationKey: CK, verdict: 'moving', evidenceHash: SHA, evidenceIds: [], progressSeen: false, machine: 'm_a', at: iso(T0) })(hlc(1), 'm_a')!;
    expect(chiefOfStaffRecordStoreSchema.validate({ ...ok, evidenceHash: 'nope' }, ctx())).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate({ ...ok, verdict: 'fine' }, ctx())).toBeNull();
  });
  it('a tree tombstone carries only deletedAt', () => {
    const d = buildTreeTombstone(CK, iso(T0))(hlc(1), 'm_a')!;
    expect(d.op).toBe('delete');
    expect(chiefOfStaffRecordStoreSchema.validate(d, ctx())).toEqual({ recordType: 'tree', deletedAt: iso(T0) });
  });
  it('keys: intent and outcome keys are derived, and invalid inputs yield null', () => {
    expect(deriveIntentKey(CK, 3, 7)).toBe(`${CK}:3:7`);
    expect(deriveIntentKey(CK, -1, 7)).toBeNull();
    expect(deriveOutcomeKey(`${CK}:3:7`, 'started')).toBe(`${CK}:3:7:outcome:started`);
  });
});

describe('ChiefOfStaffStore — LEGAL_TRANSITIONS', () => {
  it('encodes the §1.2 table', () => {
    expect(isLegalTransition('claimed', 'executing')).toBe(true);
    expect(isLegalTransition('executing', 'started')).toBe(true);
    expect(isLegalTransition('executing', 'rejected')).toBe(true);
    expect(isLegalTransition('started', 'superseded')).toBe(true);
    expect(isLegalTransition('rejected', 'lost')).toBe(true);
    expect(isLegalTransition('claimed', 'lost')).toBe(false);
    expect(isLegalTransition('executing', 'lost')).toBe(false);
    expect(isLegalTransition('claimed', 'started')).toBe(false);
    expect(isLegalTransition('started', 'rejected')).toBe(false);
    expect(isLegalTransition('lost', 'started')).toBe(false);
    expect(LEGAL_TRANSITIONS.aborted).toEqual([]);
  });
});

describe('ChiefOfStaffStore — foldBindingState', () => {
  const binding = entry(buildBindingPut(bindingInput), hlc(100));
  it('no lifecycle ⇒ open and confirmed', () => {
    const st = foldBindingState([binding]).get(CK)!;
    expect(st.confirmed).toBe(true); expect(st.closed).toBe(false);
  });
  it('a closed event whose bindingHlc matches the winning binding closes the project', () => {
    const closed = entry(buildLifecycleEvent(CK, 'closed', hlc(100), 'chief-of-staff', iso(T0)), hlc(200));
    expect(foldBindingState([binding, closed]).get(CK)!.closed).toBe(true);
  });
  it('a closed event verified against an OLDER binding is invalid once the owner edits the binding', () => {
    const closed = entry(buildLifecycleEvent(CK, 'closed', hlc(100), 'chief-of-staff', iso(T0)), hlc(200));
    const edited = entry(buildBindingPut({ ...bindingInput, goal: 'Ship the better thing' }), hlc(150, 0, 'm_b'));
    expect(foldBindingState([binding, closed, edited]).get(CK)!.closed).toBe(false);
  });
  it('reopened and unpark count only from an owner tap', () => {
    const closed = entry(buildLifecycleEvent(CK, 'closed', hlc(100), 'chief-of-staff', iso(T0)), hlc(200));
    const cosReopen = entry(buildLifecycleEvent(CK, 'reopened', hlc(100), 'chief-of-staff', iso(T0 + H)), hlc(300));
    expect(foldBindingState([binding, closed, cosReopen]).get(CK)!.closed).toBe(true);
    const ownerReopen = entry(buildLifecycleEvent(CK, 'reopened', hlc(100), 'owner-tap', iso(T0 + H)), hlc(300));
    expect(foldBindingState([binding, closed, ownerReopen]).get(CK)!.closed).toBe(false);
    const cosUnpark = entry(buildLifecycleEvent(CK, 'unpark', hlc(100), 'chief-of-staff', iso(T0 + H)), hlc(400));
    expect(foldBindingState([binding, cosUnpark]).get(CK)!.lastUnparkAt).toBeNull();
    const ownerUnpark = entry(buildLifecycleEvent(CK, 'unpark', hlc(100), 'owner-tap', iso(T0 + H)), hlc(400));
    expect(foldBindingState([binding, ownerUnpark]).get(CK)!.lastUnparkAt).toBe(iso(T0 + H));
  });
  it('a draft binding (no owner confirm) is not confirmed', () => {
    const draft = entry(buildBindingPut({ ...bindingInput, confirmedBy: undefined, confirmedAt: undefined }), hlc(100));
    expect(foldBindingState([draft]).get(CK)!.confirmed).toBe(false);
  });
});

describe('ChiefOfStaffStore — foldIntentState (transition log)', () => {
  const key = `${CK}:1:1`;
  const intent = entry(buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: 1, claimedAt: iso(T0), machine: 'm_a', holderSignature: 'sig' }), hlc(10));
  const out = (transition: Parameters<typeof buildOutcome>[0]['transition'], writer: 'ownership-machine' | 'holder', h: number, extra: Record<string, string> = {}) =>
    entry(buildOutcome({ intentKey: key, transition, writer, machine: writer === 'holder' ? 'm_a' : 'm_b', at: iso(T0 + h), ...extra }), hlc(h));

  it('claimed → executing → started, with the run id carried', () => {
    const st = foldIntentState([intent, out('executing', 'ownership-machine', 20), out('started', 'ownership-machine', 30, { runId: 'run-1' })]).get(key)!;
    expect(st.state).toBe('started'); expect(st.runId).toBe('run-1'); expect(st.open).toBe(false);
  });
  it('an open intent (claimed or executing) blocks; settled ones do not', () => {
    expect(foldIntentState([intent]).get(key)!.open).toBe(true);
    expect(foldIntentState([intent, out('executing', 'ownership-machine', 20)]).get(key)!.open).toBe(true);
    expect(foldIntentState([intent, out('rejected', 'ownership-machine', 20)]).get(key)!.open).toBe(false);
  });
  it('`lost` is ignored unless written by the holder AFTER a `rejected`', () => {
    expect(foldIntentState([intent, out('lost', 'holder', 20)]).get(key)!.state).toBe('claimed');
    expect(foldIntentState([intent, out('lost', 'ownership-machine', 20)]).get(key)!.state).toBe('claimed');
    expect(foldIntentState([intent, out('rejected', 'ownership-machine', 20), out('lost', 'holder', 30)]).get(key)!.state).toBe('lost');
  });
  it('an illegal transition is ignored (claimed → started without executing)', () => {
    expect(foldIntentState([intent, out('started', 'ownership-machine', 20, { runId: 'r' })]).get(key)!.state).toBe('claimed');
  });
  it('a wrong-writer transition is ignored (holder writing started)', () => {
    expect(foldIntentState([intent, out('executing', 'ownership-machine', 20), out('started', 'holder', 30)]).get(key)!.state).toBe('executing');
  });
  it('started → superseded (fence failed after spawn) → aborted is legal', () => {
    const st = foldIntentState([intent, out('executing', 'ownership-machine', 20), out('started', 'ownership-machine', 30, { runId: 'r' }), out('superseded', 'ownership-machine', 40), out('aborted', 'ownership-machine', 50)]).get(key)!;
    expect(st.state).toBe('aborted');
  });
  it('arrival order never changes the terminal state (convergence)', () => {
    const recs = [intent, out('executing', 'ownership-machine', 20), out('started', 'ownership-machine', 30, { runId: 'r' }), out('rejected', 'ownership-machine', 25), out('lost', 'holder', 35)];
    const a = foldIntentState(recs).get(key)!;
    const b = foldIntentState(recs.slice().reverse()).get(key)!;
    const c = foldIntentState([recs[3], recs[4], recs[1], recs[0], recs[2]]).get(key)!;
    expect(a.state).toBe(b.state); expect(b.state).toBe(c.state);
    // executing → started is legal and ranks before rejected; from `started`, rejected is illegal, so lost never applies.
    expect(a.state).toBe('started');
  });
});

describe('ChiefOfStaffStore — foldProjectCheckState (brakes)', () => {
  const cfg = { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 };
  const check = (h: number, progress: boolean, hw?: number) => entry(buildCheckEvent({ conversationKey: CK, verdict: progress ? 'moving' : 'stalled', evidenceHash: SHA, evidenceIds: [], progressSeen: progress, netDiffHighWater: hw, machine: 'm_a', at: iso(T0 + h) }), hlc(h));
  const attempt = (seq: number, h: number, settled: 'started' | 'lost' | 'rejected' = 'started') => {
    const k = `${CK}:1:${seq}`;
    const recs = [entry(buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: seq, claimedAt: iso(T0 + h), machine: 'm_a', holderSignature: 's' }), hlc(h))];
    if (settled === 'started') recs.push(entry(buildOutcome({ intentKey: k, transition: 'executing', writer: 'ownership-machine', machine: 'm_b', at: iso(T0 + h + 1) }), hlc(h + 1)), entry(buildOutcome({ intentKey: k, transition: 'started', writer: 'ownership-machine', machine: 'm_b', at: iso(T0 + h + 2), runId: `r${seq}` }), hlc(h + 2)));
    else if (settled === 'lost') recs.push(entry(buildOutcome({ intentKey: k, transition: 'rejected', writer: 'ownership-machine', machine: 'm_b', at: iso(T0 + h + 1) }), hlc(h + 1)), entry(buildOutcome({ intentKey: k, transition: 'lost', writer: 'holder', machine: 'm_a', at: iso(T0 + h + 2) }), hlc(h + 2)));
    else recs.push(entry(buildOutcome({ intentKey: k, transition: 'rejected', writer: 'ownership-machine', machine: 'm_b', at: iso(T0 + h + 1) }), hlc(h + 1)));
    return recs;
  };
  const now = new Date(T0 + 10 * 24 * H);

  it('no records ⇒ nothing derived, nothing parked', () => {
    const st = foldProjectCheckState([], CK, cfg, now);
    expect(st.restartsWithoutProgress).toBe(0); expect(st.parked).toBe(false); expect(st.nextCheckAt).toBeNull(); expect(st.nextActionAllowedAt).toBeNull();
  });
  it('started and lost attempts count; a rejected one does not', () => {
    const st = foldProjectCheckState([...attempt(1, 1 * H), ...attempt(2, 2 * H, 'lost'), ...attempt(3, 3 * H, 'rejected')], CK, cfg, now);
    expect(st.restartsWithoutProgress).toBe(2);
  });
  it('progress resets the count; activity does not', () => {
    const recs = [...attempt(1, 1 * H), ...attempt(2, 2 * H), check(3 * H, false), check(4 * H, true), ...attempt(3, 5 * H)];
    const st = foldProjectCheckState(recs, CK, cfg, now);
    expect(st.lastProgressAt).toBe(iso(T0 + 4 * H));
    expect(st.restartsWithoutProgress).toBe(1);
  });
  it('three attempts without progress park the project', () => {
    const st = foldProjectCheckState([...attempt(1, 1 * H), ...attempt(2, 2 * H), ...attempt(3, 3 * H)], CK, cfg, now);
    expect(st.parked).toBe(true); expect(st.breakerTripped).toBe(false);
  });
  it('the breaker trips on more than 5 attempts in 7 days EVEN WITH progress between them, and only an owner unpark clears it', () => {
    const recs: UnionEntry[] = [];
    for (let i = 1; i <= 6; i++) { recs.push(...attempt(i, i * 24 * H), check(i * 24 * H + 60_000, true)); }
    const tripped = foldProjectCheckState(recs, CK, cfg, new Date(T0 + 7 * 24 * H));
    expect(tripped.breakerTripped).toBe(true); expect(tripped.parked).toBe(true); expect(tripped.restartsWithoutProgress).toBe(0);
    const binding = entry(buildBindingPut(bindingInput), hlc(1));
    const unpark = entry(buildLifecycleEvent(CK, 'unpark', hlc(1), 'owner-tap', iso(T0 + 6 * 24 * H + 2 * H)), hlc(6 * 24 * H + 2 * H));
    const bs = foldBindingState([binding, unpark]).get(CK)!;
    const cleared = foldProjectCheckState([...recs, binding, unpark], CK, cfg, new Date(T0 + 7 * 24 * H), bs);
    expect(cleared.breakerTripped).toBe(false); expect(cleared.parked).toBe(false);
  });
  it('attempts older than 7 days fall out of the breaker window', () => {
    const recs: UnionEntry[] = [];
    for (let i = 1; i <= 6; i++) recs.push(...attempt(i, i * H));
    expect(foldProjectCheckState(recs, CK, cfg, new Date(T0 + 1 * 24 * H)).breakerTripped).toBe(true);
    expect(foldProjectCheckState(recs, CK, cfg, new Date(T0 + 9 * 24 * H)).breakerTripped).toBe(false);
  });
  it('backoff doubles nextActionAllowedAt per attempt without progress, independent of nextCheckAt', () => {
    const one = foldProjectCheckState([check(0, false), ...attempt(1, 1 * H)], CK, cfg, now);
    expect(one.nextActionAllowedAt).toBe(iso(T0 + 1 * H + 24 * H));
    const two = foldProjectCheckState([check(0, false), ...attempt(1, 1 * H), ...attempt(2, 2 * H)], CK, cfg, now);
    expect(two.nextActionAllowedAt).toBe(iso(T0 + 2 * H + 48 * H));
    expect(two.nextCheckAt).toBe(iso(T0 + 24 * H)); // a check can come before an action may
  });
  it('net-diff high-water mark is the max ever recorded', () => {
    expect(foldProjectCheckState([check(0, true, 20), check(H, false, 0), check(2 * H, true, 35)], CK, cfg, now).netDiffHighWater).toBe(35);
  });
  it('two machines’ streams fold identically in either order (convergence)', () => {
    const a = [...attempt(1, 1 * H), check(2 * H, false)];
    const b = [...attempt(2, 3 * H), check(4 * H, true)].map((e) => ({ ...e, origin: 'm_b' }));
    const ab = foldProjectCheckState([...a, ...b], CK, cfg, now);
    const ba = foldProjectCheckState([...b, ...a], CK, cfg, now);
    expect(ab).toEqual(ba);
  });
  it('jitter stays within ±10% of the cadence', () => {
    const lo = foldProjectCheckState([check(0, false)], CK, { ...cfg, jitter: 0 }, now).nextCheckAt!;
    const hi = foldProjectCheckState([check(0, false)], CK, { ...cfg, jitter: 1 }, now).nextCheckAt!;
    expect(Date.parse(lo)).toBe(T0 + 24 * H * 0.9);
    expect(Date.parse(hi)).toBe(T0 + 24 * H * 1.1);
  });
});

describe('ChiefOfStaffStore — deriveLeaseExpiry', () => {
  const renewal = (h: number, sigOk: boolean) => entry(buildRenewal({ renewedAt: iso(T0 + h), renewedVia: 'telegram', principal: 'owner:1', machine: 'm_a', machineSignature: sigOk ? 'good' : 'bad' }), hlc(h || 1));
  const verify = (r: Record<string, unknown>) => r.machineSignature === 'good';
  it('no renewals ⇒ expired, never live', () => {
    expect(deriveLeaseExpiry([], verify, 72, new Date(T0))).toMatchObject({ live: false, expiresAt: null });
  });
  it('the max signature-valid renewal + lease hours is the expiry; invalid signatures are ignored', () => {
    const st = deriveLeaseExpiry([renewal(0, true), renewal(10 * H, false), renewal(5 * H, true)], verify, 72, new Date(T0 + 6 * H));
    expect(st.renewedAt).toBe(iso(T0 + 5 * H)); expect(st.expiresAt).toBe(iso(T0 + 77 * H)); expect(st.live).toBe(true); expect(st.ignored).toBe(1);
  });
  it('expires exactly after operatorLeaseHours', () => {
    expect(deriveLeaseExpiry([renewal(0, true)], verify, 72, new Date(T0 + 72 * H - 1)).live).toBe(true);
    expect(deriveLeaseExpiry([renewal(0, true)], verify, 72, new Date(T0 + 72 * H)).live).toBe(false);
  });
  it('a renewal from the future beyond clock tolerance is ignored; a verifier that throws counts as invalid', () => {
    expect(deriveLeaseExpiry([renewal(3 * H, true)], verify, 72, new Date(T0)).live).toBe(false);
    expect(deriveLeaseExpiry([renewal(0, true)], () => { throw new Error('boom'); }, 72, new Date(T0)).live).toBe(false);
  });
});

describe('ChiefOfStaffStore — tree + last-tick folds', () => {
  it('latestPerKey: highest HLC wins and a newer tombstone suppresses', () => {
    const put = entry(buildTreePut(CK, 'app:cos', 'project'), hlc(1));
    const del = entry(buildTreeTombstone(CK, iso(T0)), hlc(2));
    expect(latestPerKey([put, del]).get(CK)!.data.op).toBe('delete');
    expect(latestPerKey([del, put]).get(CK)!.data.op).toBe('delete');
  });
  it('foldLastTicks keeps the newest tick per machine', () => {
    const a = entry(buildLastTick('m_a', iso(T0)), hlc(1));
    const a2 = entry(buildLastTick('m_a', iso(T0 + H)), hlc(2));
    const b = entry(buildLastTick('m_b', iso(T0)), hlc(1, 0, 'm_b'));
    const m = foldLastTicks([a2, b, a]);
    expect(m.get('m_a')).toBe(iso(T0 + H)); expect(m.get('m_b')).toBe(iso(T0));
  });
});
