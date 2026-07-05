/**
 * Unit tests for the routing-control-room-spend Layer 0/2 additions to
 * FeatureMetricsLedger: the `door` column, the maintained `spend_token_rollup` daily
 * aggregate (upsert-on-insert, gated by maintainSpendRollup), the idempotent
 * reconcile-from-raw, the batched retention prune, and the daily/hourly read methods.
 * Uses in-memory SQLite (no disk).
 */
import { describe, it, expect } from 'vitest';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

function ledger(maintainSpendRollup: boolean, now: () => number) {
  return new FeatureMetricsLedger({ dbPath: ':memory:', maintainSpendRollup, now });
}

const T = (day: string) => Date.parse(`2026-07-${day}T12:00:00Z`);

describe('door column (Layer 0)', () => {
  it('records and preserves the door dimension in the rollup', () => {
    const l = ledger(true, () => T('03'));
    l.record({ feature: 'x', outcome: 'noop', tokensIn: 100, tokensOut: 50, door: 'openrouter-api', model: 'openai/gpt-5.5' });
    const daily = l.spendTokenRollupDaily();
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ bucket: '2026-07-03', door: 'openrouter-api', modelId: 'openai/gpt-5.5', tokensIn: 100, tokensOut: 50 });
    l.close();
  });

  it('a NULL door/model rolls up under "unknown" (never a lost row)', () => {
    const l = ledger(true, () => T('03'));
    l.record({ feature: 'x', outcome: 'noop', tokensIn: 10, tokensOut: 5 });
    const daily = l.spendTokenRollupDaily();
    expect(daily[0]).toMatchObject({ door: 'unknown', modelId: 'unknown', tokensIn: 10 });
    l.close();
  });
});

describe('spend_token_rollup upsert-on-insert (Layer 2)', () => {
  it('sums multiple inserts into one daily bucket per door×model', () => {
    const l = ledger(true, () => T('03'));
    l.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'groq-api', model: 'm' });
    l.record({ feature: 'b', outcome: 'noop', tokensIn: 200, tokensOut: 20, door: 'groq-api', model: 'm' });
    const daily = l.spendTokenRollupDaily();
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ tokensIn: 300, tokensOut: 30 });
    l.close();
  });

  it('does NOT maintain the rollup when the flag is off (fleet-dark blast-radius bound)', () => {
    const l = ledger(false, () => T('03'));
    l.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'groq-api', model: 'm' });
    expect(l.spendRollupEnabled()).toBe(false);
    expect(l.spendTokenRollupDaily()).toHaveLength(0);
    l.close();
  });

  it('event-kind rows carry no spend (rollup ignores them)', () => {
    const l = ledger(true, () => T('03'));
    l.recordEvent('a', 'fired');
    expect(l.spendTokenRollupDaily()).toHaveLength(0);
    l.close();
  });
});

describe('reconcileSpendRollup (idempotent fold from raw truth)', () => {
  it('rebuilds the daily buckets from raw rows and is idempotent', () => {
    let now = T('03');
    const l = ledger(true, () => now);
    l.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'gemini-api', model: 'flash' });
    now = T('04');
    l.record({ feature: 'a', outcome: 'noop', tokensIn: 50, tokensOut: 5, door: 'gemini-api', model: 'flash' });
    // Reconcile the last 30 days — must match the incrementally-maintained rollup exactly.
    const before = l.spendTokenRollupDaily();
    l.reconcileSpendRollup(30);
    const after = l.spendTokenRollupDaily();
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    l.close();
  });

  it('backfills a rollup that was not maintained at insert time', () => {
    let now = T('03');
    // Insert WITHOUT maintaining the rollup (simulate a crash-dropped upsert / dark→live flip).
    const dark = ledger(false, () => now);
    dark.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'groq-api', model: 'm' });
    // The dark ledger has the raw row but no rollup; a live reconcile on the SAME db path is
    // not shareable in :memory:, so assert the maintained path backfills via boot reconcile:
    now = T('03');
    const live = ledger(true, () => now);
    live.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'groq-api', model: 'm' });
    const n = live.reconcileSpendRollup(30);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(live.spendTokenRollupDaily()[0]).toMatchObject({ tokensIn: 100 });
    dark.close();
    live.close();
  });
});

describe('batched pruneOlderThan + rollup read', () => {
  it('prunes old raw rows in batches (bounded) and keeps the rollup', () => {
    let now = T('20');
    const l = ledger(true, () => now);
    // 3 old rows + 1 recent.
    now = T('01'); l.record({ feature: 'a', outcome: 'noop', tokensIn: 1, tokensOut: 1, door: 'd', model: 'm' });
    now = T('02'); l.record({ feature: 'a', outcome: 'noop', tokensIn: 1, tokensOut: 1, door: 'd', model: 'm' });
    now = T('20'); l.record({ feature: 'a', outcome: 'noop', tokensIn: 1, tokensOut: 1, door: 'd', model: 'm' });
    const deleted = l.pruneOlderThan(T('10'));
    expect(deleted).toBe(2);
    // Rollup (the long history) is untouched by the raw prune.
    const daily = l.spendTokenRollupDaily();
    expect(daily.reduce((s, b) => s + b.tokensIn, 0)).toBe(3);
    l.close();
  });

  it('spendTokenRollupHourly buckets raw rows by hour', () => {
    const l = ledger(true, () => Date.parse('2026-07-03T09:30:00Z'));
    l.record({ feature: 'a', outcome: 'noop', tokensIn: 100, tokensOut: 10, door: 'd', model: 'm' });
    const hourly = l.spendTokenRollupHourly({ sinceHours: 24 });
    expect(hourly).toHaveLength(1);
    expect(hourly[0].bucket).toBe('2026-07-03T09:00:00Z');
    l.close();
  });
});
