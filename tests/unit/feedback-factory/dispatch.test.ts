/**
 * Unit tests (Tier 1) — dispatch (guidance-out) logic.
 *
 * Reference is TypeScript, so equivalence is by faithful transcription +
 * exhaustive both-sides-of-boundary tests (no cross-runtime parity harness).
 */

import { describe, it, expect } from 'vitest';
import {
  isValidDispatchType, isValidDispatchPriority, parseVersion, isVersionGte, isVersionLte,
  filterDispatchesForVersion, normalizeDispatchTitle, type DispatchRecord,
} from '../../../src/feedback-factory/dispatch/dispatch.js';

describe('vocab', () => {
  it('validates types and priorities', () => {
    expect(isValidDispatchType('strategy')).toBe(true);
    expect(isValidDispatchType('bug')).toBe(false);
    expect(isValidDispatchPriority('critical')).toBe(true);
    expect(isValidDispatchPriority('urgent')).toBe(false);
  });
});

describe('parseVersion', () => {
  it('extracts major.minor.patch, ignoring prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('10.20.30-beta.2')).toEqual([10, 20, 30]);
  });
  it('returns [0,0,0] for unparseable input', () => {
    expect(parseVersion('garbage')).toEqual([0, 0, 0]);
    expect(parseVersion('1.2')).toEqual([0, 0, 0]);
  });
});

describe('isVersionGte / isVersionLte (equal counts as both)', () => {
  it('handles equal / greater / lesser across components', () => {
    expect(isVersionGte('1.2.3', '1.2.3')).toBe(true);
    expect(isVersionGte('1.3.0', '1.2.9')).toBe(true);
    expect(isVersionGte('1.2.2', '1.2.3')).toBe(false);
    expect(isVersionGte('2.0.0', '1.9.9')).toBe(true);

    expect(isVersionLte('1.2.3', '1.2.3')).toBe(true);
    expect(isVersionLte('1.2.3', '1.3.0')).toBe(true);
    expect(isVersionLte('1.3.0', '1.2.9')).toBe(false);
    expect(isVersionLte('1.9.9', '2.0.0')).toBe(true);
  });
});

describe('filterDispatchesForVersion', () => {
  const ds: DispatchRecord[] = [
    { dispatchId: 'd-none', type: 'lesson', title: 'no bounds' },
    { dispatchId: 'd-min', type: 'lesson', title: 'min 1.3.0', minVersion: '1.3.0' },
    { dispatchId: 'd-max', type: 'lesson', title: 'max 1.2.0', maxVersion: '1.2.0' },
    { dispatchId: 'd-window', type: 'lesson', title: '1.1.0–1.4.0', minVersion: '1.1.0', maxVersion: '1.4.0' },
  ];
  it('includes unbounded dispatches always', () => {
    expect(filterDispatchesForVersion(ds, '1.2.5').map(d => d.dispatchId)).toContain('d-none');
  });
  it('respects minVersion (boundary inclusive)', () => {
    expect(filterDispatchesForVersion(ds, '1.3.0').map(d => d.dispatchId)).toContain('d-min');
    expect(filterDispatchesForVersion(ds, '1.2.9').map(d => d.dispatchId)).not.toContain('d-min');
  });
  it('respects maxVersion (boundary inclusive)', () => {
    expect(filterDispatchesForVersion(ds, '1.2.0').map(d => d.dispatchId)).toContain('d-max');
    expect(filterDispatchesForVersion(ds, '1.2.1').map(d => d.dispatchId)).not.toContain('d-max');
  });
  it('respects a both-bounds window', () => {
    expect(filterDispatchesForVersion(ds, '1.2.0').map(d => d.dispatchId)).toContain('d-window');
    expect(filterDispatchesForVersion(ds, '1.0.9').map(d => d.dispatchId)).not.toContain('d-window');
    expect(filterDispatchesForVersion(ds, '1.4.1').map(d => d.dispatchId)).not.toContain('d-window');
  });
});

describe('normalizeDispatchTitle', () => {
  it('trims and caps at 500 chars', () => {
    expect(normalizeDispatchTitle('  hi  ')).toBe('hi');
    expect(normalizeDispatchTitle('x'.repeat(600)).length).toBe(500);
  });
});
