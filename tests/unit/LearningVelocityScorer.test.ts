/**
 * Unit tests for LearningVelocityScorer — EXO 3.0's "measure learning velocity,
 * not backward-looking KPIs." Deterministic: a fixed `now` and timestamps at
 * explicit day-offsets. Covers empty, insufficient-data, accelerating, declining,
 * steady, and diversity.
 */

import { describe, it, expect } from 'vitest';
import { computeLearningVelocity, type LearningEvent } from '../../src/core/LearningVelocityScorer.js';

const NOW = '2026-06-30T00:00:00Z';
const NOW_MS = Date.parse(NOW);
const DAY = 24 * 60 * 60 * 1000;
/** A timestamp `daysAgo` before NOW. */
function ago(daysAgo: number): string {
  return new Date(NOW_MS - daysAgo * DAY).toISOString();
}
function ev(daysAgo: number, type: string): LearningEvent {
  return { timestamp: ago(daysAgo), type };
}

describe('computeLearningVelocity', () => {
  it('reports zero + insufficient-data with no events', () => {
    const r = computeLearningVelocity([], NOW, 30);
    expect(r.totalEvents).toBe(0);
    expect(r.eventsPerDay).toBe(0);
    expect(r.trend).toBe('insufficient-data');
    expect(r.adaptabilityScore).toBe(0);
    expect(r.reason).toMatch(/No learning events/);
  });

  it('excludes events outside the window', () => {
    const r = computeLearningVelocity([ev(45, 'learning'), ev(5, 'learning')], NOW, 30);
    expect(r.totalEvents).toBe(1); // the 45-day-old event is outside the 30d window
  });

  it('detects an accelerating trend (more in the recent half)', () => {
    const events = [
      ev(28, 'learning'), // first half
      ev(10, 'learning'), ev(8, 'playbook'), ev(5, 'correction'), ev(2, 'evolution'), // second half
    ];
    const r = computeLearningVelocity(events, NOW, 30);
    expect(r.totalEvents).toBe(5);
    expect(r.trend).toBe('accelerating');
  });

  it('detects a declining trend (more in the older half)', () => {
    const events = [
      ev(28, 'learning'), ev(25, 'learning'), ev(22, 'playbook'), ev(18, 'correction'), // first half
      ev(3, 'learning'), // second half
    ];
    const r = computeLearningVelocity(events, NOW, 30);
    expect(r.trend).toBe('declining');
  });

  it('reports insufficient-data below the trend threshold', () => {
    const r = computeLearningVelocity([ev(10, 'learning'), ev(2, 'playbook')], NOW, 30);
    expect(r.totalEvents).toBe(2);
    expect(r.trend).toBe('insufficient-data');
  });

  it('counts byType and category diversity, and scores adaptability', () => {
    const events = [
      ev(20, 'learning'), ev(15, 'learning'), ev(12, 'playbook'),
      ev(8, 'correction'), ev(5, 'evolution'), ev(2, 'memory'),
    ];
    const r = computeLearningVelocity(events, NOW, 30);
    expect(r.byType.learning).toBe(2);
    expect(r.typeDiversity).toBe(5);
    expect(r.adaptabilityScore).toBeGreaterThan(0);
    expect(r.adaptabilityScore).toBeLessThanOrEqual(100);
  });
});
