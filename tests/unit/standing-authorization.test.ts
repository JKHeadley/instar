/**
 * Unit tests — standing-authorization.ts (the deterministic resolver half of the
 * standing-authorization extension of B17_FALSE_BLOCKER).
 *
 * The safety of the whole feature rests here: a grant counts ONLY when it is
 * attributable to the VERIFIED operator uid, PROVABLY non-forwarded, and IN
 * WINDOW. Every uncertainty must fail toward present:false (so it never
 * suppresses a needed ask). Both sides of every boundary are covered.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveStandingAuthorization,
  type StandingAuthorizationDeps,
  type OperatorHistoryRow,
} from '../../src/core/standing-authorization.js';

const NOW = Date.UTC(2026, 5, 27, 20, 0, 0);
const OP = 7812716706;

function deps(rows: OperatorHistoryRow[], operatorUid: string | number | null = OP): StandingAuthorizationDeps {
  return {
    getVerifiedOperatorUid: () => operatorUid,
    getRecentMessages: () => rows,
    now: () => NOW,
  };
}

const grant = (over: Partial<OperatorHistoryRow> = {}): OperatorHistoryRow => ({
  telegramUserId: OP,
  text: 'Please enter an autonomy session and fix it on your own — you have my preapproval.',
  ts: NOW - 60_000,
  forwarded: false,
  ...over,
});

describe('resolveStandingAuthorization — counts a genuine verified grant', () => {
  it('present:true for a verified, non-forwarded, in-window grant', () => {
    const r = resolveStandingAuthorization(28130, deps([grant()]));
    expect(r.present).toBe(true);
    expect(r.source).toBe('verified-operator-directive');
    expect(r.evidenceQuote).toContain('on your own');
    expect(r.grantedAt).toBe(NOW - 60_000);
  });

  it('picks the most recent grant when several exist', () => {
    const r = resolveStandingAuthorization(28130, deps([
      grant({ ts: NOW - 3_600_000, text: 'go ahead' }),
      grant({ ts: NOW - 30_000, text: 'you have my approval to proceed' }),
    ]));
    expect(r.present).toBe(true);
    expect(r.grantedAt).toBe(NOW - 30_000);
  });
});

describe('resolveStandingAuthorization — fails safe (present:false)', () => {
  it('NO verified operator bound', () => {
    const r = resolveStandingAuthorization(28130, deps([grant()], null));
    expect(r.present).toBe(false);
    expect(r.reason).toBe('no-operator');
  });

  it('IDENTITY BLEED: same grant text from a DIFFERENT uid does NOT count', () => {
    const r = resolveStandingAuthorization(28130, deps([grant({ telegramUserId: 999999 })]));
    expect(r.present).toBe(false);
  });

  it('MISSING uid is non-attributable (never a wildcard)', () => {
    expect(resolveStandingAuthorization(28130, deps([grant({ telegramUserId: null })])).present).toBe(false);
    expect(resolveStandingAuthorization(28130, deps([grant({ telegramUserId: '' })])).present).toBe(false);
    expect(resolveStandingAuthorization(28130, deps([grant({ telegramUserId: undefined })])).present).toBe(false);
  });

  it('FORWARDED operator row does NOT count', () => {
    const r = resolveStandingAuthorization(28130, deps([grant({ forwarded: true })]));
    expect(r.present).toBe(false);
  });

  it('UNKNOWN forwarded flag (legacy row, no field) does NOT count (D10 fail-safe)', () => {
    const row = grant();
    delete (row as { forwarded?: boolean }).forwarded; // legacy row
    const r = resolveStandingAuthorization(28130, deps([row]));
    expect(r.present).toBe(false);
    expect(r.reason).toBe('no-attributable-nonforwarded-row');
  });

  it('STALE grant outside the 24h window does NOT count', () => {
    const r = resolveStandingAuthorization(28130, deps([grant({ ts: NOW - 25 * 60 * 60 * 1000 })]));
    expect(r.present).toBe(false);
    expect(r.reason).toBe('no-grant-in-window');
  });

  it('a verified, in-window operator message with NO grant phrase does NOT count', () => {
    const r = resolveStandingAuthorization(28130, deps([grant({ text: 'how is the release looking?' })]));
    expect(r.present).toBe(false);
    expect(r.reason).toBe('no-grant-in-window');
  });

  it('the window is configurable', () => {
    const rows = [grant({ ts: NOW - 2 * 60 * 60 * 1000 })]; // 2h old
    expect(resolveStandingAuthorization(28130, deps(rows), { windowMs: 60 * 60 * 1000 }).present).toBe(false); // 1h window
    expect(resolveStandingAuthorization(28130, deps(rows), { windowMs: 3 * 60 * 60 * 1000 }).present).toBe(true); // 3h window
  });

  it('a future-dated row beyond clock-skew tolerance does NOT count', () => {
    const r = resolveStandingAuthorization(28130, deps([grant({ ts: NOW + 5 * 60_000 })]));
    expect(r.present).toBe(false);
  });
});
