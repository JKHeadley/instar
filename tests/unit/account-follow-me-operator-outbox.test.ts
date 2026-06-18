// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup, no production path
/**
 * AccountFollowMeOperatorOutbox — the durable "at most one operator message per
 * ledger state" guarantee (convergence R3.3). Tests pin idempotency across
 * redelivery/restart + per-state distinctness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountFollowMeOperatorOutbox } from '../../src/coordination/AccountFollowMeOperatorOutbox.js';

let dir: string;
let filePath: string;
const mk = () => new AccountFollowMeOperatorOutbox({ filePath, now: () => 1_000 });
const KEY = 'adriana::m_4cbc';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  filePath = path.join(dir, 'outbox.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('claimEmit — at most one message per (ledgerKey, state)', () => {
  it('emits the first time for a (ledgerKey,state)', () => {
    expect(mk().claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' }).emit).toBe(true);
  });

  it('SUPPRESSES a second claim for the same (ledgerKey,state) — even with a different eventId (retry/redelivery)', () => {
    const s = mk();
    expect(s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' }).emit).toBe(true);
    const second = s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e2' });
    expect(second.emit).toBe(false);
    expect(second.firstEventId).toBe('e1'); // the original event is preserved
  });

  it('survives a restart: a fresh instance still suppresses the duplicate', () => {
    mk().claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' });
    expect(mk().claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' }).emit).toBe(false);
  });

  it('a DISTINCT state for the same ledger key emits its own single message', () => {
    const s = mk();
    expect(s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' }).emit).toBe(true);
    expect(s.claimEmit({ ledgerKey: KEY, state: 'failed', eventId: 'e2' }).emit).toBe(true); // different state
    expect(s.claimEmit({ ledgerKey: KEY, state: 'failed', eventId: 'e3' }).emit).toBe(false); // dup of 'failed'
  });

  it('different ledger keys are independent', () => {
    const s = mk();
    expect(s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' }).emit).toBe(true);
    expect(s.claimEmit({ ledgerKey: 'other::m_x', state: 'login-issued', eventId: 'e2' }).emit).toBe(true);
  });
});

describe('hasEmitted / clearLedger', () => {
  it('hasEmitted reflects prior emits', () => {
    const s = mk();
    expect(s.hasEmitted(KEY, 'login-issued')).toBe(false);
    s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' });
    expect(s.hasEmitted(KEY, 'login-issued')).toBe(true);
  });

  it('clearLedger drops all of a key’s records (revocation/removal); idempotent', () => {
    const s = mk();
    s.claimEmit({ ledgerKey: KEY, state: 'login-issued', eventId: 'e1' });
    s.claimEmit({ ledgerKey: KEY, state: 'failed', eventId: 'e2' });
    s.clearLedger(KEY);
    expect(s.hasEmitted(KEY, 'login-issued')).toBe(false);
    expect(s.list()).toEqual([]);
    s.clearLedger(KEY); // idempotent
    expect(s.list()).toEqual([]);
  });
});
