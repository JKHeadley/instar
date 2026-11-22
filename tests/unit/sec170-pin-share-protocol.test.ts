// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-170 part 2 of 2 — the share provider driving the agreement protocol
 * (docs/specs/pool-wide-pin-budget.md §4, §6). Peer reports are injected; no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PinShareProvider, RAISE_WAIT_MS } from '../../src/core/PinShare.js';
import { makeTable, entryFor, GONE_FOR_GOOD_SILENCE_MS, type PeerShareReport, type HandDownGiven } from '../../src/core/PinShareTable.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const five = ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'];

describe('SEC-170 part 2 — PinShareProvider with the protocol', () => {
  let tmp: string;
  let self: string;
  let members: string[];
  let selfRevoked: boolean;
  let reports: Map<string, PeerShareReport>;
  let pollReady: boolean;
  let mono: number;
  let wall: number;
  let gone: Set<string>;
  let contacts: Map<string, number>;
  let sent: Array<{ to: string; gift: HandDownGiven }>;

  const make = () => new PinShareProvider({
    stateDir: tmp, enabled: () => true, now: () => wall,
    membership: () => ({ self, members, ...(selfRevoked ? { selfRevoked } : {}) }),
    protocol: {
      reports: () => reports, pollReady: () => pollReady, goneForGood: () => gone,
      contacts: () => ({ map: contacts, complete: true }), monoNow: () => mono,
      sendHandDown: (to, gift) => { sent.push({ to, gift }); },
    },
  });
  const ack = (t: ReturnType<typeof makeTable>, ids: string[]) => { for (const m of ids) reports.set(m, { machineId: m, table: t, applied: entryFor(t, m), retired: false, needsShare: false }); };
  const deciding = (ids: string[]) => { for (const m of ids) reports.set(m, { machineId: m, table: null, applied: 0, retired: false, needsShare: false }); };
  const step = (p: PinShareProvider, ms = 0) => { mono += ms; wall += ms; p.invalidate(); return p.state(); };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-proto-'));
    self = 'm_a'; members = [...five]; selfRevoked = false; reports = new Map(); pollReady = true;
    mono = 1_000; wall = 10 * GONE_FOR_GOOD_SILENCE_MS; gone = new Set(); contacts = new Map(); sent = [];
    vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report: vi.fn() } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/sec170-pin-share-protocol.test.ts' }); });

  it('before one poll round answers, a machine with no records refuses (share 0, deciding)', () => {
    pollReady = false;
    expect(make().state()).toMatchObject({ share: 0, basis: 'deciding' });
  });

  it('a founding member (every peer answered and is deciding too) takes its canonical entry', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    expect(make().state()).toMatchObject({ share: 4, basis: 'applied' });
  });

  it('with any peer unanswered, a machine with no records starts at 0 and asks for a hand-down (never a fresh entry)', () => {
    deciding(['m_b', 'm_c', 'm_d']); // m_e asleep
    expect(make().state()).toMatchObject({ share: 0, basis: 'newcomer' });
  });

  it('a peer\'s table that lists this machine counts only if that peer holds no more than its entry', () => {
    const t = makeTable(2, five);
    ack(t, ['m_b', 'm_c', 'm_d']);
    reports.set('m_e', { machineId: 'm_e', table: t, applied: 10, retired: false, needsShare: false });
    expect(make().state().share).toBe(0);
  });

  it('a newcomer (a peer\'s table does not list it) starts at 0 asking for a hand-down, admits after one window, then evens out on agreement', () => {
    self = 'm_f'; members = [...five, 'm_f'];
    const old = makeTable(3, five);
    ack(old, five);
    const p = make();
    expect(p.state()).toMatchObject({ share: 0, basis: 'newcomer' });
    expect(p.report()).toMatchObject({ needsShare: true, applied: 0 });

    expect(p.receiveHandDown('m_a', { transferId: 'g1', amount: 2, baseSeq: 3 })).toEqual({ accepted: true });
    expect(step(p).basis).toBe('admit-wait');
    expect(step(p, RAISE_WAIT_MS).share).toBe(2);

    // Everyone adopts the six-machine table and reports it; after one more window the newcomer raises to its entry.
    const t6 = p.report()!.table!;
    expect(t6.members).toContain('m_f');
    ack(t6, five);
    step(p);
    expect(step(p, RAISE_WAIT_MS).share).toBe(entryFor(t6, 'm_f'));
  });

  it('a second hand-down is refused once a machine holds a share', () => {
    self = 'm_f'; members = [...five, 'm_f'];
    ack(makeTable(3, five), five);
    const p = make();
    p.state();
    p.receiveHandDown('m_a', { transferId: 'g1', amount: 2, baseSeq: 3 });
    expect(p.receiveHandDown('m_b', { transferId: 'g2', amount: 2, baseSeq: 3 })).toMatchObject({ accepted: false });
  });

  it('the giver lowers durably before sending, and gives once', () => {
    const t = makeTable(4, [...five, 'm_f']);
    members = [...five, 'm_f'];
    ack(t, ['m_b', 'm_c', 'm_d', 'm_e']);
    reports.set('m_f', { machineId: 'm_f', table: null, applied: 0, retired: false, needsShare: true });
    const p = make();
    const s1 = p.state();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('m_f');
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'pin-share.json'), 'utf-8'));
    expect(stored.given).toHaveLength(1);
    expect(s1.share).toBe(entryFor(t, 'm_a') - sent[0].gift.amount);
    step(p);
    expect(sent).toHaveLength(1);
  });

  it('no raise before every member acknowledges, nor before the window passes; a newer table cancels the wait', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    expect(p.share()).toBe(4);
    // m_e is retired: the four remaining machines would each get 5, but only after agreement.
    members = ['m_a', 'm_b', 'm_c', 'm_d'];
    step(p);
    expect(p.share()).toBe(4);
    const t4 = p.report()!.table!;
    ack(t4, ['m_b', 'm_c', 'm_d']);
    reports.set('m_e', { machineId: 'm_e', table: null, applied: 0, retired: true, needsShare: false });
    step(p);
    expect(step(p, RAISE_WAIT_MS - 1).share).toBe(4);
    expect(step(p, 1).share).toBe(5);
  });

  it('a retired machine that never answers holds the raise back until the owner says gone for good and 7 days pass in silence', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    p.state();
    members = ['m_a', 'm_b', 'm_c', 'm_d'];
    step(p);
    const t4 = p.report()!.table!;
    ack(t4, ['m_b', 'm_c', 'm_d']);
    contacts.set('m_e', wall - 1000);
    step(p); step(p, RAISE_WAIT_MS);
    expect(p.share()).toBe(4);
    gone.add('m_e');
    step(p); step(p, RAISE_WAIT_MS);
    expect(p.share()).toBe(4); // silence too short
    contacts.set('m_e', wall - GONE_FOR_GOOD_SILENCE_MS);
    step(p); step(p, RAISE_WAIT_MS);
    expect(p.share()).toBe(5);
  });

  it('a machine that learns of its own retirement writes 0 and reports retired', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    p.state();
    selfRevoked = true;
    expect(step(p)).toMatchObject({ share: 0, basis: 'retired' });
    expect(p.report()).toMatchObject({ retired: true, applied: 0 });
    expect(make().state().share).toBe(0);
  });

  it('a replayed older table from a peer lowers nothing and is not adopted', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    p.state();
    const newer = makeTable(9, five);
    ack(newer, ['m_b']);
    step(p);
    reports.set('m_c', { machineId: 'm_c', table: makeTable(2, five), applied: 0, retired: false, needsShare: false });
    step(p);
    expect(p.report()!.table!.seq).toBe(9);
    expect(p.share()).toBe(4);
  });

  it('a machine whose records are both lost restarts at 0 asking for a hand-down, even if old tables exist', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    make().state();
    fs.writeFileSync(path.join(tmp, 'state', 'pin-share.json'), 'x');
    fs.writeFileSync(path.join(tmp, 'state', 'pin-share.prev.json'), 'y');
    ack(makeTable(1, five), ['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    expect(p.state()).toMatchObject({ share: 0 });
    expect(p.report()).toMatchObject({ needsShare: true });
  });

  it('after a restart, a hand-down admit wait starts again in full', () => {
    self = 'm_f'; members = [...five, 'm_f'];
    ack(makeTable(3, five), five);
    const p = make();
    p.state();
    p.receiveHandDown('m_a', { transferId: 'g1', amount: 2, baseSeq: 3 });
    step(p, RAISE_WAIT_MS - 10);
    const q = make();
    expect(q.state().basis).toBe('admit-wait');
    mono += RAISE_WAIT_MS; q.invalidate();
    expect(q.share()).toBe(2);
  });
  it('a loan to a machine whose retirement is complete ends; the giver is not wedged', () => {
    const t = makeTable(4, [...five, 'm_f']);
    members = [...five, 'm_f'];
    ack(t, ['m_b', 'm_c', 'm_d', 'm_e']);
    reports.set('m_f', { machineId: 'm_f', table: null, applied: 0, retired: false, needsShare: true });
    const p = make();
    p.state();
    expect(sent).toHaveLength(1);
    // m_f is retired and reports it; the five remaining agree on the five-machine table.
    members = [...five];
    reports.set('m_f', { machineId: 'm_f', table: null, applied: 0, retired: true, needsShare: false });
    step(p);
    const t5 = p.report()!.table!;
    ack(t5, ['m_b', 'm_c', 'm_d', 'm_e']);
    step(p); step(p, RAISE_WAIT_MS);
    expect(p.share()).toBe(entryFor(t5, 'm_a'));
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'pin-share.json'), 'utf-8')).given).toHaveLength(0);
  });

  it('a gift is clamped to the recipient\'s entry in its table', () => {
    self = 'm_f'; members = [...five, 'm_f'];
    ack(makeTable(3, five), five);
    const p = make();
    p.state();
    expect(p.receiveHandDown('m_a', { transferId: 'big', amount: 9, baseSeq: 3 })).toEqual({ accepted: true });
    step(p, RAISE_WAIT_MS);
    expect(entryFor(p.report()!.table!, 'm_f')).toBe(3);
    expect(p.share()).toBe(3); // a gift of 9 clamped to the newcomer's entry
  });

  it('a machine re-added after retirement starts over at 0 asking for a hand-down', () => {
    deciding(['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    p.state();
    selfRevoked = true; step(p);
    selfRevoked = false;
    expect(step(p)).toMatchObject({ share: 0 });
    expect(p.report()).toMatchObject({ retired: false, needsShare: true });
  });

  it('the giver never sends a hand-down whose lowering could not be saved', async () => {
    const mod = await import('../../src/core/PinShare.js');
    const t = makeTable(4, [...five, 'm_f']);
    members = [...five, 'm_f'];
    ack(t, ['m_b', 'm_c', 'm_d', 'm_e']);
    const p = make();
    deciding([]);
    p.state();
    reports.set('m_f', { machineId: 'm_f', table: null, applied: 0, retired: false, needsShare: true });
    const spy = vi.spyOn(mod, 'writeDurable').mockImplementation(() => { throw new Error('disk full'); });
    step(p);
    spy.mockRestore();
    expect(sent).toHaveLength(0);
  });
  it('a newcomer whose registry lags its peers\' tables starts at 0, not at an entry over fewer machines', () => {
    self = 'm_c'; members = ['m_a', 'm_c']; // C has not yet heard of m_b
    const t3 = makeTable(5, ['m_a', 'm_b', 'm_c']);
    reports.set('m_a', { machineId: 'm_a', table: t3, applied: entryFor(t3, 'm_a'), retired: false, needsShare: false });
    expect(make().state()).toMatchObject({ share: 0, basis: 'newcomer' });
  });
});
