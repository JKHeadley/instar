/**
 * Wiring: QuotaPoller.pollAccount() → the quota-history ledger (docs/specs/quota-pacing-forecast.md §1).
 *
 * The wrapper records snapshots and failed reads, never a not-a-read (identity attributed to
 * nothing / read gate dropped), always with the attributed account id, on every path that reads
 * (scheduled pollAll, triggered requestCodexCheck, a direct pollAccount as the manual refresh route
 * and the relogin runtime use). A throwing ledger leaves the poll result exactly as it was. The two
 * additive snapshot flags (measuredAtSynthesized, fableUnknown) never change an existing value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { QuotaHistoryLedger, type QuotaHistoryInput, type QuotaHistorySink } from '../../src/monitoring/QuotaHistoryLedger.js';
import { projectAccountToMeta } from '../../src/core/SubscriptionAccountMetaReplicatedStore.js';
import type { CodexLiveRead } from '../../src/providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';

const NOW = Date.parse('2026-11-17T18:00:00Z');
const liveSnapshot = (used: number, capturedAt: string | null = '2026-11-17T18:00:00.000Z') => ({
  source: 'codex-app-server' as const, rolloutPath: '', threadId: null,
  capturedAt, model: null, planType: 'pro', rateLimitReachedType: null,
  primary: { usedPercent: used, remainingPercent: 100 - used, windowMinutes: 10080, resetsAt: 1795500000,
    resetsAtIso: '2026-11-18T06:38:00.000Z', resetsInSeconds: 1 },
  secondary: null,
});
const CODEX = { nickname: 'codex', email: 'codex@example.test', provider: 'openai' as const, framework: 'codex-cli' as const, configHome: '/home/x/.codex-a' };
const CLAUDE = { nickname: 'claude', email: 'claude@example.test', provider: 'anthropic' as const, framework: 'claude-code' as const, configHome: '/home/x/.claude-a' };

class RecordingSink implements QuotaHistorySink {
  calls: Array<{ id: string; input: QuotaHistoryInput }> = [];
  failures = 0;
  throwOnRecord = false;
  record(id: string, input: QuotaHistoryInput) { if (this.throwOnRecord) throw new Error('disk full'); this.calls.push({ id, input }); }
  noteRecordFailure() { this.failures++; }
}

const usageBody = (fablePercent: number | null | undefined = 20) => ({
  five_hour: { utilization: 10, resets_at: '2026-11-17T20:00:00Z' },
  seven_day: { utilization: 40, resets_at: '2026-11-18T06:38:00Z' },
  ...(fablePercent === undefined ? {} : { limits: [{ group: 'weekly', scope: { model: { display_name: 'Fable' } }, percent: fablePercent, resets_at: '2026-11-18T06:38:00Z' }] }),
});
const fetchOk = (body: unknown): FetchImpl => async () => ({ ok: true, status: 200, json: async () => body });
const fetchStatus = (status: number): FetchImpl => async () => ({ ok: false, status, json: async () => ({}) });

describe('QuotaPoller → quota history wiring', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-hist-')); pool = new SubscriptionPool({ stateDir: dir }); clock = NOW; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-history-wiring cleanup' }); });

  function codexPoller(live: () => Promise<CodexLiveRead>, extra: Record<string, unknown> = {}) {
    return new QuotaPoller({
      pool, now: () => clock,
      codexLiveUsageReaderDetailed: async () => live(),
      codexUsageReader: async () => null,
      codexLoginStatus: async () => 'signed-out',
      ...extra,
    });
  }
  function claudePoller(fetchImpl: FetchImpl, extra: Record<string, unknown> = {}) {
    return new QuotaPoller({ pool, now: () => clock, tokenResolver: () => 'sk-ant-oat-test', fetchImpl, refresher: async () => ({ ok: false, reason: 'no-refresh-token' }) as never, ...extra });
  }

  it('the scheduled pass records a snapshot under the attributed id', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const sink = new RecordingSink();
    const p = codexPoller(async () => ({ kind: 'ok', snapshot: liveSnapshot(33) }) as CodexLiveRead);
    p.setHistoryLedger(sink);
    expect(await p.pollAll()).toEqual({ polled: 1, failed: 0 });
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ id: 'codex-a', input: { kind: 'snapshot', drifted: false } });
    const snap = (sink.calls[0].input as { snap: { sevenDay?: { utilizationPct: number }; measuredAtSynthesized?: boolean } }).snap;
    expect(snap.sevenDay?.utilizationPct).toBe(33);
    expect(snap.measuredAtSynthesized).toBeUndefined();
  });

  it('a triggered read (requestCodexCheck) records too', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const sink = new RecordingSink();
    const p = codexPoller(async () => ({ kind: 'ok', snapshot: liveSnapshot(5) }) as CodexLiveRead);
    p.setHistoryLedger(sink);
    expect(await p.requestCodexCheck('codex-a', { confirmation: true })).toBe(true);
    expect(sink.calls.map((c) => c.input.kind)).toEqual(['snapshot']);
  });

  it('a direct pollAccount (manual refresh route, relogin verification) records and returns the same snapshot', async () => {
    pool.addFixture({ ...CLAUDE, id: 'claude-a' });
    const sink = new RecordingSink();
    const p = claudePoller(fetchOk(usageBody()));
    p.setHistoryLedger(sink);
    const snap = await p.pollAccount(pool.get('claude-a')!);
    expect(snap?.sevenDay?.utilizationPct).toBe(40);
    expect(sink.calls).toHaveLength(1);
    expect((sink.calls[0].input as { snap: unknown }).snap).toBe(snap);
  });

  it('records a Codex auth refusal as a failed read (signed-out from the login check)', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const sink = new RecordingSink();
    const p = codexPoller(async () => ({ kind: 'auth-failed' }) as CodexLiveRead);
    p.setHistoryLedger(sink);
    expect(await p.pollAccount(pool.get('codex-a')!)).toBeNull();
    expect(sink.calls[0]).toMatchObject({ id: 'codex-a', input: { kind: 'failed', outcome: 'signed-out' } });
  });

  it('records a transport failure with no rollout fallback as read-failing', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const sink = new RecordingSink();
    const p = codexPoller(async () => ({ kind: 'unavailable' }) as CodexLiveRead);
    p.setHistoryLedger(sink);
    expect(await p.pollAccount(pool.get('codex-a')!)).toBeNull();
    expect(sink.calls[0]).toMatchObject({ input: { kind: 'failed', outcome: 'read-failing' } });
  });

  it('Claude failure exits: HTTP error, network failure, needs-reauth and an unreadable credential are all failed reads', async () => {
    pool.addFixture({ ...CLAUDE, id: 'claude-a' });
    const cases: Array<[QuotaPoller, string]> = [
      [claudePoller(fetchStatus(500)), 'read-failing'],
      [claudePoller(async () => { throw new Error('ECONNRESET'); }), 'read-failing'],
      [claudePoller(fetchStatus(401)), 'signed-out'],
      [claudePoller(fetchOk(usageBody()), { tokenResolver: () => ({ observationOnly: true, reason: 'credential-absent-or-unreadable' }) }), 'read-failing'],
      [claudePoller(fetchOk(usageBody()), { tokenResolver: () => ({ reauthNeeded: true, reason: 'unparseable-credential-blob' }) }), 'signed-out'],
    ];
    for (const [p, outcome] of cases) {
      const sink = new RecordingSink();
      p.setHistoryLedger(sink);
      expect(await p.pollAccount(pool.get('claude-a')!)).toBeNull();
      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]).toMatchObject({ id: 'claude-a', input: { kind: 'failed', outcome } });
    }
  });

  it('never records a not-a-read (the identity check attributed the read to nothing)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'claude-a' });
    const sink = new RecordingSink();
    const p = claudePoller(fetchOk(usageBody()), { resolveSlotIdentity: async () => ({ accountId: 'not-enrolled-anywhere' }) });
    p.setHistoryLedger(sink);
    expect(await p.pollAccount(pool.get('claude-a')!)).toBeNull();
    expect(sink.calls).toEqual([]);
  });

  it('a throwing ledger leaves the poll result unchanged and is counted', async () => {
    pool.addFixture({ ...CLAUDE, id: 'claude-a' });
    const plain = claudePoller(fetchOk(usageBody()));
    const expected = await plain.pollAccount(pool.get('claude-a')!);
    const sink = new RecordingSink();
    sink.throwOnRecord = true;
    const p = claudePoller(fetchOk(usageBody()));
    p.setHistoryLedger(sink);
    const got = await p.pollAccount(pool.get('claude-a')!);
    expect(got).toEqual(expected);
    expect(p.historyFailures()).toBe(1);
    expect(sink.failures).toBe(1);
    expect(await p.pollAll()).toEqual({ polled: 1, failed: 0 });
  });

  it('flags a Codex reading with no captured time as synthesized (measuredAt unchanged)', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const p = codexPoller(async () => ({ kind: 'ok', snapshot: liveSnapshot(5, null) }) as CodexLiveRead);
    const snap = await p.pollAccount(pool.get('codex-a')!);
    expect(snap?.measuredAtSynthesized).toBe(true);
    expect(snap?.measuredAt).toBe(new Date(NOW).toISOString());
  });

  it('flags a null Fable percentage as unknown without changing the existing 0 value', async () => {
    pool.addFixture({ ...CLAUDE, id: 'claude-a' });
    const snap = await claudePoller(fetchOk(usageBody(null))).pollAccount(pool.get('claude-a')!);
    expect(snap?.fable?.utilizationPct).toBe(0);
    expect(snap?.fableUnknown).toBe(true);
    const known = await claudePoller(fetchOk(usageBody(20))).pollAccount(pool.get('claude-a')!);
    expect(known?.fableUnknown).toBeUndefined();
  });

  it('the two flags never cross machines: the replicated projection strips them', () => {
    const out = projectAccountToMeta({ id: 'a', nickname: 'a', provider: 'openai', framework: 'codex-cli', status: 'active',
      lastQuota: { source: 'codex-rollout', measuredAt: '2026-11-17T18:00:00Z', measuredAtSynthesized: true, fableUnknown: true } });
    expect(out.quota).toEqual({ source: 'codex-rollout', measuredAt: '2026-11-17T18:00:00Z' });
  });

  it('end to end with the real ledger: a scheduled pass writes the history file', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const ledger = new QuotaHistoryLedger({ stateDir: dir, logsDir: path.join(dir, 'logs'), machineId: 'm', pool, enabled: () => true, now: () => clock });
    const p = codexPoller(async () => ({ kind: 'ok', snapshot: liveSnapshot(12) }) as CodexLiveRead);
    p.setHistoryLedger(ledger);
    await p.pollAll();
    await ledger.flush(true);
    const rows = (await ledger.rows('codex-a'))!;
    expect(rows).toHaveLength(1);
    expect(rows[0].windows.sevenDay).toEqual({ pct: 12, resetsAt: '2026-11-18T06:38:00.000Z' });
    expect(fs.existsSync(path.join(dir, 'state', 'quota-history', 'codex-a.jsonl'))).toBe(true);
  });
});
