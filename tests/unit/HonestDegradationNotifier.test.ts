/**
 * Tier-1 tests for §5.4 honest degradation (spec: cross-machine-account-quota-
 * sharing.md §5.4, D9): single per-topic notice, coalescing within the window, and
 * cross-topic aggregation (≥3 topics → ONE pool-level notice).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HonestDegradationNotifier,
  DEFAULT_HONEST_DEGRADATION_POLICY,
  resolveHonestDegradationPolicy,
  degradationScopeKey,
} from '../../src/core/HonestDegradationNotifier.js';

const reqTg = (chatId: string) => ({ platform: 'telegram' as const, chatId });

function makeNotifier(opts: { dryRun?: boolean; threshold?: number; sameOperator?: boolean } = {}) {
  const perTopic = vi.fn();
  const aggregated = vi.fn();
  let now = 1_000_000;
  const notifier = new HonestDegradationNotifier({
    policy: { ...DEFAULT_HONEST_DEGRADATION_POLICY, aggregateThreshold: opts.threshold ?? 3 },
    isDryRun: () => opts.dryRun ?? false,
    sendPerTopicNotice: perTopic,
    sendAggregatedNotice: aggregated,
    // All topics share ONE operator + platform/channel so they aggregate together.
    resolveOperatorUid: () => (opts.sameOperator === false ? null : 'op-1'),
    audit: vi.fn(),
    now: () => now,
  });
  return { notifier, perTopic, aggregated, setNow: (n: number) => { now = n; } };
}

describe('degradationScopeKey', () => {
  it('scopes per operator + platform + channel', () => {
    expect(degradationScopeKey('op-1', reqTg('100'))).toBe('op-1::telegram::100');
  });
  it('falls back to unknown-operator when no uid', () => {
    expect(degradationScopeKey(null, reqTg('100'))).toBe('unknown-operator::telegram::100');
  });
});

describe('HonestDegradationNotifier', () => {
  it('first walled episode ⇒ ONE per-topic notice', async () => {
    const { notifier, perTopic } = makeNotifier();
    const d = await notifier.notify('T1', reqTg('100'));
    expect(d.send).toBe('per-topic');
    expect(perTopic).toHaveBeenCalledTimes(1);
  });

  it('repeat walled inbound on the SAME topic within window ⇒ coalesced (no second notice)', async () => {
    const { notifier, perTopic } = makeNotifier();
    await notifier.notify('T1', reqTg('100'));
    const d2 = await notifier.notify('T1', reqTg('100'));
    expect(d2.send).toBe('none');
    expect(perTopic).toHaveBeenCalledTimes(1);
  });

  it('D9 aggregation: ≥3 topics in window (same scope) ⇒ ONE pool-level notice, not 3', async () => {
    const { notifier, perTopic, aggregated } = makeNotifier({ threshold: 3 });
    // Distinct topics but SAME operator+platform — but distinct chatIds would split the
    // scope; use the SAME chatId so they share the scope key (one busy channel).
    await notifier.notify('T1', reqTg('100'));
    await notifier.notify('T2', reqTg('100'));
    const d3 = await notifier.notify('T3', reqTg('100'));
    expect(d3.send).toBe('aggregated');
    expect(aggregated).toHaveBeenCalledTimes(1);
    expect(aggregated).toHaveBeenCalledWith(expect.any(String), ['T1', 'T2', 'T3'], reqTg('100'));
    // The first two were per-topic; the third collapsed to aggregated.
    expect(perTopic).toHaveBeenCalledTimes(2);
  });

  it('after aggregation: a 4th topic in the same window+scope coalesces silently', async () => {
    const { notifier, aggregated } = makeNotifier({ threshold: 3 });
    await notifier.notify('T1', reqTg('100'));
    await notifier.notify('T2', reqTg('100'));
    await notifier.notify('T3', reqTg('100')); // aggregated
    const d4 = await notifier.notify('T4', reqTg('100'));
    expect(d4.send).toBe('none');
    expect(aggregated).toHaveBeenCalledTimes(1);
  });

  it('dry-run: decides + audits but sends nothing', async () => {
    const { notifier, perTopic } = makeNotifier({ dryRun: true });
    const d = await notifier.notify('T1', reqTg('100'));
    expect(d.send).toBe('per-topic');
    expect(perTopic).not.toHaveBeenCalled();
  });

  it('recovery closes the episode → a future wall re-notifies', async () => {
    const { notifier, perTopic } = makeNotifier();
    await notifier.notify('T1', reqTg('100'));
    notifier.closeEpisodeOnRecovery('T1');
    const d2 = await notifier.notify('T1', reqTg('100'));
    expect(d2.send).toBe('per-topic');
    expect(perTopic).toHaveBeenCalledTimes(2);
  });
});

describe('resolveHonestDegradationPolicy', () => {
  it('defaults when absent', () => {
    expect(resolveHonestDegradationPolicy(undefined)).toEqual(DEFAULT_HONEST_DEGRADATION_POLICY);
  });
  it('threshold floored at 2', () => {
    expect(resolveHonestDegradationPolicy({ degradationAggregateThreshold: 1 }).aggregateThreshold).toBe(2);
  });
});
