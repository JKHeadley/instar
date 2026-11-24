import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bindDesignEvidence, designEvidenceMatches } from '../../src/designGate/evidenceBinding.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const identity = () => ({ baseSha: 'a'.repeat(40), mergeTree: 'b'.repeat(40), rendererBuild: hash('renderer'), policyHash: hash('policy') });
const evidence = () => ({ screen: 'accounts', seedVersion: hash('seed'), captures: [Buffer.from('first'), Buffer.from('second')], traces: [Buffer.from('tab order'), Buffer.from('focus after refresh')], rules: [{ id: 'DS-LAYOUT-1', wording: 'Full rule and check wording' }] });
describe('design review evidence binding', () => {
  it('binds the actual capture bytes, traces, seed and rule wording to the verified tree pair', () => {
    const bound = bindDesignEvidence(identity(), evidence());
    expect(designEvidenceMatches(bound, identity(), evidence())).toBe(true);
    const changed = evidence(); changed.captures[0] = Buffer.from('different pixels');
    expect(designEvidenceMatches(bound, identity(), changed)).toBe(false);
    const trace = evidence(); trace.traces[0] = Buffer.from('different focus');
    expect(designEvidenceMatches(bound, identity(), trace)).toBe(false);
    const rule = evidence(); rule.rules[0].wording += ' changed';
    expect(designEvidenceMatches(bound, identity(), rule)).toBe(false);
    expect(designEvidenceMatches(bound, identity(), { ...evidence(), seedVersion: hash('new seed') })).toBe(false);
  });
  it('invalidates a retained decision when main, the merge tree, renderer or policy moves', () => {
    const bound = bindDesignEvidence(identity(), evidence());
    for (const key of ['baseSha', 'mergeTree', 'rendererBuild', 'policyHash'] as const) {
      const current = identity(); current[key] = key.endsWith('Sha') || key === 'mergeTree' ? 'c'.repeat(40) : hash('changed');
      expect(designEvidenceMatches(bound, current, evidence())).toBe(false);
    }
  });
  it('keeps capture order and screen identity significant', () => {
    const bound = bindDesignEvidence(identity(), evidence());
    const reordered = evidence(); reordered.captures.reverse();
    expect(designEvidenceMatches(bound, identity(), reordered)).toBe(false);
    expect(designEvidenceMatches(bound, identity(), { ...evidence(), screen: 'plans' })).toBe(false);
  });
  it('rejects incomplete evidence rather than producing an apparently reusable binding', () => {
    expect(() => bindDesignEvidence({ ...identity(), baseSha: '../main' }, evidence())).toThrow();
    expect(() => bindDesignEvidence(identity(), { ...evidence(), captures: [] })).toThrow();
    expect(() => bindDesignEvidence(identity(), { ...evidence(), traces: [] })).toThrow();
    expect(() => bindDesignEvidence(identity(), { ...evidence(), captures: new Array(2) })).toThrow();
    expect(() => bindDesignEvidence(identity(), { ...evidence(), traces: new Array(2) })).toThrow();
    expect(() => bindDesignEvidence(identity(), { ...evidence(), rules: [evidence().rules[0], evidence().rules[0]] })).toThrow();
    expect(designEvidenceMatches(null, identity(), evidence())).toBe(false);
    expect(designEvidenceMatches({ digest: hash('invented') }, identity(), evidence())).toBe(false);
  });
});
