/**
 * quota pacing step 2 (docs/specs/quota-pacing-account-choice.md §1) — the poller records how
 * each empty-reset window was read (windowBasis), the reset it blanked (resetsAtBeforeRewrite),
 * which windows the provider listed (windowsListed), and runs the out-of-cycle read gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller, mapUsageResponse, OUT_OF_CYCLE_BREAKER_FAILURES } from '../../src/core/QuotaPoller.js';
import { projectAccountToMeta } from '../../src/core/SubscriptionAccountMetaReplicatedStore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/quota-poller-window-basis.test.ts:cleanup' });
});

describe('mapUsageResponse — windowBasis and windowsListed (Claude usage endpoint)', () => {
  const NOW = '2026-11-18T08:00:00.000Z';
  it('a null resets_at from the authenticated endpoint is idle-live; every listed window is recorded', () => {
    const snap = mapUsageResponse({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 12, resets_at: '2026-11-20T00:00:00Z' },
      limits: [],
    }, 'oauth-usage-endpoint-fallback', NOW);
    expect(snap.windowBasis).toEqual({ fiveHour: 'idle-live' });
    expect(snap.windowsListed).toEqual(['fiveHour', 'sevenDay']);
  });
  it('the Fable entry is listed and its empty reset gets a basis', () => {
    const snap = mapUsageResponse({
      seven_day: { utilization: 12, resets_at: '2026-11-20T00:00:00Z' },
      limits: [{ group: 'weekly', percent: 4, resets_at: null, scope: { model: { display_name: 'Fable' } } }],
    }, 'oauth-usage-endpoint-fallback', NOW);
    expect(snap.windowsListed).toEqual(['sevenDay', 'fable']);
    expect(snap.windowBasis).toEqual({ fable: 'idle-live' });
  });
  it('no parsed limits list → no windowsListed (absent windows stay unread)', () => {
    const snap = mapUsageResponse({ seven_day: { utilization: 12, resets_at: '2026-11-20T00:00:00Z' } }, 'oauth-usage-endpoint-fallback', NOW);
    expect(snap.windowsListed).toBeUndefined();
  });
  it('a non-endpoint source marks an empty reset as rolled-history', () => {
    const snap = mapUsageResponse({ five_hour: { utilization: 0, resets_at: null }, limits: [] }, 'claude-code-usage-screen', NOW);
    expect(snap.windowBasis).toEqual({ fiveHour: 'rolled-history' });
  });
});

describe('the replicated projection never carries the step 2 local fields', () => {
  it('strips windowBasis, resetsAtBeforeRewrite and windowsListed', () => {
    const out = projectAccountToMeta({
      id: 'a', nickname: 'a', provider: 'anthropic', framework: 'claude-code', status: 'active',
      lastQuota: {
        sevenDay: { utilizationPct: 1, resetsAt: '2026-11-20T00:00:00Z' },
        windowBasis: { fiveHour: 'idle-live' }, resetsAtBeforeRewrite: { fiveHour: 'x' }, windowsListed: ['sevenDay'],
      },
    }) as { quota: Record<string, unknown> };
    expect(Object.keys(out.quota)).toEqual(['sevenDay']);
  });
});

function codexHarness(reader: (o: { codexHome?: string }) => Promise<unknown>, rollout: () => Promise<unknown> = async () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-basis-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const pool = new SubscriptionPool({ stateDir });
  pool.addFixture({ id: 'codex-a', nickname: 'A', email: 'a@example.test', provider: 'openai', framework: 'codex-cli', configHome: path.join(dir, '.codex-a') });
  const clock = { t: Date.parse('2026-11-18T08:00:00.000Z') };
  const poller = new QuotaPoller({
    pool,
    now: () => clock.t,
    codexLiveUsageReaderDetailed: reader as never,
    codexUsageReader: rollout as never,
    pollIntervalMs: 15 * 60_000,
  });
  return { pool, poller, clock };
}

const liveSnap = (atMs: number, resetMs: number, src: 'codex-app-server' | 'codex-rollout' = 'codex-app-server') => ({
  source: src, rolloutPath: '', threadId: null, capturedAt: new Date(atMs).toISOString(), model: null, planType: 'plus', rateLimitReachedType: null,
  primary: null,
  secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAtIso: new Date(resetMs).toISOString() },
});

describe('Codex window rewrite: basis follows the actual source', () => {
  it('a live read of an elapsed window is rolled-history (Codex idle premise unverified), keeps the original reset, and lists its windows', async () => {
    const t0 = Date.parse('2026-11-18T08:00:00.000Z');
    const reset = t0 - 3_600_000;
    const { pool, poller } = codexHarness(async () => ({ kind: 'ok', snapshot: liveSnap(t0, reset) }));
    const snap = await poller.pollAccount(pool.get('codex-a')!);
    expect(snap?.sevenDay).toEqual({ utilizationPct: 0, resetsAt: '' });
    expect(snap?.windowBasis).toEqual({ sevenDay: 'rolled-history' });
    expect(snap?.resetsAtBeforeRewrite).toEqual({ sevenDay: new Date(reset).toISOString() });
    expect(snap?.windowsListed).toEqual(['sevenDay']);
  });
  it('a rollout-file reading of an elapsed window is rolled-history and lists nothing', async () => {
    const t0 = Date.parse('2026-11-18T08:00:00.000Z');
    const { pool, poller } = codexHarness(async () => ({ kind: 'unavailable' }), async () => liveSnap(t0, t0 - 3_600_000, 'codex-rollout'));
    const snap = await poller.pollAccount(pool.get('codex-a')!);
    expect(snap?.windowBasis).toEqual({ sevenDay: 'rolled-history' });
    expect(snap?.windowsListed).toBeUndefined();
  });
});

describe('the out-of-cycle read gate', () => {
  async function settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

  it('one read per account per poll interval across callers, and the decision never waits', async () => {
    const t0 = Date.parse('2026-11-18T08:00:00.000Z');
    const reader = vi.fn(async () => ({ kind: 'ok', snapshot: liveSnap(t0, t0 + 3_600_000) }));
    const { poller, clock } = codexHarness(reader);
    const ret = poller.requestRead('codex-a');
    expect(ret).toBeUndefined(); // fire-and-forget
    poller.requestRead('codex-a');
    await settle();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(poller.outOfCycleFailures('codex-a')).toBe(0);
    clock.t += 5 * 60_000;
    poller.requestRead('codex-a'); // success cleared the state, so a later request may read again
    await settle();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('backs off to two and four intervals on failure and opens the breaker after 6; a landed reading closes it', async () => {
    let ok = false;
    const t0 = Date.parse('2026-11-18T08:00:00.000Z');
    const reader = vi.fn(async () => (ok ? { kind: 'ok', snapshot: liveSnap(t0, t0 + 3_600_000) } : { kind: 'unavailable' }));
    const rollout = vi.fn(async () => liveSnap(t0, t0 + 3_600_000, 'codex-rollout'));
    const { pool, poller, clock } = codexHarness(reader, rollout);
    const I = 15 * 60_000;
    poller.requestRead('codex-a'); await settle();
    expect(poller.outOfCycleFailures('codex-a')).toBe(1);
    expect(rollout).not.toHaveBeenCalled(); // live-only for Codex
    clock.t += I; poller.requestRead('codex-a'); await settle();
    expect(poller.outOfCycleFailures('codex-a')).toBe(1); // inside the 2-interval backoff
    clock.t += I; poller.requestRead('codex-a'); await settle();
    expect(poller.outOfCycleFailures('codex-a')).toBe(2);
    for (let i = 0; i < 10; i++) { clock.t += 4 * I; poller.requestRead('codex-a'); await settle(); }
    expect(poller.outOfCycleFailures('codex-a')).toBe(OUT_OF_CYCLE_BREAKER_FAILURES);
    expect(poller.rereadBreakerOpen('codex-a')).toBe(true);
    const calls = reader.mock.calls.length;
    clock.t += 10 * I; poller.requestRead('codex-a'); await settle();
    expect(reader.mock.calls.length).toBe(calls); // breaker open: no out-of-cycle read
    ok = true;
    await poller.pollAll(); // the regular poll still runs and closes the breaker
    expect(poller.rereadBreakerOpen('codex-a')).toBe(false);
    void pool;
  });

  it('a failure that lands after a landed reading cleared the entry does not restore the old count', async () => {
    let release: (v: unknown) => void = () => {};
    let mode: 'fail' | 'hang' = 'fail';
    const reader = vi.fn(async () => {
      if (mode === 'hang') return new Promise((r) => { release = r; });
      return { kind: 'unavailable' };
    });
    const { poller, clock } = codexHarness(reader);
    poller.requestRead('codex-a'); await settle();
    expect(poller.outOfCycleFailures('codex-a')).toBe(1);
    clock.t += 2 * 15 * 60_000;
    mode = 'hang';
    poller.requestRead('codex-a'); await settle(); // in flight, will fail later
    // A reading lands meanwhile (a scheduled poll shares this in-flight live read per home, so
    // simulate exactly what pollOne does on a landed reading: clear the account's gate entry).
    (poller as unknown as { outOfCycle: Map<string, unknown> }).outOfCycle.delete('codex-a');
    expect(poller.outOfCycleFailures('codex-a')).toBe(0);
    release({ kind: 'unavailable' }); // the stale in-flight read now fails
    await settle();
    expect(poller.outOfCycleFailures('codex-a')).toBe(0);
  });

  it('skips needs-reauth and disabled accounts', async () => {
    const reader = vi.fn(async () => ({ kind: 'unavailable' }));
    const { pool, poller } = codexHarness(reader);
    pool.update('codex-a', { status: 'needs-reauth' });
    poller.requestRead('codex-a');
    await settle();
    expect(reader).not.toHaveBeenCalled();
  });
});
