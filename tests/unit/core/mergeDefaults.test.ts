// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Unit tests for mergeDefaults / resolveTimerMs — the helpers that stop an
 * `undefined` config value from erasing a default (the 2026-09-21
 * ContextWedgeSentinel 1ms-loop incident).
 */

import { describe, it, expect } from 'vitest';
import { mergeDefaults, resolveTimerMs } from '../../../src/core/mergeDefaults.js';

describe('mergeDefaults', () => {
  const DEFAULTS = { enabled: true, tickIntervalMs: 20_000, label: 'x', list: [1] as number[] };

  it('behaves like spread for defined values', () => {
    expect(mergeDefaults(DEFAULTS, { tickIntervalMs: 5_000, label: 'y' }))
      .toEqual({ ...DEFAULTS, tickIntervalMs: 5_000, label: 'y' });
  });

  it('an explicit undefined does NOT erase the default (the spread bug)', () => {
    const cfg = { tickIntervalMs: undefined, enabled: undefined };
    // Documents the hazard it replaces:
    expect({ ...DEFAULTS, ...cfg }.tickIntervalMs).toBeUndefined();
    expect(mergeDefaults(DEFAULTS, cfg)).toEqual(DEFAULTS);
  });

  it('null is an explicit value and IS applied (JSON config uses null meaningfully)', () => {
    const merged = mergeDefaults<{ window: string | null }>({ window: '14d' }, { window: null });
    expect(merged.window).toBeNull();
  });

  it('false and 0 are real values and are applied', () => {
    expect(mergeDefaults(DEFAULTS, { enabled: false, tickIntervalMs: 0 }))
      .toMatchObject({ enabled: false, tickIntervalMs: 0 });
  });

  it('ignores a null/undefined override object', () => {
    expect(mergeDefaults(DEFAULTS, undefined)).toEqual(DEFAULTS);
    expect(mergeDefaults(DEFAULTS, null)).toEqual(DEFAULTS);
    expect(mergeDefaults(DEFAULTS)).toEqual(DEFAULTS);
  });

  it('applies several overrides left to right, each skipping its own undefineds', () => {
    expect(mergeDefaults(DEFAULTS, { label: 'a', tickIntervalMs: 1 }, { label: undefined, tickIntervalMs: 2 }))
      .toMatchObject({ label: 'a', tickIntervalMs: 2 });
  });

  it('never mutates the defaults object', () => {
    const d = { a: 1, b: 2 };
    mergeDefaults(d, { a: 9 });
    expect(d).toEqual({ a: 1, b: 2 });
  });

  it('a "__proto__" key from JSON stays an own property, exactly like spread (no prototype change)', () => {
    const override = JSON.parse('{"__proto__": {"polluted": true}, "a": 2}') as Record<string, unknown>;
    const viaSpread = { ...{ a: 1 }, ...override } as Record<string, unknown>;
    const viaHelper = mergeDefaults<Record<string, unknown>>({ a: 1 }, override);
    expect(Object.getPrototypeOf(viaHelper)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(viaHelper)).toBe(Object.getPrototypeOf(viaSpread));
    expect((viaHelper as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(viaHelper, '__proto__')).toBe(true);
    expect(viaHelper.a).toBe(2);
  });

  it('is shallow, like the spread it replaces (nested objects replaced wholesale)', () => {
    const merged = mergeDefaults({ nested: { a: 1, b: 2 } }, { nested: { a: 5 } as { a: number; b: number } });
    expect(merged.nested).toEqual({ a: 5 });
  });
});

describe('resolveTimerMs', () => {
  it('returns the fallback for anything that is not a finite number', () => {
    for (const v of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '20000', {}]) {
      expect(resolveTimerMs(v, 20_000, 1_000)).toBe(20_000);
    }
  });

  it('floors a finite value below the floor', () => {
    expect(resolveTimerMs(0, 20_000, 1_000)).toBe(1_000);
    expect(resolveTimerMs(-5, 20_000, 1_000)).toBe(1_000);
    expect(resolveTimerMs(999, 20_000, 1_000)).toBe(1_000);
  });

  it('passes a valid value through unchanged', () => {
    expect(resolveTimerMs(30_000, 20_000, 1_000)).toBe(30_000);
    expect(resolveTimerMs(20, 45_000)).toBe(20); // default floor 0 — one-shot delays
  });
});
