/**
 * QuotaHistoryLedger (docs/specs/quota-pacing-forecast.md §1): id validation and path
 * containment, append, same-measuredAt skip, fixed 5-minute buckets with state-aware replacement,
 * the future-measuredAt clamp, invalid windows stored as null, outcome rows for failed reads,
 * compaction (14 d full → hourly to 21 d → cycle-end rows), the 5,000-row cap, the 4 KB line skip,
 * atomic rewrite, the daily retire sweep (and restore on re-enroll), restart reload, the off switch
 * and the hourly tick row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaHistoryLedger, QUOTA_HISTORY, compactRows, buildLocalSummaries, isQuotaPacingEnabled } from '../../src/monitoring/QuotaHistoryLedger.js';
import { HOUR_MS, type HistoryRow } from '../../src/monitoring/quotaPacing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const T0 = Date.parse('2026-11-17T12:00:00Z');
const RESET = Date.parse('2026-11-18T06:38:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let now: number;
let enabled: boolean;
let accounts: Map<string, SubscriptionAccount>;

function account(id: string, extra: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return { id, nickname: id, email: `${id}@example.com`, provider: 'openai', framework: 'codex-cli', configHome: `/tmp/${id}`, status: 'active', enrolledAt: iso(T0), version: 1, ...extra } as SubscriptionAccount;
}
const pool = { get: (id: string) => accounts.get(id) ?? null, list: () => [...accounts.values()] };
function ledger() {
  return new QuotaHistoryLedger({ stateDir: path.join(dir, '.instar'), logsDir: path.join(dir, 'logs'), machineId: 'm_test', pool, enabled: () => enabled, now: () => now });
}
const snap = (pct: number, extra: Record<string, unknown> = {}) => ({
  kind: 'snapshot' as const, drifted: false,
  snap: { source: 'codex-app-server' as const, measuredAt: iso(now), sevenDay: { utilizationPct: pct, resetsAt: iso(RESET) }, fiveHour: { utilizationPct: 3, resetsAt: iso(now + 2 * HOUR_MS) }, ...extra },
});
const fileRows = (l: QuotaHistoryLedger, id: string): HistoryRow[] => {
  const f = l.fileFor(id)!;
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qhl-'));
  now = T0;
  enabled = true;
  accounts = new Map([['codex-a', account('codex-a')]]);
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/quota-history-ledger.test.ts:cleanup' }); });

describe('ids and paths', () => {
  it('rejects ids that fail ^[a-z0-9-]+$ or escape the folder, before any filesystem access', async () => {
    const l = ledger();
    for (const bad of ['../x', 'A', 'a/b', '', 'a.b', '..', 'x'.repeat(200)]) {
      expect(l.fileFor(bad)).toBeNull();
      expect(await l.rows(bad)).toBeNull();
      l.record(bad, snap(1));
    }
    expect(l.stats().invalidIds).toBe(7);
    expect(fs.existsSync(l.dir)).toBe(false);
    expect(l.fileFor('codex-a')).toBe(path.join(l.dir, 'codex-a.jsonl'));
  });

  it('an attributed id that is not in the local pool is not recorded (counted)', async () => {
    const l = ledger();
    l.record('someone-else', snap(5));
    await l.flush(true);
    expect(l.stats().unattributedReads).toBe(1);
    expect(fs.existsSync(path.join(l.dir, 'someone-else.jsonl'))).toBe(false);
  });
});

describe('recording', () => {
  it('appends a row with identity hash (never the email), source and windows', async () => {
    const l = ledger();
    l.record('codex-a', snap(42));
    await l.flush(true);
    const [r] = fileRows(l, 'codex-a');
    expect(r).toMatchObject({ v: 1, polledAt: iso(T0), measuredAt: iso(T0), source: 'codex-app-server', drifted: false });
    expect(r.identity).toMatch(/^openai:[0-9a-f]{16}$/);
    expect(JSON.stringify(r)).not.toContain('example.com');
    expect(r.windows.sevenDay).toEqual({ pct: 42, resetsAt: iso(RESET) });
  });

  it('keeps one row per 5-minute bucket under sustained one-minute reads', async () => {
    const l = ledger();
    for (let i = 0; i < 20; i++) { now = T0 + i * 60_000; l.record('codex-a', snap(10 + i)); }
    await l.flush(true);
    const rows = fileRows(l, 'codex-a');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.windows.sevenDay!.pct)).toEqual([14, 19, 24, 29]); // last reading of each bucket
  });

  it('never overwrites the last reading before a reset: a state change inside a bucket appends', async () => {
    const l = ledger();
    l.record('codex-a', snap(97));
    now = T0 + 60_000;
    l.record('codex-a', { ...snap(0), snap: { ...snap(0).snap, sevenDay: { utilizationPct: 0, resetsAt: iso(RESET + 168 * HOUR_MS) } } });
    await l.flush(true);
    expect(fileRows(l, 'codex-a').map((r) => r.windows.sevenDay!.pct)).toEqual([97, 0]);
  });

  it('skips a re-read of the same usage file (same measuredAt, same state)', async () => {
    const l = ledger();
    const fixed = iso(T0 - 30 * 60_000);
    for (let i = 0; i < 5; i++) {
      now = T0 + i * 10 * 60_000;
      l.record('codex-a', { kind: 'snapshot', drifted: false, snap: { source: 'codex-rollout', measuredAt: fixed, sevenDay: { utilizationPct: 20, resetsAt: iso(RESET) } } });
    }
    await l.flush(true);
    expect(fileRows(l, 'codex-a')).toHaveLength(1);
    expect(l.lastSeen('codex-a')!.polledAt).toBe(iso(T0 + 40 * 60_000));
  });

  it('clamps a measuredAt more than 5 minutes in the future and counts it', async () => {
    const l = ledger();
    l.record('codex-a', { ...snap(5), snap: { ...snap(5).snap, measuredAt: iso(T0 + HOUR_MS) } });
    await l.flush(true);
    expect(fileRows(l, 'codex-a')[0].measuredAt).toBe(iso(T0));
    expect(l.stats().futureClamped).toBe(1);
  });

  it('stores invalid windows and an unknown Fable percentage as null, never 0', async () => {
    const l = ledger();
    l.record('codex-a', { kind: 'snapshot', drifted: false, snap: {
      source: 'oauth-usage-endpoint-fallback', measuredAt: iso(now),
      sevenDay: { utilizationPct: 0, resetsAt: '' },
      fable: { utilizationPct: 0, resetsAt: iso(RESET) }, fableUnknown: true,
      fiveHour: { utilizationPct: 12, resetsAt: iso(now - 1) },
    } });
    await l.flush(true);
    const [r] = fileRows(l, 'codex-a');
    expect(r.windows.sevenDay).toEqual({ pct: null, resetsAt: null, invalid: true });
    expect(r.windows.fable).toMatchObject({ pct: null, invalid: true });
    expect(r.windows.fiveHour).toMatchObject({ pct: null, invalid: true });
  });

  it('marks a reading with no captured time as synthesized', async () => {
    const l = ledger();
    l.record('codex-a', { ...snap(5), snap: { ...snap(5).snap, measuredAtSynthesized: true } });
    await l.flush(true);
    expect(fileRows(l, 'codex-a')[0].measuredAtSynthesized).toBe(true);
  });

  it('records failed reads as outcome rows with no percentages', async () => {
    const l = ledger();
    l.record('codex-a', { kind: 'failed', outcome: 'signed-out', drifted: false });
    await l.flush(true);
    const [r] = fileRows(l, 'codex-a');
    expect(r).toMatchObject({ outcome: 'signed-out', measuredAt: null, windows: {} });
  });

  it('writes nothing while the switch is off', async () => {
    enabled = false;
    const l = ledger();
    l.record('codex-a', snap(5));
    await l.flush(true);
    await l.compactAll();
    expect(fs.existsSync(l.dir)).toBe(false);
    expect(await l.writeTick()).toBeNull();
  });

  it('a held tail is flushed when its bucket closes', async () => {
    const l = ledger();
    l.record('codex-a', snap(5));
    await l.flush(false);
    expect(fileRows(l, 'codex-a')).toHaveLength(0); // still in its bucket
    now = T0 + 6 * 60_000;
    await l.flush(false);
    expect(fileRows(l, 'codex-a')).toHaveLength(1);
  });
});

describe('loading', () => {
  it('reloads after a restart', async () => {
    const a = ledger();
    for (let i = 0; i < 3; i++) { now = T0 + i * 6 * 60_000; a.record('codex-a', snap(i)); }
    await a.stop();
    const b = ledger();
    expect((await b.rows('codex-a'))!.map((r) => r.windows.sevenDay!.pct)).toEqual([0, 1, 2]);
  });

  it('skips lines over 4 KB and malformed lines, counting them', async () => {
    const l = ledger();
    fs.mkdirSync(l.dir, { recursive: true });
    const good = JSON.stringify({ v: 1, polledAt: iso(T0), measuredAt: iso(T0), identity: null, source: null, drifted: false, windows: {} });
    fs.writeFileSync(l.fileFor('codex-a')!, [good, 'x'.repeat(QUOTA_HISTORY.MAX_LINE_BYTES + 1), '{"v":2}', 'not json', good].join('\n') + '\n');
    expect(await l.rows('codex-a')).toHaveLength(2);
    expect((await l.coverage('codex-a'))!.malformedRows).toBe(3);
  });

  it('enforces the 5,000-row cap on load, oldest first, with droppedRows and a rewrite', async () => {
    const l = ledger();
    fs.mkdirSync(l.dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < QUOTA_HISTORY.MAX_ROWS + 100; i++) {
      const t = T0 - (QUOTA_HISTORY.MAX_ROWS + 100 - i) * 60_000;
      lines.push(JSON.stringify({ v: 1, polledAt: iso(t), measuredAt: iso(t), identity: null, source: null, drifted: false, windows: { sevenDay: { pct: 1, resetsAt: iso(RESET) } } }));
    }
    fs.writeFileSync(l.fileFor('codex-a')!, lines.join('\n') + '\n');
    const rows = (await l.rows('codex-a'))!;
    expect(rows).toHaveLength(QUOTA_HISTORY.MAX_ROWS);
    const cov = (await l.coverage('codex-a'))!;
    expect(cov.droppedRows).toBe(100);
    expect(cov.historyCutAt).toBe(rows[0].polledAt);
    await l.compactAll();
    expect(fileRows(l, 'codex-a')).toHaveLength(QUOTA_HISTORY.MAX_ROWS);
    expect(fs.readdirSync(l.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('enforces the cap on append too', async () => {
    const l = ledger();
    fs.mkdirSync(l.dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < QUOTA_HISTORY.MAX_ROWS; i++) {
      const t = T0 - (QUOTA_HISTORY.MAX_ROWS - i) * 60_000;
      lines.push(JSON.stringify({ v: 1, polledAt: iso(t), measuredAt: iso(t), identity: null, source: null, drifted: false, windows: {} }));
    }
    fs.writeFileSync(l.fileFor('codex-a')!, lines.join('\n') + '\n');
    l.record('codex-a', snap(1));
    await l.flush(true);
    expect(await l.rows('codex-a')).toHaveLength(QUOTA_HISTORY.MAX_ROWS);
    expect((await l.coverage('codex-a'))!.droppedRows).toBe(1);
  });
});

describe('compaction', () => {
  const mk = (t: number, pct: number, reset: number): HistoryRow => ({ v: 1, polledAt: iso(t), measuredAt: iso(t), identity: null, source: 'codex-app-server', drifted: false, windows: { sevenDay: { pct, resetsAt: iso(reset) } } });

  it('keeps 14 days full, one row per hour to 21 days, then only cycle-end rows', () => {
    const rows: HistoryRow[] = [];
    const start = T0 - 30 * 24 * HOUR_MS;
    let reset = start + 3 * 24 * HOUR_MS;
    for (let t = start; t <= T0; t += 15 * 60_000) {
      while (reset <= t) reset += 168 * HOUR_MS;
      rows.push(mk(t, 10, reset));
    }
    const out = compactRows(rows, T0);
    const full = out.filter((r) => !r.resolution);
    const hourly = out.filter((r) => r.resolution === 'hourly');
    const ends = out.filter((r) => r.resolution === 'cycle-end');
    expect(full.every((r) => Date.parse(r.polledAt) >= T0 - 14 * 24 * HOUR_MS)).toBe(true);
    expect(hourly.length).toBeGreaterThanOrEqual(7 * 24 - 1);
    expect(hourly.length).toBeLessThanOrEqual(7 * 24 + 2);
    expect(hourly.every((r) => Date.parse(r.polledAt) < T0 - 14 * 24 * HOUR_MS && Date.parse(r.polledAt) >= T0 - 21 * 24 * HOUR_MS)).toBe(true);
    // beyond 21 days only the last reading before each reset survives
    expect(ends.length).toBeGreaterThanOrEqual(1);
    for (const e of ends) {
      const r = Date.parse(e.windows.sevenDay!.resetsAt!);
      expect(r - Date.parse(e.polledAt)).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it('compactAll rewrites atomically and is idempotent', async () => {
    const l = ledger();
    fs.mkdirSync(l.dir, { recursive: true });
    const old = T0 - 25 * 24 * HOUR_MS;
    const lines = [mk(old, 10, old + HOUR_MS), mk(old + 10 * 60_000, 12, old + HOUR_MS), mk(old + 30 * 60_000, 2, old + 169 * HOUR_MS), mk(T0 - HOUR_MS, 30, RESET)].map((r) => JSON.stringify(r));
    fs.writeFileSync(l.fileFor('codex-a')!, lines.join('\n') + '\n');
    await l.compactAll();
    const after = fileRows(l, 'codex-a');
    // the first old reading is not the last before its reset, so it goes; both cycle ends stay
    expect(after.map((r) => r.windows.sevenDay!.pct)).toEqual([12, 2, 30]);
    expect(after.map((r) => r.resolution ?? 'full')).toEqual(['cycle-end', 'cycle-end', 'full']);
    await l.compactAll();
    expect(fileRows(l, 'codex-a')).toEqual(after);
    expect(fs.readdirSync(l.dir).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('retire sweep', () => {
  it('moves a removed account to retired/, restores it on re-enroll, and deletes after 35 days', async () => {
    accounts.set('codex-b', account('codex-b'));
    const l = ledger();
    l.record('codex-b', snap(7));
    await l.flush(true);
    accounts.delete('codex-b');
    const swept = await l.sweepRetired();
    expect(swept.retired).toEqual(['codex-b']);
    expect(fs.existsSync(path.join(l.retiredDir, 'codex-b.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(l.dir, 'codex-b.jsonl'))).toBe(false);

    accounts.set('codex-b', account('codex-b'));
    expect((await l.rows('codex-b'))!.map((r) => r.windows.sevenDay!.pct)).toEqual([7]);
    expect(fs.existsSync(path.join(l.dir, 'codex-b.jsonl'))).toBe(true);

    accounts.delete('codex-b');
    await l.sweepRetired();
    now = T0 + 36 * 24 * HOUR_MS;
    const later = await l.sweepRetired();
    expect(later.deleted).toEqual(['codex-b.jsonl']);
    expect(fs.existsSync(path.join(l.retiredDir, 'codex-b.jsonl'))).toBe(false);
  });
});

describe('tick row and local summaries', () => {
  it('writes an hourly tick row to logs/quota-pacing.jsonl with the computed counts', async () => {
    const l = ledger();
    l.setTickSource(async () => ({ accounts: 1, withHistory: 1, stale: {}, verdicts: { 'on-track': 1 } }));
    const row = await l.writeTick();
    expect(row).toMatchObject({ kind: 'tick', machineId: 'm_test', accounts: 1, healthy: true, ledgerWriteFailures: 0 });
    const lines = fs.readFileSync(path.join(dir, 'logs', 'quota-pacing.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]).ts).toBe(iso(T0));
  });

  it('maintain() flushes closed buckets, compacts and ticks when the hour turns', async () => {
    const l = ledger();
    l.setTickSource(async () => ({ accounts: 1 }));
    l.record('codex-a', snap(1));
    await l.maintain();
    now = T0 + HOUR_MS + 60_000;
    await l.maintain();
    expect(fileRows(l, 'codex-a')).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'logs', 'quota-pacing.jsonl'))).toBe(true);
  });

  it('builds one summary per supported account from its own rows', async () => {
    accounts.set('claude-x', account('claude-x', { provider: 'anthropic', framework: 'claude-code' }));
    const l = ledger();
    for (let i = 0; i < 60; i++) { now = T0 - 15 * HOUR_MS + i * 15 * 60_000; l.record('codex-a', snap(20 + Math.floor(i / 4))); }
    await l.flush(true);
    const { summaries } = await buildLocalSummaries(l, pool, { machineId: 'm_test', pollIntervalMs: 15 * 60_000, now });
    expect(summaries.map((s) => s.accountId).sort()).toEqual(['claude-x', 'codex-a']);
    const a = summaries.find((s) => s.accountId === 'codex-a')!;
    expect(a.fresh).toBe(true);
    expect(a.sevenDay!.slopes.h24).not.toBeNull();
    expect(summaries.find((s) => s.accountId === 'claude-x')!.staleReason).toBe('not-polled');
  });
});

describe('the switch', () => {
  it('resolves through the development-agent gate with the key absent', () => {
    expect(isQuotaPacingEnabled({ developmentAgent: true })).toBe(true);
    expect(isQuotaPacingEnabled({ developmentAgent: false })).toBe(false);
    expect(isQuotaPacingEnabled({})).toBe(false);
    expect(isQuotaPacingEnabled({ developmentAgent: true, subscriptionPool: { pacing: { enabled: false } } })).toBe(false);
    expect(isQuotaPacingEnabled({ subscriptionPool: { pacing: { enabled: true } } })).toBe(true);
  });
});
