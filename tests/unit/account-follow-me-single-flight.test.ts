// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup, no production path
/**
 * AccountFollowMeSingleFlight — the DURABLE single-flight ledger that makes the
 * "one login per (account,target)" guarantee real (convergence critical #2: the
 * prior live wiring was `() => new Set()`, a no-op). Tests pin both sides of every
 * transition + the dead-holder auto-heal, with an injected clock + a temp file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountFollowMeSingleFlight,
  singleFlightKey,
} from '../../src/coordination/AccountFollowMeSingleFlight.js';

let dir: string;
let filePath: string;
let clock: number;
const now = () => clock;
const mk = () => new AccountFollowMeSingleFlight({ filePath, now });

const CLAIM = {
  accountId: 'adriana',
  targetMachineId: 'm_4cbc',
  frontingMachineId: 'm_cc2e',
  mandateId: 'mandate-1',
  holder: 'run-A',
  ttlMs: 60_000,
};
const KEY = singleFlightKey(CLAIM.accountId, CLAIM.targetMachineId);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
  filePath = path.join(dir, 'single-flight.json');
  clock = 1_000_000;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tryClaim — the single-flight gate', () => {
  it('claims an absent pair → enroll-in-flight', () => {
    const r = mk().tryClaim(CLAIM);
    expect(r.claimed).toBe(true);
    expect(r.record.state).toBe('enroll-in-flight');
    expect(r.record.key).toBe(KEY);
  });

  it('REFUSES a second claim while enroll-in-flight (the duplicate-login guard)', () => {
    const s = mk();
    expect(s.tryClaim(CLAIM).claimed).toBe(true);
    const second = s.tryClaim({ ...CLAIM, holder: 'run-B' });
    expect(second.claimed).toBe(false); // single-flight: no second login
    expect(second.record.holder).toBe('run-A'); // the original holder still owns it
  });

  it('REFUSES a claim while login-issued (link already out)', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    s.transition(KEY, 'login-issued', CLAIM.holder, { ttlMs: 60_000 });
    expect(s.tryClaim({ ...CLAIM, holder: 'run-B' }).claimed).toBe(false);
  });

  it('survives a restart: a fresh store instance still refuses a duplicate claim', () => {
    mk().tryClaim(CLAIM); // store A writes
    const fresh = mk(); // a "restarted" instance reading the same file
    expect(fresh.tryClaim({ ...CLAIM, holder: 'run-B' }).claimed).toBe(false);
  });

  it('re-arms after a terminal state (completed / failed) — a genuinely fresh delivery can re-claim', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    s.transition(KEY, 'login-issued', CLAIM.holder, { ttlMs: 60_000 });
    s.transition(KEY, 'completed', CLAIM.holder);
    const re = s.tryClaim({ ...CLAIM, holder: 'run-C', mandateId: 'mandate-2' });
    expect(re.claimed).toBe(true);
    expect(re.record.state).toBe('enroll-in-flight');
  });

  it('dead-holder auto-heal: a claim past the TTL reclaims a crashed enroll', () => {
    const s = mk();
    s.tryClaim(CLAIM); // ttlExpiresAt = clock + 60_000
    clock += 61_000; // holder crashed; TTL lapsed
    const re = s.tryClaim({ ...CLAIM, holder: 'run-D' });
    expect(re.claimed).toBe(true);
    expect(re.record.holder).toBe('run-D');
  });
});

describe('isActive — scan re-offer suppression + live check', () => {
  it('true while enroll-in-flight / login-issued, false when terminal or TTL-lapsed', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    expect(s.isActive(KEY)).toBe(true);
    s.transition(KEY, 'login-issued', CLAIM.holder, { ttlMs: 60_000 });
    expect(s.isActive(KEY)).toBe(true);
    clock += 61_000; // login link window lapsed
    expect(s.isActive(KEY)).toBe(false); // reclaimable, not live
    // and terminal is never active
    const s2 = mk();
    expect(s2.isActive('absent::key')).toBe(false);
  });
});

describe('transition — guarded state moves', () => {
  it('refuses a transition from a holder that does not own the claim', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    const bad = s.transition(KEY, 'login-issued', 'someone-else');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('holder-mismatch');
  });

  it('no-op on an absent key', () => {
    expect(mk().transition('absent::key', 'failed', 'run-A').ok).toBe(false);
  });

  it('terminal states clear the active TTL window', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    const r = s.transition(KEY, 'failed', CLAIM.holder);
    expect(r.ok).toBe(true);
    expect(r.record!.state).toBe('failed');
    expect(r.record!.ttlExpiresAt).toBe(0);
    expect(s.isActive(KEY)).toBe(false);
  });
});

describe('remove — revocation drops the pair', () => {
  it('removes a record idempotently', () => {
    const s = mk();
    s.tryClaim(CLAIM);
    expect(s.get(KEY)).toBeDefined();
    s.remove(KEY);
    expect(s.get(KEY)).toBeUndefined();
    s.remove(KEY); // idempotent
    expect(s.list()).toEqual([]);
  });
});
