/**
 * A job failure that cannot decrease is not a health signal.
 *
 * Covers both sides of every boundary in summarizeJobFailures: enabled/disabled,
 * inside/outside the window, parseable/absent timestamps, and the exact production
 * shape that motivated it (a disabled job holding 118 failures from 25 days ago,
 * reported by /health as current).
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeJobFailures,
  JOB_FAILURE_WINDOW_MS,
} from '../../src/server/jobFailureCurrency.js';

const NOW = Date.parse('2026-10-21T16:40:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('summarizeJobFailures', () => {
  it('counts an enabled job that failed inside the window', () => {
    const s = summarizeJobFailures(
      [{ slug: 'a', enabled: true, failures: 3, lastRun: iso(2 * HOUR) }],
      NOW,
    );
    expect(s.current).toBe(3);
    expect(s.stale).toEqual([]);
    expect(s.staleTotal).toBe(0);
  });

  it('EXCLUDES a disabled job, because its count can never come down', () => {
    const s = summarizeJobFailures(
      [{ slug: 'off', enabled: false, failures: 7, lastRun: iso(10 * MINUTE) }],
      NOW,
    );
    expect(s.current).toBe(0);
    expect(s.staleTotal).toBe(7);
    expect(s.stale).toEqual([
      { slug: 'off', failures: 7, lastRun: iso(10 * MINUTE), reason: 'disabled' },
    ]);
  });

  it('EXCLUDES an enabled job whose last run is older than the window', () => {
    const s = summarizeJobFailures(
      [{ slug: 'old', enabled: true, failures: 4, lastRun: iso(JOB_FAILURE_WINDOW_MS + MINUTE) }],
      NOW,
    );
    expect(s.current).toBe(0);
    expect(s.stale[0]).toMatchObject({ slug: 'old', reason: 'stale' });
  });

  it('keeps a job exactly AT the window edge as current (the boundary is >, not >=)', () => {
    const s = summarizeJobFailures(
      [{ slug: 'edge', enabled: true, failures: 2, lastRun: iso(JOB_FAILURE_WINDOW_MS) }],
      NOW,
    );
    expect(s.current).toBe(2);
    expect(s.stale).toEqual([]);
  });

  it('counts a job with NO lastRun as current — failing toward visibility', () => {
    const s = summarizeJobFailures([{ slug: 'never', enabled: true, failures: 5 }], NOW);
    expect(s.current).toBe(5);
    expect(s.stale).toEqual([]);
  });

  it('counts a job with an UNPARSEABLE lastRun as current, so corruption cannot silence it', () => {
    const s = summarizeJobFailures(
      [{ slug: 'broken', enabled: true, failures: 6, lastRun: 'not-a-date' }],
      NOW,
    );
    expect(s.current).toBe(6);
    expect(s.stale).toEqual([]);
  });

  it('treats an absent `enabled` as enabled (the scheduler default)', () => {
    const s = summarizeJobFailures([{ slug: 'implicit', failures: 1, lastRun: iso(MINUTE) }], NOW);
    expect(s.current).toBe(1);
  });

  it('reports a job that is BOTH disabled and stale as disabled — the actionable reason', () => {
    const s = summarizeJobFailures(
      [{ slug: 'both', enabled: false, failures: 9, lastRun: iso(40 * 24 * HOUR) }],
      NOW,
    );
    expect(s.stale[0].reason).toBe('disabled');
  });

  it('ignores jobs with no failures entirely, enabled or not', () => {
    const s = summarizeJobFailures(
      [
        { slug: 'clean', enabled: true, failures: 0, lastRun: iso(MINUTE) },
        { slug: 'off-clean', enabled: false, failures: 0, lastRun: iso(40 * 24 * HOUR) },
        { slug: 'nonsense', enabled: true, failures: Number.NaN, lastRun: iso(MINUTE) },
      ],
      NOW,
    );
    expect(s).toEqual({ current: 0, stale: [], staleTotal: 0 });
  });

  it('caps the stale LIST but still totals every excluded failure', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => ({
      slug: `off-${i}`, enabled: false, failures: i + 1, lastRun: iso(MINUTE),
    }));
    const s = summarizeJobFailures(jobs, NOW, JOB_FAILURE_WINDOW_MS, 5);
    expect(s.stale).toHaveLength(5);
    // Most failures first, so the cap keeps the worst offenders rather than an arbitrary five.
    expect(s.stale.map((j) => j.failures)).toEqual([25, 24, 23, 22, 21]);
    expect(s.staleTotal).toBe((25 * 26) / 2);
  });

  it('the production incident: a healthy agent reports 1, not 119', () => {
    // Read from /health on 2026-10-21: w29-working-set-mirror disabled, 118 failures,
    // last run 2026-09-26; commitment-detection enabled with one recent failure.
    const s = summarizeJobFailures(
      [
        {
          slug: 'w29-working-set-mirror',
          enabled: false,
          failures: 118,
          lastRun: '2026-09-26T07:01:15.227Z',
        },
        {
          slug: 'commitment-detection',
          enabled: true,
          failures: 1,
          lastRun: iso(30 * MINUTE),
        },
      ],
      NOW,
    );
    expect(s.current).toBe(1);
    expect(s.staleTotal).toBe(118);
    expect(s.stale).toEqual([
      {
        slug: 'w29-working-set-mirror',
        failures: 118,
        lastRun: '2026-09-26T07:01:15.227Z',
        reason: 'disabled',
      },
    ]);
  });
});
