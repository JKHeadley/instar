/**
 * quota pacing step 2 (docs/specs/quota-pacing-account-choice.md §§3-5) — the placement
 * decision both spawn resolvers share, the default spawn path (UsageWallRescue.spawnAccount),
 * swap-path validity and whole-pool blindness, and the shadow log.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UsageWallRescue } from '../../src/core/UsageWallRescue.js';
import { decideWindowAwarePlacement, isWindowAwareChoiceEnabled, type WindowAwareDeps } from '../../src/core/windowAwarePlacement.js';
import { readingValidity } from '../../src/core/SwapAntiThrash.js';
import { poolHeadroom } from '../../src/core/QuotaAwareScheduler.js';
import {
  AccountChoiceShadowLog, readShadowRows, pageShadowRows, summarizeShadowRows, sanitizeModel,
  type PlacementShadowInput,
} from '../../src/monitoring/AccountChoiceShadowLog.js';
import type { AccountQuotaSnapshot, SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-11-18T08:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const fresh = iso(NOW - 5 * 60_000);
const win = (pct: number, resetInH: number) => ({ utilizationPct: pct, resetsAt: iso(NOW + resetInH * H) });

function acct(id: string, q: Partial<AccountQuotaSnapshot> | null): SubscriptionAccount {
  return {
    id, nickname: id, email: `${id}@example.com`, provider: 'anthropic', framework: 'claude-code',
    configHome: `/h/${id}`, status: 'active',
    lastQuota: q === null ? null : ({ source: 'oauth-usage-endpoint-fallback', measuredAt: fresh, ...q } as AccountQuotaSnapshot),
  } as SubscriptionAccount;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/window-aware-placement.test.ts:cleanup' }); });

function rescueWith(accounts: SubscriptionAccount[], wa?: WindowAwareDeps) {
  return new UsageWallRescue({
    readConfig: () => ({ wallRescue: { enabled: true } }),
    listAccounts: () => accounts,
    getSession: () => undefined,
    configHomeForSession: () => undefined,
    resolveDefaultAccountId: async () => null,
    swap: async () => ({ swapped: false, toAccountId: null, reason: 'x' }),
    now: () => NOW,
    windowAware: wa,
  });
}

describe('default spawn path (UsageWallRescue.spawnAccount)', () => {
  const A = acct('a', { fiveHour: win(10, 0.5), sevenDay: win(40, 144), windowsListed: ['fiveHour', 'sevenDay'] });
  const B = acct('b', { sevenDay: win(20, 2), windowsListed: ['sevenDay'] });

  it('switch off: today\'s rule (least used); switch on: the shared tiered score', () => {
    expect(rescueWith([A, B]).spawnAccount()?.accountId).toBe('b'); // 20 < 40 today too
    const C = acct('c', { sevenDay: win(5, 150), windowsListed: ['sevenDay'] });
    expect(rescueWith([C, B]).spawnAccount()?.accountId).toBe('c'); // today: least used
    const rows: PlacementShadowInput[] = [];
    const on: WindowAwareDeps = { enabled: () => true, record: (r) => rows.push(r) };
    expect(rescueWith([C, B], on).spawnAccount({ model: 'claude-opus-5-5', modelSource: 'explicit', sessionName: 'echo-x' })?.accountId).toBe('b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ caller: 'spawn-default', oldPick: 'c', newPick: 'b', executed: 'b', sessionName: 'echo-x', modelSource: 'explicit' });
    expect(rows[0].reasons).toContain('window-pairing');
  });

  it('with every fresh account\'s weekly window rolled it still returns an account', () => {
    const r1 = acct('r1', { sevenDay: win(92, -0.2), windowsListed: ['sevenDay'] });
    const r2 = acct('r2', { sevenDay: win(50, -0.5), windowsListed: ['sevenDay'] });
    expect(rescueWith([r1, r2], { enabled: () => true }).spawnAccount()).not.toBeNull();
  });

  it('a stale account is excluded by isFresh as today', () => {
    const stale = acct('stale', { sevenDay: win(1, 100), measuredAt: iso(NOW - 72 * H) });
    const ok = acct('ok', { sevenDay: win(60, 100), windowsListed: ['sevenDay'] });
    expect(rescueWith([stale, ok], { enabled: () => true }).spawnAccount()?.accountId).toBe('ok');
  });

  it('the reviewer login (shadow: false) writes no row', () => {
    const rows: PlacementShadowInput[] = [];
    rescueWith([A, B], { enabled: () => true, record: (r) => rows.push(r) }).spawnAccount({ shadow: false });
    expect(rows).toHaveLength(0);
  });

  it('an unreadable switch is off', () => {
    const C = acct('c', { sevenDay: win(5, 150) });
    expect(rescueWith([C, B], { enabled: () => { throw new Error('boom'); } }).spawnAccount()?.accountId).toBe('c');
  });
});

describe('decideWindowAwarePlacement', () => {
  it('a throwing old-rule computation leaves the pick unchanged and still records', () => {
    const rows: PlacementShadowInput[] = [];
    const pick = decideWindowAwarePlacement({
      accounts: [acct('b', { sevenDay: win(20, 2), windowsListed: ['sevenDay'] })],
      framework: 'claude-code', softThresholdPct: 90, nowMs: NOW, caller: 'spawn-pinned',
      deps: { enabled: () => true, record: (r) => rows.push(r) },
      oldPick: () => { throw new Error('old rule broke'); },
    });
    expect(pick?.id).toBe('b');
    expect(rows[0].oldPick).toBeNull();
  });
  it('the dev gate resolves on for a development agent without the key, an explicit value wins', () => {
    expect(isWindowAwareChoiceEnabled({ developmentAgent: true })).toBe(true);
    expect(isWindowAwareChoiceEnabled({ developmentAgent: false })).toBe(false);
    expect(isWindowAwareChoiceEnabled({ developmentAgent: true, subscriptionPool: { pacing: { windowAwareChoice: false } } })).toBe(false);
    expect(isWindowAwareChoiceEnabled({ subscriptionPool: { pacing: { windowAwareChoice: true } } })).toBe(true);
  });
});

describe('swap-path validity (readingValidity)', () => {
  it('rolled, unknown and old-cycle readings are invalid with their own reasons only when window-aware', () => {
    const rolled = acct('r', { sevenDay: win(92, -0.1) });
    expect(readingValidity(rolled, NOW, 30 * 60_000).valid).toBe(true);
    expect(readingValidity(rolled, NOW, 30 * 60_000, { windowAware: true })).toMatchObject({ valid: false, invalidReason: 'rolled' });
    const unknown = acct('u', { sevenDay: { utilizationPct: 5, resetsAt: 'later' } });
    expect(readingValidity(unknown, NOW, 30 * 60_000, { windowAware: true }).invalidReason).toBe('unknown');
    const old = acct('o', { sevenDay: win(5, -200) });
    expect(readingValidity(old, NOW, 30 * 60_000, { windowAware: true }).invalidReason).toBe('unread');
    const idle = acct('i', { sevenDay: { utilizationPct: 0, resetsAt: '' }, windowBasis: { sevenDay: 'idle-live' } });
    expect(readingValidity(idle, NOW, 30 * 60_000, { windowAware: true }).valid).toBe(true);
    const post = acct('p', { sevenDay: win(3, 160) });
    expect(readingValidity(post, NOW, 30 * 60_000, { windowAware: true }).valid).toBe(true);
  });
});

describe('AccountChoiceShadowLog', () => {
  const input = (over: Partial<PlacementShadowInput> = {}): PlacementShadowInput => ({
    sessionName: 'echo-a', caller: 'spawn-default', framework: 'claude-code', model: 'claude-opus-5-5', modelSource: 'explicit',
    executed: 'b', oldPick: 'a', newPick: 'b', reasons: ['window-pairing'], accounts: [], ...over,
  });
  function tmpFile() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'));
    dirs.push(d);
    return path.join(d, 'logs', 'placement-shadow.jsonl');
  }

  it('one row per placement with its session name; model sanitized; differs computed', async () => {
    const file = tmpFile();
    const log = new AccountChoiceShadowLog({ file, machineId: 'm1', now: () => NOW, flushMs: 0 });
    log.record(input());
    log.record(input({ sessionName: 'echo-b', oldPick: 'b', model: 'bad model!' }));
    await log.flush();
    const { rows } = await readShadowRows(file);
    expect(rows.map((r) => [r.sessionName, r.differs, r.model])).toEqual([['echo-a', true, 'claude-opus-5-5'], ['echo-b', false, 'other']]);
    expect(sanitizeModel(undefined)).toBeNull();
  });

  it('trims to the last 30 days at the day roll', async () => {
    const file = tmpFile();
    let t = NOW - 40 * 24 * H;
    const log = new AccountChoiceShadowLog({ file, machineId: 'm1', now: () => t, flushMs: 0 });
    log.record(input({ sessionName: 'old' }));
    await log.flush();
    t = NOW;
    log.record(input({ sessionName: 'new' }));
    await log.flush();
    expect((await readShadowRows(file)).rows.map((r) => r.sessionName)).toEqual(['new']);
  });

  it('a log left by an unclean stop marks the next row lostOnRestart: unknown; a clean stop does not', async () => {
    const file = tmpFile();
    const a = new AccountChoiceShadowLog({ file, machineId: 'm1', now: () => NOW, flushMs: 0 });
    a.record(input());
    await a.flush(); // no stop(): unclean
    const b = new AccountChoiceShadowLog({ file, machineId: 'm1', now: () => NOW, flushMs: 0 });
    b.record(input({ sessionName: 'after' }));
    await b.stop();
    const c = new AccountChoiceShadowLog({ file, machineId: 'm1', now: () => NOW, flushMs: 0 });
    c.record(input({ sessionName: 'clean' }));
    await c.flush();
    const rows = (await readShadowRows(file)).rows;
    expect(rows.find((r) => r.sessionName === 'after')?.lostOnRestart).toBe('unknown');
    expect(rows.find((r) => r.sessionName === 'clean')?.lostOnRestart).toBeUndefined();
  });

  it('pages with a cursor (limit ≤ 500) and summarizes per day', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ ...input({ sessionName: `s${i}` }), kind: 'placement' as const, ts: iso(NOW + i * 60_000), decisionId: `d${i}`, machineId: 'm1', differs: i % 2 === 0 }));
    const p1 = pageShadowRows(rows, { limit: 3 });
    expect(p1.rows.map((r) => r.sessionName)).toEqual(['s0', 's1', 's2']);
    const p2 = pageShadowRows(rows, { limit: 3, cursor: p1.next });
    expect(p2.rows.map((r) => r.sessionName)).toEqual(['s3', 's4', 's5']);
    expect(pageShadowRows(rows, { limit: 10_000 }).rows).toHaveLength(7);
    const days = summarizeShadowRows(rows);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ placements: 7, differing: 4 });
  });
});

describe('the throttle (poolHeadroom) is wired window-aware in production', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  it('the production throttle call spreads the window-aware options, built before it, behind the live switch', () => {
    const call = src.indexOf('quotaTracker.setPoolQuotaProvider(() => poolHeadroom(subscriptionPool.list(), {');
    expect(call).toBeGreaterThan(0);
    const callBody = src.slice(call, src.indexOf('}));', call));
    expect(callBody).toContain('...windowAwareThrottleOpts(),');
    const def = src.indexOf('const windowAwareThrottleOpts = ');
    expect(def).toBeGreaterThan(0);
    expect(def).toBeLessThan(call);
    expect(src.indexOf('const windowAwareEnabled = ')).toBeLessThan(call);
    const defBody = src.slice(def, src.indexOf(': {};', def));
    expect(defBody).toContain('windowAwareEnabled()');
    expect(defBody).toContain('windowAware: true');
    expect(defBody).toContain('breakerOpen: windowAwareDeps.breakerOpen');
  });

  it('with the options the throttle reports null for a rolled window, degraded, and the breaker', () => {
    const rolled = acct('r', { sevenDay: win(85, -0.5), windowsListed: ['sevenDay'] });
    const other = acct('o', { sevenDay: win(97, 50), windowsListed: ['sevenDay'] });
    const old = poolHeadroom([rolled, other], { nowMs: NOW });
    expect(old.weeklyPercent).toBe(85); // today's rule reads last cycle's number
    const wa = poolHeadroom([rolled, other], { nowMs: NOW, windowAware: true, breakerOpen: (id) => id === 'r' });
    expect(wa).toMatchObject({ placeable: true, weeklyPercent: null, degraded: true, rereadBreaker: 'open' });
  });
});
