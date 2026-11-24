import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
import { summarizeAccounts } from '../../src/server/mobileCapacityRoutes.js';

function seed() { return JSON.parse(fs.readFileSync('tests/design/seeds/accounts.json', 'utf8')); }
describe('synthetic Accounts design inputs', () => {
  it('contains invented raw inputs and explicit busy, empty and error states', () => {
    const fixture = seed();
    expect(fixture.version).toBe(1);
    expect(Object.keys(fixture.states).sort()).toEqual(['busy', 'empty', 'error']);
    const rows = fixture.states.busy.subscriptionPool.accounts;
    expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(fixture.busiestAccountCount);
    expect(Math.max(...rows.map((row: { nickname: string }) => row.nickname.length))).toBeGreaterThanOrEqual(fixture.longestNameLength);
    const addresses = JSON.stringify(fixture).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every(address => address.endsWith('@example.com'))).toBe(true);
    expect(Number.isFinite(Date.parse(fixture.now))).toBe(true);
  });
  it('drives both real production account models through zero, maximum, missing and optional windows', () => {
    const fixture = seed(); const state = fixture.states.busy; const now = Date.parse(fixture.now);
    const web = buildAccountsPage({ ok: true, data: state.subscriptionPool }, now, state.options);
    const mobile = summarizeAccounts(state.subscriptionPool, { now, inUseAccountId: state.options.inUse.activeAccountId });
    expect(web.ok).toBe(true); expect(mobile.enabled).toBe(true);
    expect(web.accounts).toHaveLength(fixture.busiestAccountCount);
    expect(mobile.accounts).toHaveLength(fixture.busiestAccountCount);
    const windows = web.accounts.flatMap((account: { windows: Array<{ pct: number; label: string; rolledOver: boolean }> }) => account.windows);
    expect(windows.some((window: { pct: number; rolledOver: boolean }) => window.pct === 0 && !window.rolledOver)).toBe(true);
    expect(windows.some((window: { pct: number; rolledOver: boolean }) => window.pct === 100 && !window.rolledOver)).toBe(true);
    expect(windows.some((window: { label: string }) => window.label === 'Fable weekly')).toBe(true);
    expect(web.accounts.some((account: { windows: unknown[] }) => account.windows.length === 0)).toBe(true);
    expect(web.accounts.some((account: { stale: boolean }) => account.stale)).toBe(true);
    expect(web.needs.length).toBeGreaterThan(0);
    expect(windows.some((window: { rolledOver: boolean }) => window.rolledOver)).toBe(true);
  });
  it('uses real empty and unavailable production model behavior rather than fabricated display output', () => {
    const fixture = seed(); const now = Date.parse(fixture.now);
    const empty = buildAccountsPage({ ok: true, data: fixture.states.empty.subscriptionPool }, now);
    expect(empty.ok).toBe(true); expect(empty.accounts).toEqual([]);
    const unavailable = buildAccountsPage({ ok: false, reason: fixture.states.error.reason }, now);
    expect(unavailable.ok).toBe(false); expect(unavailable.reason).toContain("Couldn't read accounts");
  });
});
