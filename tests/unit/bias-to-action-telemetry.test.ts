/**
 * Unit tests — Bias-to-Action observe-only telemetry (BIAS-TO-ACTION-SPEC D8).
 * Proves the would-fire record is produced ONLY in the live-clause case
 * (asking AND present) and NEVER leaks the raw operator uid or grant quote.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBiasToActionWouldFire,
  hashOperatorUid,
} from '../../src/core/bias-to-action-telemetry.js';

const FIXED_NOW = () => Date.parse('2026-06-29T12:00:00.000Z');

describe('buildBiasToActionWouldFire', () => {
  it('produces a record when asking AND present', () => {
    const rec = buildBiasToActionWouldFire(
      {
        topicId: 42,
        asking: true,
        present: true,
        source: 'verified-operator-directive',
        askPhrase: 'can I go ahead',
        operatorUid: 7812716706,
        grantedAt: 1700000000000,
      },
      FIXED_NOW,
    );
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe('bias-to-action-would-fire');
    expect(rec!.topicId).toBe(42);
    expect(rec!.source).toBe('verified-operator-directive');
    expect(rec!.askPhrase).toBe('can I go ahead');
    expect(rec!.grantedAt).toBe(1700000000000);
    expect(rec!.t).toBe('2026-06-29T12:00:00.000Z');
  });

  it('returns null when NOT asking (nothing to record)', () => {
    expect(
      buildBiasToActionWouldFire({ topicId: 1, asking: false, present: true, operatorUid: 1 }, FIXED_NOW),
    ).toBeNull();
  });

  it('returns null when NO grant present', () => {
    expect(
      buildBiasToActionWouldFire({ topicId: 1, asking: true, present: false, operatorUid: 1 }, FIXED_NOW),
    ).toBeNull();
  });

  it('NEVER emits the raw operator uid — only a 12-hex hash', () => {
    const uid = 7812716706;
    const rec = buildBiasToActionWouldFire(
      { topicId: 5, asking: true, present: true, operatorUid: uid, askPhrase: 'x' },
      FIXED_NOW,
    )!;
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain(String(uid));
    expect(rec.operatorUidHash).toMatch(/^[0-9a-f]{12}$/);
    expect(rec.operatorUidHash).toBe(hashOperatorUid(uid));
  });

  it('hash is stable and uid-distinct', () => {
    expect(hashOperatorUid(1)).toBe(hashOperatorUid('1')); // String() normalizes
    expect(hashOperatorUid(1)).not.toBe(hashOperatorUid(2));
  });

  it('defaults source to verified-operator-directive and askPhrase/grantedAt to null', () => {
    const rec = buildBiasToActionWouldFire(
      { topicId: 9, asking: true, present: true, operatorUid: 1 },
      FIXED_NOW,
    )!;
    expect(rec.source).toBe('verified-operator-directive');
    expect(rec.askPhrase).toBeNull();
    expect(rec.grantedAt).toBeNull();
  });
});
