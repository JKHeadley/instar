/**
 * Unit tests for config-overridable decay profiles (cwa-decay-profile-config).
 * The per-kind decay horizons (rung 1) are code defaults that an operator may
 * override via config; overrides are existence-checked and validated.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  configureDecayProfiles,
  resetDecayProfiles,
  decayProfileFor,
  projectConfidence,
  buildEvent,
} from '../../src/core/TopicIntent.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => resetDecayProfiles());

describe('configureDecayProfiles', () => {
  it('defaults are in effect with no overrides', () => {
    configureDecayProfiles(undefined);
    expect(decayProfileFor('method')).toEqual({ graceDays: 1, halfLifeDays: 7 });
    expect(decayProfileFor('fact')).toEqual({ graceDays: 30, halfLifeDays: 180 });
  });

  it('overrides only the specified kind+field; everything else keeps the default', () => {
    configureDecayProfiles({ method: { halfLifeDays: 21 } });
    expect(decayProfileFor('method')).toEqual({ graceDays: 1, halfLifeDays: 21 }); // grace unchanged
    expect(decayProfileFor('goal')).toEqual({ graceDays: 2, halfLifeDays: 14 });   // untouched kind
    expect(decayProfileFor('fact')).toEqual({ graceDays: 30, halfLifeDays: 180 });
  });

  it('ignores invalid values (non-finite, <= 0) — a bad config never breaks decay', () => {
    configureDecayProfiles({ method: { graceDays: -5, halfLifeDays: 0 }, goal: { halfLifeDays: Infinity } });
    expect(decayProfileFor('method')).toEqual({ graceDays: 1, halfLifeDays: 7 }); // both invalid → default
    expect(decayProfileFor('goal')).toEqual({ graceDays: 2, halfLifeDays: 14 });  // invalid → default
  });

  it('is idempotent — re-deriving from defaults, not compounding', () => {
    configureDecayProfiles({ method: { halfLifeDays: 21 } });
    configureDecayProfiles({ method: { graceDays: 3 } }); // second call: halfLifeDays should revert to default
    expect(decayProfileFor('method')).toEqual({ graceDays: 3, halfLifeDays: 7 });
  });

  it('resetDecayProfiles restores the built-in defaults', () => {
    configureDecayProfiles({ method: { halfLifeDays: 99 } });
    resetDecayProfiles();
    expect(decayProfileFor('method')).toEqual({ graceDays: 1, halfLifeDays: 7 });
  });

  it('the override actually changes projection decay', () => {
    const ev = [buildEvent('r', 'extract-user', 'm1', { at: new Date(T0).toISOString() })]; // +0.40
    const at8 = T0 + 8 * DAY;
    // default method: grace 1, half-life 7 → day 8 ≈ 0.20
    configureDecayProfiles(undefined);
    expect(projectConfidence(ev, new Date(T0).toISOString(), at8, 'method').confidence).toBeCloseTo(0.20, 2);
    // override method to a long horizon → barely decays by day 8
    configureDecayProfiles({ method: { graceDays: 30, halfLifeDays: 180 } });
    expect(projectConfidence(ev, new Date(T0).toISOString(), at8, 'method').confidence).toBeCloseTo(0.40, 2);
  });
});
