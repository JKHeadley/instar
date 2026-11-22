/**
 * SEC-170 part 2 of 2 — the agreement protocol's pure logic (docs/specs/pool-wide-pin-budget.md §4).
 * Each scenario checks the bound that matters: the shares machines actually apply never sum above 20.
 */
import { describe, it, expect } from 'vitest';
import {
  makeTable, validateTable, entryFor, loweredShare, raiseTarget, fullyAcknowledged, mayAcknowledge,
  acknowledges, chooseGiver, handDownAmount, compareTables, GONE_FOR_GOOD_SILENCE_MS,
  type PinTable, type HandDownGiven, type PeerShareReport,
} from '../../src/core/PinShareTable.js';

const five = ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const report = (machineId: string, table: PinTable | null, applied: number, extra: Partial<PeerShareReport> = {}): PeerShareReport =>
  ({ machineId, table, applied, retired: false, needsShare: false, ...extra });

describe('SEC-170 part 2 — table validity', () => {
  const t1 = makeTable(1, five);
  it('a table matching the registry is valid; gaps in seq are allowed', () => {
    expect(validateTable(t1, five, 0)).toEqual({ ok: true });
    expect(validateTable(makeTable(40, five), five, 3)).toEqual({ ok: true });
  });
  it('a table listing only its proposer, or an unknown machine, is ignored', () => {
    expect(validateTable(makeTable(2, ['m_a']), five, 0)).toMatchObject({ ok: false, reason: 'members-differ-from-registry' });
    expect(validateTable(makeTable(2, [...five, 'm_x']), five, 0)).toMatchObject({ ok: false });
  });
  it('a replayed older table is ignored; a forged hash is ignored', () => {
    expect(validateTable(t1, five, 2)).toMatchObject({ ok: false, reason: 'older-than-seen' });
    expect(validateTable({ ...t1, hash: 'x' }, five, 0)).toMatchObject({ ok: false, reason: 'bad-hash' });
    expect(validateTable({ ...t1, seq: -1 }, five, 0)).toMatchObject({ ok: false, reason: 'bad-seq' });
    expect(validateTable({ ...t1, seq: Number.MAX_SAFE_INTEGER + 1 }, five, 0)).toMatchObject({ ok: false, reason: 'bad-seq' });
  });
  it('orders by seq then hash', () => {
    expect(compareTables(makeTable(2, five), t1)).toBeGreaterThan(0);
  });
});

describe('SEC-170 part 2 — pairing with a hand-down keeps the sum within 20', () => {
  it('six machines: everyone lowers, the giver hands 2 of its share to the newcomer, then the agreed table evens out', () => {
    const t0 = makeTable(1, five);
    const t1 = makeTable(2, [...five, 'm_f']);
    const applied: Record<string, number> = Object.fromEntries(five.map((m) => [m, entryFor(t0, m)]));
    expect(sum(Object.values(applied))).toBe(20);

    // Everyone who sees t1 lowers at once (no hand-downs yet).
    for (const m of five) applied[m] = loweredShare(applied[m], t1, m, [], t0);
    // m_a (the pairing machine) hands half of its applied share to m_f, durably lowering itself first.
    const k = handDownAmount(applied.m_a);
    const given: HandDownGiven[] = [{ transferId: 't1', to: 'm_f', amount: k, baseSeq: t0.seq }];
    applied.m_a -= k;
    applied.m_f = k;
    expect(sum(Object.values(applied))).toBeLessThanOrEqual(20);
    // A later sighting of t1 keeps m_a at entry minus the outstanding loan, never more.
    expect(loweredShare(applied.m_a, t1, 'm_a', given, t0)).toBeLessThanOrEqual(applied.m_a);

    // Fully acknowledged t1 absorbs the loan: both sides move to their plain entries, summing to 20.
    // Without the recipient's confirmation the loan stays outstanding (the strict side)...
    expect(raiseTarget(t1, 'm_a', given)).toBe(entryFor(t1, 'm_a') - k);
    // ...and once m_f's signed report shows it holds this loan, the agreed table settles it.
    const confirm = new Map([['m_f', report('m_f', t1, k, { heldTransfer: 't1' })]]);
    const after: Record<string, number> = {};
    for (const m of [...five, 'm_f']) after[m] = raiseTarget(t1, m, m === 'm_a' ? given : [], confirm);
    expect(after.m_a).toBe(entryFor(t1, 'm_a'));
    expect(after.m_f).toBe(entryFor(t1, 'm_f'));
    expect(sum(Object.values(after))).toBe(20);
  });

  it('the raise fence: a cut-off peer finishing an older raise, while the giver lends, stays within the older table', () => {
    const tOld = makeTable(3, five);
    const given: HandDownGiven[] = [{ transferId: 't2', to: 'm_f', amount: 2, baseSeq: tOld.seq }];
    // m_b finishes its raise for tOld (cut off, never saw the newcomer's table).
    const mB = raiseTarget(tOld, 'm_b', []);
    // m_a has lent 2 under tOld; it may never raise above its tOld entry minus the loan.
    const mA = raiseTarget(tOld, 'm_a', given);
    expect(mA).toBe(entryFor(tOld, 'm_a') - 2);
    const others = ['m_c', 'm_d', 'm_e'].map((m) => entryFor(tOld, m));
    expect(sum([mA, mB, 2, ...others])).toBeLessThanOrEqual(20);
  });
});

describe('SEC-170 part 2 — acknowledgment rules', () => {
  const t = makeTable(5, five);
  const ctx = (reports: PeerShareReport[], extra: Partial<Parameters<typeof fullyAcknowledged>[1]> = {}) => ({
    self: 'm_a', reports: new Map(reports.map((r) => [r.machineId, r])), previousMembers: five,
    goneForGood: new Set<string>(), lastContact: new Map<string, number>(), contactRecordsComplete: true, now: 10 * GONE_FOR_GOOD_SILENCE_MS, ...extra,
  });

  it('agreed only when every other member reports exactly this table at or below its entry', () => {
    const all = five.filter((m) => m !== 'm_a').map((m) => report(m, t, entryFor(t, m)));
    expect(fullyAcknowledged(t, ctx(all)).agreed).toBe(true);
    const one = [...all.slice(1), report('m_e', makeTable(4, five), 4)];
    expect(fullyAcknowledged(t, ctx(one)).agreed).toBe(false);
    const greedy = [...all.slice(0, 3), report('m_e', t, entryFor(t, 'm_e') + 1)];
    expect(acknowledges(greedy[3], t)).toBe(false);
  });

  it('a retirement needs the retired machine at 0, or the owner\'s gone-for-good with 7 days of silence everywhere', () => {
    const t4 = makeTable(6, ['m_a', 'm_b', 'm_c', 'm_d']);
    const acks = ['m_b', 'm_c', 'm_d'].map((m) => report(m, t4, entryFor(t4, m)));
    expect(fullyAcknowledged(t4, ctx(acks)).missing).toEqual(['m_e']);
    expect(fullyAcknowledged(t4, ctx([...acks, report('m_e', null, 0, { retired: true })])).agreed).toBe(true);
    const now = 10 * GONE_FOR_GOOD_SILENCE_MS;
    expect(fullyAcknowledged(t4, ctx(acks, { goneForGood: new Set(['m_e']), lastContact: new Map([['m_e', now - GONE_FOR_GOOD_SILENCE_MS]]) })).agreed).toBe(true);
    expect(fullyAcknowledged(t4, ctx(acks, { goneForGood: new Set(['m_e']), lastContact: new Map([['m_e', now - 1000]]) })).agreed).toBe(false);
    expect(fullyAcknowledged(t4, ctx(acks, { goneForGood: new Set(['m_e']), contactRecordsComplete: false })).agreed).toBe(false);
  });

  it('two pairings at once: each table omits the other\'s newcomer and is refused by the machine holding the omitted loan', () => {
    const base = makeTable(7, five);
    const tA = makeTable(8, [...five, 'm_c2']); // m_a paired m_c2
    const tB = makeTable(8, [...five, 'm_d2']); // m_b paired m_d2
    const givenByA: HandDownGiven[] = [{ transferId: 'x', to: 'm_c2', amount: 2, baseSeq: base.seq }];
    const givenByB: HandDownGiven[] = [{ transferId: 'y', to: 'm_d2', amount: 2, baseSeq: base.seq }];
    expect(mayAcknowledge(tB, 'm_a', givenByA, null, base)).toBe(false);
    expect(mayAcknowledge(tA, 'm_b', givenByB, null, base)).toBe(false);
    const both = makeTable(9, [...five, 'm_c2', 'm_d2']);
    expect(mayAcknowledge(both, 'm_a', givenByA, null, base)).toBe(true);
    expect(mayAcknowledge(both, 'm_b', givenByB, null, base)).toBe(true);
    // Meanwhile everyone only lowers: the worst case of applied shares stays within 20.
    const applied = five.map((m) => loweredShare(entryFor(base, m), both, m, m === 'm_a' ? givenByA : m === 'm_b' ? givenByB : [], base));
    expect(sum([...applied, 2, 2])).toBeLessThanOrEqual(20);
  });
});

describe('SEC-170 part 2 — hand-down giver choice', () => {
  it('lowest-id peer with a share of 2 or more; half its share', () => {
    expect(chooseGiver([{ machineId: 'm_c', applied: 4 }, { machineId: 'm_b', applied: 1 }, { machineId: 'm_d', applied: 3 }])).toBe('m_c');
    expect(chooseGiver([{ machineId: 'm_b', applied: 1 }])).toBeNull();
    expect(handDownAmount(5)).toBe(2);
  });
});
