/**
 * DF-0001 (docs/specs/design-standard-enforcement.md §4 item 7): one set of boundary cases decides
 * usage colour on the server (the phone and Mac apps' source) and on the web console, for a single
 * limit and for an account, so a threshold or rounding change on either side fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  usageTone, usageWindows, topWindow, summarizeAccounts, USAGE_TONE_ATTN_PCT, NEAR_OUT_PCT,
} from '../../src/server/mobileCapacityRoutes.js';
// @ts-expect-error — plain browser module without types
import * as web from '../../dashboard/console/accounts-model.js';

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/data/design/usage-tone-vectors.json'), 'utf8')) as {
  bands: { attn: number; bad: number };
  cases: Array<{ pct: number; resetInPast: boolean; tone: 'attn' | 'bad' | null; countsAsTop: boolean }>;
  names: Record<string, string>;
};

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const future = new Date(NOW + 3_600_000).toISOString();
const past = new Date(NOW - 60_000).toISOString();

/** A reading with one weekly limit at this percentage, plus a low 5-hour limit that never resets here. */
function reading(pct: number, resetInPast: boolean) {
  return { measuredAt: new Date(NOW - 120_000).toISOString(), fiveHour: { utilizationPct: 10, resetsAt: future }, sevenDay: { utilizationPct: pct, resetsAt: resetInPast ? past : future } };
}

describe('usage tone: server and web agree on every boundary case', () => {
  it('both sides use the same two bands as the vectors file', () => {
    expect(USAGE_TONE_ATTN_PCT).toBe(vectors.bands.attn);
    expect(NEAR_OUT_PCT).toBe(vectors.bands.bad);
    expect(web.USAGE_TONE_ATTN_PCT).toBe(vectors.bands.attn);
    expect(web.NEAR_OUT_PCT).toBe(vectors.bands.bad);
  });

  for (const c of vectors.cases) {
    const label = `${c.pct}%${c.resetInPast ? ' with a past reset' : ''}`;

    it(`limit tone at ${label} is ${c.tone}`, () => {
      expect(usageTone(c.pct, c.resetInPast)).toBe(c.tone);
      expect(web.usageTone(c.pct, c.resetInPast)).toBe(c.tone);
      const serverWeekly = usageWindows(reading(c.pct, c.resetInPast), NOW).find((w) => w.label === 'weekly')!;
      expect(serverWeekly.tone).toBe(c.tone);
      expect(serverWeekly.rolledOver).toBe(c.resetInPast);
      const webWeekly = web.usageWindows(reading(c.pct, c.resetInPast), NOW).map((w: unknown) => web.windowRow(w, NOW)).find((w: { label: string }) => w.label === 'weekly');
      expect(webWeekly.tone).toBe(c.tone);
    });

    it(`at ${label} the limit ${c.countsAsTop ? 'decides' : 'does not decide'} the account, on both sides`, () => {
      const top = topWindow(usageWindows(reading(c.pct, c.resetInPast), NOW))!;
      expect(top.label === 'weekly').toBe(c.countsAsTop);
      const webTop = web.tightest(reading(c.pct, c.resetInPast), NOW);
      expect(webTop.label === 'weekly').toBe(c.countsAsTop);

      // Account tone: the server's summary and the web page colour the account from the same top limit.
      const row = { id: 'acct-1', nickname: 'Alex', email: 'alex@example.com', framework: 'claude-code', machineId: 'm1', status: 'active', loginCheck: 'ok', lastQuota: reading(c.pct, c.resetInPast) };
      const server = summarizeAccounts({ enabled: true, accounts: [row], pool: { selfMachineId: 'm1', failed: [] } }, { now: NOW }).accounts[0];
      const expectedAccountTone = c.countsAsTop ? c.tone : null; // the 5-hour limit at 10% is below every band
      expect(server.tone).toBe(expectedAccountTone);
      const page = web.buildAccountsPage({ ok: true, data: { enabled: true, accounts: [row], pool: { failed: [] } } }, NOW);
      expect(page.accounts[0].tone).toBe(expectedAccountTone);
    });
  }

  it('the server sends the same display name the web shows for every limit', () => {
    const q = { fiveHour: { utilizationPct: 1, resetsAt: future }, sevenDay: { utilizationPct: 2, resetsAt: future }, fable: { utilizationPct: 3, resetsAt: future } };
    const server = usageWindows(q, NOW);
    const webRows = web.usageWindows(q, NOW).map((w: unknown) => web.windowRow(w, NOW));
    expect(server.map((w) => w.label)).toEqual(['5-hour', 'weekly', 'Fable weekly']);
    for (const w of server) {
      expect(w.name).toBe(vectors.names[w.label]);
      expect(webRows.find((r: { label: string }) => r.label === w.label).name).toBe(w.name);
    }
  });
});
