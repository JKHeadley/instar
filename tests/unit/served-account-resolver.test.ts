/**
 * quota-pacing step 3 (docs/specs/quota-pacing-spend-by-account.md §1): which account served a
 * row, judged at the row's own time, with the basis recorded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { IdentityCheckLog } from '../../src/monitoring/IdentityCheckLog.js';
import { ServedAccountResolver, type ServedLedgerView, type ServedPoolAccount } from '../../src/monitoring/servedAccount.js';
import { identityKey } from '../../src/monitoring/quotaPacing.js';

const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'served-account-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/served-account-resolver.test.ts' }); });

const H = 3_600_000;
const T0 = Date.parse('2026-11-18T00:00:00Z');
const MIN15 = 15 * 60_000;

function pool(homeA: string, homeB: string): ServedPoolAccount[] {
  return [
    { id: 'claude-a', framework: 'claude-code', configHome: homeA, provider: 'anthropic', email: 'a@example.com' },
    { id: 'codex-b', framework: 'codex-cli', configHome: homeB, provider: 'openai', email: 'b@example.com' },
  ];
}

function ledgerView(assignments: Array<{ slot: string; accountId: string; since: number; lastVerifiedAt: number | null; quarantined?: boolean }>, journal: ServedLedgerView['getJournal'] extends () => infer R ? R : never = [], unknown = false): ServedLedgerView {
  return {
    isUnknownMode: () => unknown,
    isSeeded: () => true,
    version: 1,
    getAssignment: (slot) => {
      const a = assignments.find(x => path.resolve(x.slot) === path.resolve(slot));
      return a ? { slot: a.slot, accountId: a.accountId, since: new Date(a.since).toISOString(), lastVerifiedAt: a.lastVerifiedAt == null ? null : new Date(a.lastVerifiedAt).toISOString(), quarantined: !!a.quarantined } : null;
    },
    getJournal: () => journal,
  };
}

describe('IdentityCheckLog', () => {
  it('keeps one interval through a day of confirmed polls, survives a restart, and is closed by an unavailable check', () => {
    const state = temp();
    let now = T0;
    const log = new IdentityCheckLog({ stateDir: state, now: () => now });
    const id = identityKey('anthropic', 'a@example.com');
    for (let i = 0; i < 96; i++) { log.record('/slot/a', { result: 'confirmed', identity: id }); now += MIN15; }
    expect(log.intervals('/slot/a')).toHaveLength(1);
    log.flushAll();
    // A restart, then a delayed scan of a row written mid-day.
    const reopened = new IdentityCheckLog({ stateDir: state, now: () => now });
    const mid = T0 + 12 * H;
    expect(reopened.at('/slot/a', mid, 3 * MIN15)?.result).toBe('confirmed');
    expect(reopened.at('/slot/a', mid, 3 * MIN15)?.identity).toBe(id);
    // An unavailable check closes the interval: no extension past the last confirmation + grace.
    reopened.record('/slot/a', { result: 'unavailable', identity: null });
    expect(reopened.intervals('/slot/a')[0].closed).toBe(true);
    expect(reopened.at('/slot/a', now + 4 * H, 3 * MIN15)).toBeNull();
  });

  it('starts a new interval when the result or identity changes and answers each time separately', () => {
    let now = T0;
    const log = new IdentityCheckLog({ stateDir: temp(), now: () => now });
    log.record('/s', { result: 'confirmed', identity: 'anthropic:aaaaaaaaaaaaaaaa' });
    now += H;
    log.record('/s', { result: 'drifted', identity: 'anthropic:bbbbbbbbbbbbbbbb' });
    now += H;
    log.record('/s', { result: 'drifted', identity: 'anthropic:bbbbbbbbbbbbbbbb' });
    expect(log.intervals('/s')).toHaveLength(2);
    expect(log.at('/s', T0 + 10_000, MIN15)?.result).toBe('confirmed');
    expect(log.at('/s', T0 + H + 10_000, MIN15)?.result).toBe('drifted');
    expect(log.at('/s', T0 - 1, MIN15)).toBeNull();
  });
});

describe('ServedAccountResolver', () => {
  it('enrollment path: confirmed at the row time, drifted, unconfirmed, and Codex always unconfirmed', () => {
    const homeA = temp(), homeB = temp();
    let now = T0;
    const checks = new IdentityCheckLog({ stateDir: temp(), now: () => now });
    const r = new ServedAccountResolver({ pool: () => pool(homeA, homeB), checks, pollIntervalMs: MIN15 });
    r.refresh();
    const id = identityKey('anthropic', 'a@example.com');
    checks.record(homeA, { result: 'confirmed', identity: id });
    now = T0 + 2 * H;
    checks.record(homeA, { result: 'confirmed', identity: id });
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + H, sessionStartTs: T0 })).toEqual({ slot: path.resolve(homeA), accountId: 'claude-a', identity: id, basis: 'enrollment-confirmed' });
    // No check near the row: unconfirmed, account recorded but no identity.
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 10 * H, sessionStartTs: T0 }).basis).toBe('identity-unconfirmed');
    // A row written while drifted stays drifted, however late it is scanned.
    now = T0 + 3 * H;
    checks.record(homeA, { result: 'drifted', identity: 'anthropic:cccccccccccccccc' });
    now = T0 + 4 * H;
    checks.record(homeA, { result: 'confirmed', identity: id });
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 3 * H + 60_000, sessionStartTs: T0 }).basis).toBe('enrollment-drifted');
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 3 * H + 60_000, sessionStartTs: T0 }).accountId).toBeNull();
    expect(r.resolve({ root: homeB, kind: 'codex', ts: T0, sessionStartTs: T0 })).toMatchObject({ accountId: 'codex-b', identity: null, basis: 'identity-unconfirmed' });
  });

  it('unknown and shared roots never guess an account', () => {
    const homeA = temp(), homeB = temp();
    const accounts = [...pool(homeA, homeB), { id: 'claude-dup', framework: 'claude-code', configHome: homeA, provider: 'anthropic', email: 'd@example.com' }];
    const r = new ServedAccountResolver({ pool: () => accounts });
    r.refresh();
    expect(r.resolve({ root: temp(), kind: 'claude', ts: T0, sessionStartTs: null })).toMatchObject({ accountId: null, basis: 'unknown-root' });
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0, sessionStartTs: null })).toMatchObject({ accountId: null, basis: 'ambiguous-root' });
  });

  it('credential-ledger path: verified before the row, verified only after it, changed since, and a session older than the tenant', () => {
    const homeA = temp(), homeB = temp();
    const view = ledgerView([{ slot: homeA, accountId: 'claude-a', since: T0, lastVerifiedAt: T0 + 5 * H }],
      [{ op: 'reconcile', phase: 'done', slots: [homeA], at: new Date(T0 + H).toISOString() }]);
    const r = new ServedAccountResolver({ pool: () => pool(homeA, homeB), ledger: () => view });
    r.refresh();
    // A reconcile entry at T0+1h certifies rows after it.
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 2 * H, sessionStartTs: T0 + H })).toMatchObject({ accountId: 'claude-a', basis: 'ledger-verified', identity: identityKey('anthropic', 'a@example.com') });
    // Before any verification on record: unverified (a later check does not certify earlier work).
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 30 * 60_000, sessionStartTs: T0 + 60_000 }).basis).toBe('ledger-unverified');
    // The tenant entered the slot after the row: slot-changed, account null.
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 - H, sessionStartTs: T0 - 2 * H })).toMatchObject({ accountId: null, basis: 'slot-changed' });
    // A process started before the tenant arrived keeps the credentials it loaded.
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + 2 * H, sessionStartTs: T0 - H }).basis).toBe('slot-changed');
  });

  it('falls back to the enrollment path when the credential ledger is in unknown mode', () => {
    const homeA = temp(), homeB = temp();
    const view = ledgerView([{ slot: homeA, accountId: 'claude-a', since: T0, lastVerifiedAt: T0 }], [], true);
    const r = new ServedAccountResolver({ pool: () => pool(homeA, homeB), ledger: () => view });
    r.refresh();
    expect(r.resolve({ root: homeA, kind: 'claude', ts: T0 + H, sessionStartTs: T0 }).basis).toBe('identity-unconfirmed');
  });

  it('rebuilds its slot map when the pool account list changes', () => {
    const homeA = temp(), homeB = temp(), homeC = temp();
    let accounts = pool(homeA, homeB);
    const r = new ServedAccountResolver({ pool: () => accounts });
    r.refresh();
    expect(r.resolve({ root: homeC, kind: 'claude', ts: T0, sessionStartTs: null }).basis).toBe('unknown-root');
    accounts = [...accounts, { id: 'claude-c', framework: 'claude-code', configHome: homeC, provider: 'anthropic', email: 'c@example.com' }];
    r.refresh();
    expect(r.resolve({ root: homeC, kind: 'claude', ts: T0, sessionStartTs: null })).toMatchObject({ accountId: 'claude-c', basis: 'identity-unconfirmed' });
  });
});
