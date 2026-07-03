/**
 * Machine-coherence evaluator pure helpers (machine-coherence-guard §3.3) —
 * peer classification (each class's pinned handling, both sides of every
 * boundary) + the N1 canonical skew-row identity and its §3.2 marker hash.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPeer,
  skewRowIdentity,
  rowIdentityHash,
  classifyVersionSkew,
  electRaiser,
} from '../../src/monitoring/machineCoherenceEvaluate.js';
import { MC_ROW_HASH_LEN } from '../../src/core/machineCoherenceManifest.js';

const NOW = 1_751_500_000_000;
const STALE_MS = 300_000; // the shipped advertStaleMs default (5 min)

function advert() {
  return {
    instarVersion: '1.3.729',
    protocolVersion: 1,
    manifestHash: 'd'.repeat(64),
    guard: 'live' as const,
    beatSeq: 1,
    flags: { developmentAgent: 'true' },
  };
}

describe('classifyPeer (§3.3 peer classification)', () => {
  it('classifies a fresh clamp-passed advert as compared (enters all dimensions)', () => {
    const out = classifyPeer(
      { machineId: 'm_b', coherenceAdvert: advert(), coherenceAdvertReceivedAt: new Date(NOW - 10_000).toISOString() },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('compared');
    expect(out.advert).toEqual(advert());
  });

  it('classifies an advert-less online peer as unknown (the peer predates the guard — version-class after grace, M3)', () => {
    const out = classifyPeer({ machineId: 'm_old' }, NOW, STALE_MS);
    expect(out.cls).toBe('unknown');
    expect(out.advert).toBeUndefined();
  });

  it('degrades an advert older than advertStaleMs to advert-stale (M5 — liveness freshness never impersonates advert freshness)', () => {
    const out = classifyPeer(
      { machineId: 'm_b', coherenceAdvert: advert(), coherenceAdvertReceivedAt: new Date(NOW - STALE_MS - 1).toISOString() },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('advert-stale');
    expect(out.advert).toBeUndefined();
  });

  it('an advert EXACTLY at the staleness bound is still compared (boundary pinned: older-than degrades, at-bound does not)', () => {
    const out = classifyPeer(
      { machineId: 'm_b', coherenceAdvert: advert(), coherenceAdvertReceivedAt: new Date(NOW - STALE_MS).toISOString() },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('compared');
  });

  it('classifies a clamp-rejected advert as advert-rejected with its NAMED reason (M4 — rejected ≠ absent, never silence)', () => {
    const out = classifyPeer(
      { machineId: 'm_bad', coherenceAdvertRejected: { atMs: NOW - 5_000, reason: 'flag-value-format' } },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('advert-rejected');
    expect(out.rejectedReason).toBe('flag-value-format');
  });

  it('rejection wins even if an advert somehow co-exists on the capacity (the invariant holds against widened shapes)', () => {
    const out = classifyPeer(
      {
        machineId: 'm_bad',
        coherenceAdvert: advert(),
        coherenceAdvertReceivedAt: new Date(NOW - 1_000).toISOString(),
        coherenceAdvertRejected: { atMs: NOW, reason: 'advert-oversize' },
      },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('advert-rejected');
  });

  it('an unparseable receipt time cannot prove freshness — degrades to advert-stale, never trusts', () => {
    const out = classifyPeer(
      { machineId: 'm_b', coherenceAdvert: advert(), coherenceAdvertReceivedAt: 'not-a-date' },
      NOW,
      STALE_MS,
    );
    expect(out.cls).toBe('advert-stale');
  });
});

describe('skewRowIdentity (N1 canonical row identity)', () => {
  it('is stable under machine enumeration order (sorted machineId=valueClass parts)', () => {
    const a = skewRowIdentity('flag', 'seamlessness.ws13PinReplicate', { m_laptop: 'live', m_mini: 'off' });
    const b = skewRowIdentity('flag', 'seamlessness.ws13PinReplicate', { m_mini: 'off', m_laptop: 'live' });
    expect(a).toBe(b);
    expect(a).toBe('flag|seamlessness.ws13PinReplicate|m_laptop=live,m_mini=off');
  });

  it('keys on machine ids and value classes ONLY — a different value class is a different row', () => {
    const a = skewRowIdentity('flag', 'k', { m_a: 'live', m_b: 'off' });
    const b = skewRowIdentity('flag', 'k', { m_a: 'live', m_b: 'dry-run' });
    expect(a).not.toBe(b);
  });

  it('the dimension is part of the identity — the same key on two dimensions never collides', () => {
    expect(skewRowIdentity('version', 'instarVersion', { m_a: '1-3-729' })).not.toBe(
      skewRowIdentity('protocol', 'instarVersion', { m_a: '1-3-729' }),
    );
  });
});

describe('rowIdentityHash (§3.2 marker hash)', () => {
  it('produces the marker wire format: exactly 16 lowercase hex (MC_ROW_HASH_LEN)', () => {
    const h = rowIdentityHash(skewRowIdentity('flag', 'k', { m_a: 'live', m_b: 'off' }));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toHaveLength(MC_ROW_HASH_LEN);
  });

  it('is deterministic and identity-sensitive (two machines computing the same row agree; different rows differ)', () => {
    const row = skewRowIdentity('flag', 'k', { m_a: 'live', m_b: 'off' });
    expect(rowIdentityHash(row)).toBe(rowIdentityHash(row));
    expect(rowIdentityHash(row)).not.toBe(rowIdentityHash(row + 'x'));
  });
});

describe('classifyVersionSkew (§3.3 version dimension — update-wave honesty)', () => {
  it('identical versions → none', () => {
    expect(classifyVersionSkew('1.3.729', '1.3.729')).toBe('none');
  });
  it('patch-only difference → patch-only (grace-gated: a normal update wave must not cry wolf)', () => {
    expect(classifyVersionSkew('1.3.729', '1.3.730')).toBe('patch-only');
  });
  it('minor difference → major-minor (a real capability split, 2-tick confirm)', () => {
    expect(classifyVersionSkew('1.3.729', '1.4.0')).toBe('major-minor');
  });
  it('major difference → major-minor', () => {
    expect(classifyVersionSkew('1.3.729', '2.0.0')).toBe('major-minor');
  });
  it('an unparseable version that differs takes the QUIETER grace-gated path, never the loud one', () => {
    expect(classifyVersionSkew('1.3.729', 'unknown')).toBe('patch-only');
    expect(classifyVersionSkew('dev-build', 'unknown')).toBe('patch-only');
  });
  it('a prerelease/build suffix on the same major.minor stays patch-only', () => {
    expect(classifyVersionSkew('1.3.729', '1.3.729-rc.1')).toBe('patch-only');
  });
});

describe('electRaiser (§3.4 — deterministic, no coordination)', () => {
  it('the serving-lease holder raises when it is a candidate', () => {
    expect(electRaiser(['m_b', 'm_a'], 'm_b')).toBe('m_b');
  });
  it('falls to the lexicographically smallest candidate when the holder is not a candidate (dry-run/dark holder)', () => {
    expect(electRaiser(['m_c', 'm_b'], 'm_a')).toBe('m_b');
  });
  it('falls to the smallest candidate when there is no lease holder at all', () => {
    expect(electRaiser(['m_c', 'm_b'], null)).toBe('m_b');
  });
  it('zero candidates → null (nobody raises — a pool with no live guard honestly has none)', () => {
    expect(electRaiser([], 'm_a')).toBeNull();
  });
  it('does not mutate the caller candidate list (sort works on a copy)', () => {
    const candidates = ['m_c', 'm_b'];
    electRaiser(candidates, null);
    expect(candidates).toEqual(['m_c', 'm_b']);
  });
  it('every machine computes the SAME result from the same inputs (the shared-inputs property)', () => {
    const inputs: [string[], string | null] = [['m_mini', 'm_laptop'], 'm_ghost'];
    expect(electRaiser(...inputs)).toBe(electRaiser(...inputs));
    expect(electRaiser(...inputs)).toBe('m_laptop');
  });
});
