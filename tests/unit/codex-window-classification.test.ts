import { describe, it, expect } from 'vitest';
import { classifyCodexWindows, CODEX_LONG_WINDOW_MIN_MINUTES } from '../../src/core/QuotaPoller.js';
import type { CodexRateWindow } from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';

const win = (usedPercent: number, windowMinutes: number): CodexRateWindow => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowMinutes,
  resetsAt: 1787196626,
  resetsAtIso: '2026-08-20T03:30:26.000Z',
  resetsInSeconds: 36596,
});

describe('classifyCodexWindows', () => {
  it('routes the conventional shape (primary=5h, secondary=weekly) unchanged', () => {
    const { short, long } = classifyCodexWindows(win(13, 300), win(93, 10080));
    expect(short?.usedPercent).toBe(13);
    expect(long?.usedPercent).toBe(93);
  });

  // THE REGRESSION (live capture, 2026-08-19): a pro account reported the WEEKLY
  // window under `primary` with `secondary: null`. Positional mapping filed 20% of a
  // seven-day allowance as a five-hour figure.
  it('routes a WEEKLY window arriving under `primary` to the long bucket', () => {
    const { short, long } = classifyCodexWindows(win(20, 10080), null);
    expect(short).toBeNull();
    expect(long?.usedPercent).toBe(20);
    expect(long?.windowMinutes).toBe(10080);
  });

  it('routes a 5h window arriving under `secondary` to the short bucket', () => {
    const { short, long } = classifyCodexWindows(null, win(42, 300));
    expect(short?.usedPercent).toBe(42);
    expect(long).toBeNull();
  });

  it('classifies exactly at the boundary as the long window', () => {
    const { short, long } = classifyCodexWindows(win(5, CODEX_LONG_WINDOW_MIN_MINUTES), null);
    expect(short).toBeNull();
    expect(long?.usedPercent).toBe(5);
  });

  it('both short ⇒ the SHORTER window represents the short bucket, deterministically', () => {
    const { short, long } = classifyCodexWindows(win(10, 600), win(70, 300));
    expect(short?.usedPercent).toBe(70);
    expect(short?.windowMinutes).toBe(300);
    expect(long).toBeNull();
  });

  it('both long ⇒ the LONGER window represents the long bucket, deterministically', () => {
    const { short, long } = classifyCodexWindows(win(30, 10080), win(80, 43200));
    expect(short).toBeNull();
    expect(long?.windowMinutes).toBe(43200);
  });

  it('falls back to positional meaning when windowMinutes is unusable', () => {
    const bad = { ...win(11, 300), windowMinutes: 0 as unknown as number };
    const { short, long } = classifyCodexWindows(bad, null);
    expect(short?.usedPercent).toBe(11); // positional: primary ⇒ short
    expect(long).toBeNull();
  });

  it('both absent ⇒ both buckets empty', () => {
    expect(classifyCodexWindows(null, null)).toEqual({ short: null, long: null });
  });
});
