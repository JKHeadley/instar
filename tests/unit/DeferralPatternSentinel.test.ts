import { describe, expect, it, vi } from 'vitest';
import {
  DEFERRAL_PATTERN_DEDUP_KEY,
  DeferralPatternSentinel,
  buildAttention,
  countRecentDistinctDeferrals,
  guardStatusFor,
  resolveDeferralPatternSentinelConfig,
  type DeferralPatternAttention,
  type DeferralPatternObservation,
  type DeferralPatternSentinelDeps,
} from '../../src/monitoring/DeferralPatternSentinel.js';
import { buildToneDecisionContext, type ToneReviewContext } from '../../src/core/MessagingToneGate.js';

const NOW = Date.parse('2026-07-22T20:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const hash = (n: number): string => n.toString(16).padStart(64, '0');
const positive = (n: number, at = NOW): DeferralPatternObservation => ({
  observedAt: at,
  deferralShapeDetected: true,
  candidateSha256: hash(n),
});

function harness(opts: {
  enabled?: boolean;
  dryRun?: boolean;
  threshold?: number;
  windowMs?: number;
  observations?: DeferralPatternObservation[];
}) {
  const raised: DeferralPatternAttention[] = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: DeferralPatternSentinelDeps = {
    enabled: () => opts.enabled ?? true,
    dryRun: () => opts.dryRun ?? false,
    threshold: () => opts.threshold ?? 3,
    windowMs: () => opts.windowMs ?? 7 * DAY,
    getObservations: () => opts.observations ?? [],
    raiseAttention: (item) => raised.push(item),
    audit: (event, detail) => audits.push({ event, detail }),
  };
  return { sentinel: new DeferralPatternSentinel(deps, () => NOW), raised, audits };
}

describe('DeferralPatternSentinel', () => {
  it('is dark as a strict no-op: it does not read the existing provenance surface', () => {
    const getObservations = vi.fn(() => [positive(1), positive(2), positive(3)]);
    const raiseAttention = vi.fn();
    const sentinel = new DeferralPatternSentinel({
      enabled: () => false,
      dryRun: () => false,
      threshold: () => 3,
      windowMs: () => 7 * DAY,
      getObservations,
      raiseAttention,
    });
    expect(sentinel.tick()).toEqual({
      ran: false, patternDetected: false, distinctDeferrals: 0, raised: false,
    });
    expect(getObservations).not.toHaveBeenCalled();
    expect(raiseAttention).not.toHaveBeenCalled();
  });

  it('does not surface below the threshold (N-1 boundary)', () => {
    const { sentinel, raised, audits } = harness({ observations: [positive(1), positive(2)] });
    expect(sentinel.tick()).toEqual({
      ran: true, patternDetected: false, distinctDeferrals: 2, raised: false,
    });
    expect(raised).toEqual([]);
    expect(audits.at(-1)?.event).toBe('no-pattern');
  });

  it('surfaces exactly at the threshold (N boundary) as ONE stable deduped Attention item', () => {
    const { sentinel, raised } = harness({
      observations: [positive(1), positive(2), positive(3)],
    });
    expect(sentinel.tick()).toEqual({
      ran: true, patternDetected: true, distinctDeferrals: 3, raised: true,
    });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      dedupKey: DEFERRAL_PATTERN_DEDUP_KEY,
      priority: 'high',
      source: 'deferral-pattern-sentinel',
    });
    expect(raised[0].body).toMatch(/pattern signal, not a verdict/i);
  });

  it('consumes the existing tone-provenance recognizer result instead of re-recognizing text', () => {
    const messages = [
      'Can you restart Codey on the laptop for me?',
      "You'll need to install the key on the laptop.",
      'Grant me SSH access and I can take it from there.',
    ];
    const observations = messages.map((message) => {
      const context = buildToneDecisionContext(message, {} as ToneReviewContext);
      const candidate = context.candidate as { sha256: string };
      return {
        observedAt: NOW,
        deferralShapeDetected: context.deferralShapeDetected === true,
        candidateSha256: candidate.sha256,
      };
    });
    const { sentinel, raised } = harness({ observations });
    expect(sentinel.tick().patternDetected).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it('dryRun-first computes and audits would-raise without creating Attention', () => {
    const { sentinel, raised, audits } = harness({
      dryRun: true,
      observations: [positive(1), positive(2), positive(3)],
    });
    expect(sentinel.tick().patternDetected).toBe(true);
    expect(sentinel.tick().raised).toBe(false);
    expect(raised).toEqual([]);
    expect(audits.filter((a) => a.event === 'would-raise')).toHaveLength(2);
    expect(sentinel.status().counters).toEqual({
      ticks: 2, raises: 0, wouldRaise: 2, errors: 0,
    });
  });

  it('deduplicates replayed provenance rows by the existing candidate sha256', () => {
    const { sentinel, raised } = harness({
      observations: [positive(1), positive(1), positive(2), positive(2)],
    });
    expect(sentinel.tick().distinctDeferrals).toBe(2);
    expect(raised).toEqual([]);
  });

  it('fails toward silence when the injected read surface throws', () => {
    const sentinel = new DeferralPatternSentinel({
      enabled: () => true,
      dryRun: () => false,
      threshold: () => 3,
      windowMs: () => 7 * DAY,
      getObservations: () => { throw new Error('provenance unavailable'); },
      raiseAttention: () => { throw new Error('must not raise'); },
    }, () => NOW);
    expect(sentinel.tick()).toEqual({
      ran: true, patternDetected: false, distinctDeferrals: 0, raised: false,
    });
    expect(sentinel.status().counters.errors).toBe(1);
  });

  it('contains a throwing audit sink and still raises the signal', () => {
    const sentinel = new DeferralPatternSentinel({
      enabled: () => true,
      dryRun: () => false,
      threshold: () => 1,
      windowMs: () => DAY,
      getObservations: () => [positive(1)],
      raiseAttention: () => {},
      audit: () => { throw new Error('audit down'); },
    }, () => NOW);
    expect(() => sentinel.tick()).not.toThrow();
    expect(sentinel.status().counters.raises).toBe(1);
  });
});

describe('countRecentDistinctDeferrals boundaries', () => {
  it('includes the exact lower window edge and current instant', () => {
    expect(countRecentDistinctDeferrals(
      [positive(1, NOW - 7 * DAY), positive(2, NOW)],
      NOW,
      7 * DAY,
    )).toBe(2);
  });

  it('excludes one millisecond stale, future, negative, and malformed rows', () => {
    expect(countRecentDistinctDeferrals([
      positive(1, NOW - 7 * DAY - 1),
      positive(2, NOW + 1),
      { ...positive(3), deferralShapeDetected: false },
      { ...positive(4), candidateSha256: 'not-a-hash' },
    ], NOW, 7 * DAY)).toBe(0);
  });
});

describe('config, posture, status, and attention rendering', () => {
  it('is dry-run-first and delegates omitted enabled to the injected dark gate', () => {
    expect(resolveDeferralPatternSentinelConfig(undefined, (explicit) => explicit ?? false))
      .toEqual({ enabled: false, dryRun: true, threshold: 3, windowMs: 7 * DAY });
  });

  it('honors explicit values and normalizes unsafe numeric values to bounded defaults', () => {
    expect(resolveDeferralPatternSentinelConfig(
      { enabled: true, dryRun: false, threshold: 4, windowMs: 2 * DAY },
      (explicit) => explicit ?? false,
    )).toEqual({ enabled: true, dryRun: false, threshold: 4, windowMs: 2 * DAY });
    expect(resolveDeferralPatternSentinelConfig(
      { threshold: 0, windowMs: Number.NaN },
      () => true,
    )).toMatchObject({ threshold: 3, windowMs: 7 * DAY });
  });

  it('grades dark, dry-run, and live postures', () => {
    const base = { threshold: 3, windowMs: 7 * DAY };
    expect(guardStatusFor({ ...base, enabled: false, dryRun: true })).toBe('dark');
    expect(guardStatusFor({ ...base, enabled: true, dryRun: true })).toBe('dry-run');
    expect(guardStatusFor({ ...base, enabled: true, dryRun: false })).toBe('live');
  });

  it('status exposes content-free aggregate state only', () => {
    const { sentinel } = harness({ dryRun: true, observations: [positive(1), positive(2), positive(3)] });
    sentinel.tick();
    expect(sentinel.status()).toMatchObject({
      enabled: true,
      dryRun: true,
      threshold: 3,
      windowMs: 7 * DAY,
      distinctDeferrals: 3,
      patternDetected: true,
      counters: { ticks: 1, raises: 0, wouldRaise: 1, errors: 0 },
    });
    expect(sentinel.status().lastTickAt).toBe('2026-07-22T20:00:00.000Z');
  });

  it('buildAttention uses the same stable dedup key across counts', () => {
    expect(buildAttention(3, 7 * DAY).dedupKey).toBe(buildAttention(9, 7 * DAY).dedupKey);
  });
});
