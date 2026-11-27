/** identity-security piece 3d §1–§2: the recovery's decisions on each machine's own facts and clock. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  arrivalDecision, endReason, finishRead, ingestPeerFacts, isReady, isSettled, noticeDue, readRecovery, recordArrival, recordStop,
  resetRecoveryCacheForTests, writeRecovery, RECOVERY_WAIT_MS, type ApproverRecoveryFacts, type HomeRecovery,
} from '../../src/core/approverRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const H = 3600_000;
let dir: string;
beforeEach(() => { resetRecoveryCacheForTests(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-core-')); });
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/identity-piece3d-recovery-core.test.ts' }));

const facts = (o: Partial<ApproverRecoveryFacts> = {}): ApproverRecoveryFacts => ({ v: 1, now: 0, recovery: null, stops: [], lastPresence: null, acceptedRecoveries: [], ...o });
const rec = (startedAt: number, notices: Array<number | null> = [null, null, null]) => ({ recoveryId: 'r1', startedAt, state: 'waiting' as const, notices, targetName: 'New phone', machinesAtStart: ['m_A', 'm_B'], targetDeviceId: 'cand', keyHash: 'kh', home: 'm_A', countedKeys: [], stopNonceHashes: [] });

describe('the wait is measured on this machine, from its own first sight', () => {
  it('a back-dated start gains nothing: 72 h count from when THIS machine first saw it', () => {
    const t0 = 1_000 * H;
    ingestPeerFacts(dir, 'm_A', facts({ now: t0, recovery: rec(t0 - 100 * H, [t0 - 99 * H, t0 - 60 * H, t0 - 2 * H]) }), t0); // claims to be 100 h old
    const d = (now: number) => arrivalDecision(dir, { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_A', now, selfMachineId: 'm_B', lastPresence: null });
    expect(d(t0 + 1 * H)).toBe('hold');
    expect(d(t0 + 71 * H)).toBe('hold');
    expect(d(t0 + 72 * H)).toBe('accept');
  });

  it('an approval here during the wait, or a stop, retires; a machine at the start that never saw it holds forever', () => {
    const t0 = 1_000 * H;
    ingestPeerFacts(dir, 'm_A', facts({ recovery: rec(t0, [t0, t0 + 30 * H, t0 + 70 * H]) }), t0);
    const base = { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_A', now: t0 + 80 * H, selfMachineId: 'm_B' };
    expect(arrivalDecision(dir, { ...base, lastPresence: { at: t0 + 5 * H, deviceId: 'old-phone' } })).toBe('retire');
    expect(arrivalDecision(dir, { ...base, lastPresence: { at: t0 + 5 * H, deviceId: 'cand' } })).toBe('accept'); // the candidate's own don't count
    recordStop(dir, { recoveryId: 'r1', at: t0 + 6 * H, by: 'm_A', kind: 'chat', lock: false });
    expect(arrivalDecision(dir, { ...base, lastPresence: null })).toBe('retire');
    resetRecoveryCacheForTests();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-core2-'));
    expect(arrivalDecision(other, { ...base, recoveryId: 'r9', lastPresence: null })).toBe('hold');
    SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: 'tests/unit/identity-piece3d-recovery-core.test.ts' });
  });

  it('a machine that never saw it: the entry is its first sight; it waits 72 h itself AND every other machine must accept (review R3-H1)', () => {
    ingestPeerFacts(dir, 'm_A', facts({ acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), 10 * H); // m_A hid the recovery, claims acceptance
    const d = (now: number, reg = ['m_A', 'm_B', 'm_C']) => arrivalDecision(dir, { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_A', now, selfMachineId: 'm_C', lastPresence: null, registeredNow: reg });
    expect(d(200 * H)).toBe('hold'); // first sight now
    expect(d(271 * H)).toBe('hold'); // its own 72 h not over
    expect(d(272 * H)).toBe('hold'); // m_B hasn't accepted
    ingestPeerFacts(dir, 'm_B', facts({ acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), 210 * H);
    expect(d(272 * H)).toBe('accept');
  });

  it('two machines, one compromised: the honest one never accepts at once (review R3-H1)', () => {
    ingestPeerFacts(dir, 'm_M', facts({ acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), 0);
    const d = (now: number) => arrivalDecision(dir, { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_M', now, selfMachineId: 'm_C', lastPresence: null, registeredNow: ['m_C', 'm_M'] });
    expect(d(1 * H)).toBe('hold');
    expect(d(30 * H)).toBe('hold');
    expect(d(73 * H)).toBe('accept'); // only after its own 72 h, giving the owner's devices the whole wait to stop it
  });

  it('a machine the home left off its list but that saw the recovery still waits 72 h on its own clock (review R2-H1)', () => {
    const t0 = 1_000 * H;
    ingestPeerFacts(dir, 'm_A', facts({ recovery: { ...rec(t0 - 100 * H, [t0 - 99 * H, t0 - 60 * H, t0 - 2 * H]), machinesAtStart: ['m_A'] }, acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), t0, ['m_A', 'm_B']);
    const d = (now: number) => arrivalDecision(dir, { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_A', now, selfMachineId: 'm_B', lastPresence: null, registeredNow: ['m_A', 'm_B'] });
    expect(d(t0 + 1 * H)).toBe('hold');
    expect(d(t0 + 72 * H)).toBe('accept');
  });

  it('settles only when every machine in this machine\'s own registry accepted it; a stop before settling undoes it, one after does not', () => {
    ingestPeerFacts(dir, 'm_A', facts({ recovery: rec(0) }), H, ['m_A', 'm_B']);
    recordArrival(dir, 'r1', 'accepted', 'e1');
    expect(isSettled(dir, 'r1', 'm_B', 'e1')).toBe(false); // m_A hasn't accepted
    recordStop(dir, { recoveryId: 'r1', at: 2 * H, by: 'm_A', kind: 'approval', lock: false });
    ingestPeerFacts(dir, 'm_A', facts({ recovery: rec(0), acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), 3 * H, ['m_A', 'm_B']);
    expect(isSettled(dir, 'r1', 'm_B', 'e1')).toBe(false); // stopped before settling
  });

  it('a stop after settling does not undo it (review R2-M2)', () => {
    ingestPeerFacts(dir, 'm_A', facts({ recovery: rec(0), acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), H, ['m_A', 'm_B']);
    recordArrival(dir, 'r1', 'accepted', 'e1');
    expect(isSettled(dir, 'r1', 'm_B', 'e1')).toBe(true);
    recordStop(dir, { recoveryId: 'r1', at: 5 * H, by: 'm_A', kind: 'chat', lock: false });
    expect(isSettled(dir, 'r1', 'm_B', 'e1')).toBe(true);
  });
});

describe('review fixes (H1, frozen target, M6)', () => {
  it('a second, different entry under an accepted recovery id is retired; so is one for another key or attested by another machine', () => {
    const t0 = 1_000 * H;
    ingestPeerFacts(dir, 'm_A', facts({ recovery: rec(t0, [t0, t0 + 36 * H, t0 + 71 * H]) }), t0);
    const base = { recoveryId: 'r1', entryId: 'e1', candidateDeviceId: 'cand', candidateKeyHash: 'kh', proofBy: 'm_A', now: t0 + 80 * H, selfMachineId: 'm_B', lastPresence: null };
    expect(arrivalDecision(dir, base)).toBe('accept');
    recordArrival(dir, 'r1', 'accepted', 'e1');
    expect(arrivalDecision(dir, { ...base, entryId: 'e2' })).toBe('refuse'); // a forged second entry: refused, no stop
    expect(arrivalDecision(dir, base)).toBe('accept');
    resetRecoveryCacheForTests();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-core3-'));
    ingestPeerFacts(other, 'm_A', facts({ recovery: rec(t0, [t0, t0 + 36 * H, t0 + 71 * H]) }), t0);
    expect(arrivalDecision(other, { ...base, candidateKeyHash: 'another-key' })).toBe('refuse');
    expect(arrivalDecision(other, { ...base, proofBy: 'm_X' })).toBe('refuse');
    SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: 'tests/unit/identity-piece3d-recovery-core.test.ts' });
  });

  it('a settle needs the exact entry, and a removed machine no longer has to accept', () => {
    resetRecoveryCacheForTests();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-core5-'));
    ingestPeerFacts(a, 'm_A', facts({ recovery: rec(0), acceptedRecoveries: [{ recoveryId: 'r1', entryId: 'e1' }] }), H, ['m_A', 'm_B']);
    recordArrival(a, 'r1', 'accepted', 'e1');
    expect(isSettled(a, 'r1', 'm_B', 'e9', new Set(['m_A', 'm_B']))).toBe(false);
    resetRecoveryCacheForTests();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-core4-'));
    ingestPeerFacts(other, 'm_A', facts({ recovery: rec(0) }), H, ['m_A', 'm_B']); // m_A hasn't accepted, but is removed
    recordArrival(other, 'r1', 'accepted', 'e1');
    expect(isSettled(other, 'r1', 'm_B', 'e1', new Set(['m_A', 'm_B']))).toBe(false);
    expect(isSettled(other, 'r1', 'm_B', 'e1', new Set(['m_B']))).toBe(true);
    for (const d of [a, other]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece3d-recovery-core.test.ts' });
  });

});

describe('the home: notices, ready, the ends', () => {
  const home = (notices: HomeRecovery['notices'], state: HomeRecovery['state'] = 'waiting'): HomeRecovery => ({
    recoveryId: 'r1', startedAt: 0, targetDeviceId: 'cand', targetName: 'New', requestId: 'q', presenceKey: 'k', keyHash: 'h', countedKeys: [], lostKeys: [], machinesAtStart: ['m_A'], notices, state,
  });
  it('three notices at 0, 36 and 71 hours on the start clock, and ready an hour after the final one', () => {
    expect(noticeDue(home([null, null, null]), 0)).toBe(0);
    expect(noticeDue(home([0, null, null]), 35 * H)).toBeNull();
    expect(noticeDue(home([0, null, null]), 36 * H)).toBe(1);
    expect(noticeDue(home([0, 36 * H, null]), 70 * H)).toBeNull();
    expect(noticeDue(home([0, 36 * H, null]), 71 * H)).toBe(2);
    expect(noticeDue(home([null, null, null]), 80 * H)).toBe(0); // an unaccepted first notice comes first, late
    expect(isReady(home([0, 36 * H, 71 * H]), 71.5 * H)).toBe(false);
    expect(isReady(home([0, 36 * H, 71 * H]), 72 * H)).toBe(true);
    expect(isReady(home([0, 36 * H, null]), 100 * H)).toBe(false); // an unaccepted notice lengthens the wait
  });
  it('ends 7 days after the wait ends, whether or not it became ready late', () => {
    expect(endReason(home([0, null, null]), RECOVERY_WAIT_MS + 7 * 24 * H)).toBe('not-ready-in-time');
    expect(endReason({ ...home([0, 36 * H, 71 * H], 'ready'), readyAt: 100 * H }, RECOVERY_WAIT_MS + 7 * 24 * H)).toBe('not-finished-in-time');
    expect(endReason({ ...home([0, 36 * H, 71 * H], 'ready'), readyAt: 100 * H }, RECOVERY_WAIT_MS + 7 * 24 * H - 1)).toBeNull();
  });
  it('the Finish read: stale machines wait, a stop or an approval elsewhere stops (clocks shifted)', () => {
    const base = { recoveryId: 'r1', startedAt: 10 * H, candidateDeviceId: 'cand', machines: ['m_A', 'm_B'], selfMachineId: 'm_A', now: 100 * H, selfLastPresence: null };
    expect(finishRead(dir, base).stale).toEqual(['m_B']);
    ingestPeerFacts(dir, 'm_B', facts({ now: 100 * H, lastPresence: { at: 9 * H, deviceId: 'old' } }), 100 * H);
    expect(finishRead(dir, base)).toEqual({ stale: [], stopped: null });
    ingestPeerFacts(dir, 'm_B', facts({ now: 100 * H, lastPresence: { at: 50 * H, deviceId: 'old' } }), 100 * H);
    expect(finishRead(dir, base).stopped).toContain('approved');
  });
});
