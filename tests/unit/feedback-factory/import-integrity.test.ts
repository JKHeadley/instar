/**
 * Unit tests (Tier 1) — integrity-safe import core (spec §2.4).
 *
 * The Phase-2/4 gate: per-row curated-field checksums match (in vs out) + pre-import
 * fingerprint-uniqueness resolved + schema-equivalence holds + FK referential integrity +
 * a sequence reset that prevents a post-cutover P2002. Both sides of every check covered.
 */

import { describe, it, expect } from 'vitest';
import {
  clusterChecksum,
  feedbackChecksum,
  curatedChecksum,
  verifyImportChecksums,
  scanFingerprintUniqueness,
  assertSchemaEquivalence,
  checkReferentialIntegrity,
  planSequenceReset,
  runIntegrityGate,
  type SchemaDescriptor,
} from '../../../src/feedback-factory/migration/importIntegrity.js';
import type { Cluster, FeedbackItem } from '../../../src/feedback-factory/processor/types.js';

const cl = (over: Partial<Cluster>): Cluster => ({ clusterId: 'c1', title: 't', description: 'd', ...over });
const fb = (over: Partial<FeedbackItem>): FeedbackItem => ({ feedbackId: 'f1', title: 't', description: 'd', type: 'bug', ...over });

describe('curatedChecksum / clusterChecksum', () => {
  it('is deterministic — same row hashes equal across calls', () => {
    const c = cl({ status: 'triaged', fingerprint: 'fp', recurrenceCount: 2 });
    expect(clusterChecksum(c)).toBe(clusterChecksum({ ...c }));
  });
  it('changes when ANY curated field changes', () => {
    const base = cl({ status: 'open', recurrenceCount: 1, actionTaken: 'x' });
    expect(clusterChecksum(base)).not.toBe(clusterChecksum(cl({ status: 'resolved', recurrenceCount: 1, actionTaken: 'x' })));
    expect(clusterChecksum(base)).not.toBe(clusterChecksum(cl({ status: 'open', recurrenceCount: 2, actionTaken: 'x' })));
    expect(clusterChecksum(base)).not.toBe(clusterChecksum(cl({ status: 'open', recurrenceCount: 1, actionTaken: 'y' })));
  });
  it('treats null, undefined, and "" as identical (no flap on null-vs-empty)', () => {
    expect(clusterChecksum(cl({ governanceNotes: null as unknown as string }))).toBe(clusterChecksum(cl({ governanceNotes: '' })));
    expect(clusterChecksum(cl({ governanceNotes: undefined }))).toBe(clusterChecksum(cl({})));
  });
  it('has no cross-field run ambiguity (separator-protected)', () => {
    // Without separators, ("ab","c") and ("a","bc") could collide. They must not.
    expect(curatedChecksum({ x: 'ab', y: 'c' }, ['x', 'y'])).not.toBe(curatedChecksum({ x: 'a', y: 'bc' }, ['x', 'y']));
  });
  it('feedbackChecksum distinguishes curated feedback fields', () => {
    expect(feedbackChecksum(fb({ status: 'unprocessed' }))).not.toBe(feedbackChecksum(fb({ status: 'processing' })));
  });
});

describe('verifyImportChecksums', () => {
  const src = { clusters: [cl({ clusterId: 'a', status: 'open' })], feedback: [fb({ feedbackId: 'x' })] };
  it('clean when target is identical', () => {
    expect(verifyImportChecksums(src, { clusters: [cl({ clusterId: 'a', status: 'open' })], feedback: [fb({ feedbackId: 'x' })] })).toEqual([]);
  });
  it('flags missing-in-target', () => {
    const m = verifyImportChecksums(src, { clusters: [], feedback: [fb({ feedbackId: 'x' })] });
    expect(m).toEqual([expect.objectContaining({ id: 'a', kind: 'cluster', reason: 'missing-in-target' })]);
  });
  it('flags extra-in-target', () => {
    const m = verifyImportChecksums(src, { clusters: [cl({ clusterId: 'a', status: 'open' }), cl({ clusterId: 'b' })], feedback: [fb({ feedbackId: 'x' })] });
    expect(m).toEqual([expect.objectContaining({ id: 'b', reason: 'extra-in-target' })]);
  });
  it('flags checksum-differs (silent field corruption)', () => {
    const m = verifyImportChecksums(src, { clusters: [cl({ clusterId: 'a', status: 'CORRUPTED' })], feedback: [fb({ feedbackId: 'x' })] });
    expect(m).toEqual([expect.objectContaining({ id: 'a', reason: 'checksum-differs' })]);
  });
});

describe('scanFingerprintUniqueness', () => {
  it('detects two clusters sharing a fingerprint', () => {
    const dup = scanFingerprintUniqueness([cl({ clusterId: 'a', fingerprint: 'fp' }), cl({ clusterId: 'b', fingerprint: 'fp' })]);
    expect(dup).toEqual([{ fingerprint: 'fp', clusterIds: ['a', 'b'] }]);
  });
  it('clean when all fingerprints unique; ignores missing fingerprints', () => {
    expect(scanFingerprintUniqueness([cl({ clusterId: 'a', fingerprint: 'fp1' }), cl({ clusterId: 'b', fingerprint: 'fp2' }), cl({ clusterId: 'c' })])).toEqual([]);
  });
});

describe('assertSchemaEquivalence', () => {
  const target: SchemaDescriptor = { statusValues: ['open', 'triaged', 'resolved'], fieldTypes: { status: 'string', recurrenceCount: 'number' } };
  it('clean when source ⊆ target', () => {
    expect(assertSchemaEquivalence({ statusValues: ['open', 'resolved'], fieldTypes: { status: 'string' } }, target)).toEqual([]);
  });
  it('flags a status value the target does not accept', () => {
    const d = assertSchemaEquivalence({ statusValues: ['open', 'wontfix'], fieldTypes: {} }, target);
    expect(d).toEqual([expect.objectContaining({ field: 'status', kind: 'unknown-status-value' })]);
  });
  it('flags a type mismatch and a missing field', () => {
    const d = assertSchemaEquivalence({ statusValues: [], fieldTypes: { recurrenceCount: 'string', extra: 'string' } }, target);
    expect(d).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'recurrenceCount', kind: 'type-mismatch' }),
      expect.objectContaining({ field: 'extra', kind: 'missing-field' }),
    ]));
  });
});

describe('checkReferentialIntegrity', () => {
  it('flags a feedback row pointing at a non-existent cluster', () => {
    const d = checkReferentialIntegrity([cl({ clusterId: 'a' })], [fb({ feedbackId: 'x', clusterId: 'GHOST' } as Partial<FeedbackItem>)]);
    expect(d).toEqual([{ feedbackId: 'x', clusterId: 'GHOST' }]);
  });
  it('clean when every link resolves (and ignores unlinked feedback)', () => {
    expect(checkReferentialIntegrity([cl({ clusterId: 'a' })], [fb({ feedbackId: 'x', clusterId: 'a' } as Partial<FeedbackItem>), fb({ feedbackId: 'y' })])).toEqual([]);
  });
});

describe('planSequenceReset', () => {
  it('returns maxNumericId + 1', () => {
    expect(planSequenceReset([1, 7, 3])).toBe(8);
    expect(planSequenceReset(['10', '2'])).toBe(11);
  });
  it('returns 1 for no numeric ids (cuid/uuid PKs need no reset)', () => {
    expect(planSequenceReset(['abc', 'def'])).toBe(1);
    expect(planSequenceReset([])).toBe(1);
  });
});

describe('runIntegrityGate', () => {
  const schema: SchemaDescriptor = { statusValues: ['open', 'resolved'], fieldTypes: { status: 'string' } };
  const cleanSrc = { clusters: [cl({ clusterId: 'a', fingerprint: 'fp1', status: 'open' })], feedback: [fb({ feedbackId: 'x', clusterId: 'a' } as Partial<FeedbackItem>)], schema };
  const cleanTgt = { clusters: [cl({ clusterId: 'a', fingerprint: 'fp1', status: 'open' })], feedback: [fb({ feedbackId: 'x', clusterId: 'a' } as Partial<FeedbackItem>)], schema };

  it('passes when every check is clean', () => {
    const r = runIntegrityGate(cleanSrc, cleanTgt);
    expect(r.passed).toBe(true);
    expect(r.sequenceResetTo).toBe(1); // non-numeric ids
  });
  it('fails on a checksum mismatch', () => {
    const r = runIntegrityGate(cleanSrc, { ...cleanTgt, clusters: [cl({ clusterId: 'a', fingerprint: 'fp1', status: 'TAMPERED' })] });
    expect(r.passed).toBe(false);
    expect(r.checksumMismatches.length).toBeGreaterThan(0);
  });
  it('fails on a source fingerprint collision', () => {
    const r = runIntegrityGate({ ...cleanSrc, clusters: [cl({ clusterId: 'a', fingerprint: 'fp' }), cl({ clusterId: 'b', fingerprint: 'fp' })] }, cleanTgt);
    expect(r.passed).toBe(false);
    expect(r.fingerprintCollisions.length).toBe(1);
  });
});
