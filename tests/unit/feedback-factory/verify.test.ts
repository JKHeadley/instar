/**
 * Unit tests (Tier 1) — feedback-factory fix verifier (can_transition_to_verified port).
 *
 * Deterministic via injected `now` + `recentReportsSinceFix`. Byte-exact
 * equivalence to the reference is proven by the local parity harness
 * (scripts/feedback-factory/verify-parity.mjs).
 */

import { describe, it, expect } from 'vitest';
import { canTransitionToVerified, pyFormat0f } from '../../../src/feedback-factory/processor/verify.js';
import type { Cluster } from '../../../src/feedback-factory/processor/types.js';

const NOW = '2026-05-27T00:00:00Z';
const base = (extra: Partial<Cluster>): Cluster => ({ clusterId: 'c', title: 't', description: 'd', createdAt: '2026-05-20T00:00:00Z', ...extra });

describe('pyFormat0f (Python :.0f, round-half-to-even)', () => {
  it('rounds to an integer string, half to even', () => {
    expect(pyFormat0f(10)).toBe('10');
    expect(pyFormat0f(10.4)).toBe('10');
    expect(pyFormat0f(10.6)).toBe('11');
    expect(pyFormat0f(10.5)).toBe('10'); // even
    expect(pyFormat0f(11.5)).toBe('12'); // even
  });
});

describe('canTransitionToVerified', () => {
  it('refuses when there is no fix timestamp', () => {
    const r = canTransitionToVerified(base({}), { now: NOW });
    expect(r.allowed).toBe(false);
    expect(r.recommendation).toBe('set_fix_applied_at');
  });

  it('version-anchored: recent reports → revert_to_investigating', () => {
    const r = canTransitionToVerified(
      base({ fixedInVersion: '1.2.3', fingerprint: 'abc', fixAppliedAt: '2026-05-25T18:00:00Z' }),
      { now: NOW, recentReportsSinceFix: [{ instarVersion: '1.2.4' }] },
    );
    expect(r.allowed).toBe(false);
    expect(r.recommendation).toBe('revert_to_investigating');
    expect(r.evidence).toContain('Still seeing 1 reports');
  });

  it('version-anchored: no recent + ≥24h → verified high', () => {
    const r = canTransitionToVerified(
      base({ fixedInVersion: '1.2.3', fingerprint: 'abc', fixAppliedAt: '2026-05-25T18:00:00Z' }),
      { now: NOW, recentReportsSinceFix: [] },
    );
    expect(r.allowed).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.verified_by).toBe('auto:version_check:v1.2.3');
  });

  it('version-anchored under 24h falls through to silence (wait)', () => {
    const r = canTransitionToVerified(
      base({ fixedInVersion: '1.2.3', fingerprint: 'abc', updatedAt: '2026-05-26T00:00:00Z', reportCount: 1, fixAppliedAt: '2026-05-26T14:00:00Z' }),
      { now: NOW, recentReportsSinceFix: [] },
    );
    expect(r.allowed).toBe(false);
    expect(r.recommendation).toBe('wait');
  });

  it('silence-based: quiet long enough → verified low', () => {
    const r = canTransitionToVerified(
      base({ updatedAt: '2026-05-22T00:00:00Z', reportCount: 1, fixAppliedAt: '2026-05-22T20:00:00Z' }),
      { now: NOW },
    );
    expect(r.allowed).toBe(true);
    expect(r.confidence).toBe('low');
    expect(r.verified_by).toBe('auto:silence_check');
  });

  it('uses dispatchedAt when fixAppliedAt is absent', () => {
    const r = canTransitionToVerified(
      base({ updatedAt: '2026-05-22T00:00:00Z', reportCount: 1, dispatchedAt: '2026-05-22T20:00:00Z' }),
      { now: NOW },
    );
    expect(r.allowed).toBe(true); // verified via the dispatchedAt proxy
  });
});
