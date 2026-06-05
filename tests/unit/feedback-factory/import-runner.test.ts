/**
 * Unit tests (Tier 1) — importRunner: the end-to-end Phase-2/4 AS-IS import
 * executor. Covers: AS-IS field preservation (including fields this codebase has
 * never heard of), the pre-import fingerprint-collision abort (NOTHING written),
 * readback-based verification (a mangling target is CAUGHT by checksum, a dropping
 * target by missing-in-target, an inventing target by extra-in-target), dangling-FK
 * detection, schema divergence on a status literal the canonical contract does not
 * accept, duplicate-PK refusal, and InMemoryImportTarget isolation semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  DuplicateImportIdError,
  InMemoryImportTarget,
  canonicalAcceptedStatusValues,
  deriveSchemaDescriptor,
  runImport,
  type ImportTarget,
  type RawRow,
} from '../../../src/feedback-factory/migration/importRunner.js';
import { clusterChecksum } from '../../../src/feedback-factory/migration/importIntegrity.js';
import type { Cluster } from '../../../src/feedback-factory/processor/types.js';

const cluster = (i: number, extra: RawRow = {}): RawRow => ({
  clusterId: `c${i}`,
  title: `cluster ${i}`,
  description: `desc ${i}`,
  type: 'bug',
  status: 'investigating',
  fingerprint: `fp-${i}`,
  recurrenceCount: i,
  reportCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  governanceNotes: i % 2 === 0 ? `note ${i}` : null,
  ...extra,
});

const feedback = (i: number, clusterId: string | null, extra: RawRow = {}): RawRow => ({
  feedbackId: `f${i}`,
  title: `feedback ${i}`,
  description: `report ${i}`,
  type: 'bug',
  status: 'processed',
  receivedAt: '2026-01-02T00:00:00Z',
  instarVersion: '1.3.0',
  ...(clusterId ? { clusterId } : {}),
  ...extra,
});

describe('runImport — clean AS-IS import', () => {
  it('imports every row verbatim and passes the integrity gate', () => {
    const source = {
      clusters: [cluster(1), cluster(2, { someFieldWeNeverHeardOf: { nested: true } })],
      feedback: [feedback(1, 'c1'), feedback(2, 'c2'), feedback(3, null)],
    };
    const target = new InMemoryImportTarget();
    const result = runImport(source, target);

    expect(result.abortedPreImport).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.imported).toEqual({ clusters: 2, feedback: 3 });
    expect(result.report?.passed).toBe(true);
    expect(result.report?.checksumMismatches).toEqual([]);
    expect(result.report?.danglingRefs).toEqual([]);
    expect(result.report?.schemaDivergences).toEqual([]);
    // sequence reset: ids are non-numeric ("c1") → 1
    expect(result.report?.sequenceResetTo).toBe(1);

    // AS-IS: the unknown field survived the round-trip verbatim.
    const back = target.readBackClusters().find((c) => c.clusterId === 'c2');
    expect(back?.someFieldWeNeverHeardOf).toEqual({ nested: true });
  });

  it('preserves null-vs-set governance notes through the round-trip (checksum holds)', () => {
    const source = { clusters: [cluster(2)], feedback: [] };
    const target = new InMemoryImportTarget();
    const result = runImport(source, target);
    expect(result.passed).toBe(true);
    const back = target.readBackClusters()[0];
    expect(clusterChecksum(back as unknown as Cluster)).toBe(clusterChecksum(source.clusters[0] as unknown as Cluster));
  });
});

describe('runImport — pre-import fingerprint-collision abort', () => {
  it('aborts BEFORE any write when two source clusters share a fingerprint', () => {
    const source = {
      clusters: [cluster(1, { fingerprint: 'same' }), cluster(2, { fingerprint: 'same' })],
      feedback: [feedback(1, 'c1')],
    };
    const target = new InMemoryImportTarget();
    const result = runImport(source, target);

    expect(result.abortedPreImport).toEqual({
      reason: 'fingerprint-collision',
      collisions: [{ fingerprint: 'same', clusterIds: ['c1', 'c2'] }],
    });
    expect(result.passed).toBe(false);
    expect(result.report).toBeNull();
    expect(result.imported).toEqual({ clusters: 0, feedback: 0 });
    // NOTHING was written — the abort fired before the first import call.
    expect(target.readBackClusters()).toEqual([]);
    expect(target.readBackFeedback()).toEqual([]);
  });
});

describe('runImport — readback verification catches a misbehaving target', () => {
  /** Target that silently mangles a curated field on write (the failure the checksum exists for). */
  class ManglingTarget extends InMemoryImportTarget {
    importClusterAsIs(row: RawRow): void {
      super.importClusterAsIs({ ...row, title: `${String(row.title)} (helpfully normalized)` });
    }
  }

  it('flags a target that mutates a curated field (checksum-differs)', () => {
    const result = runImport({ clusters: [cluster(1)], feedback: [] }, new ManglingTarget());
    expect(result.passed).toBe(false);
    expect(result.report?.checksumMismatches).toHaveLength(1);
    expect(result.report?.checksumMismatches[0]).toMatchObject({ id: 'c1', kind: 'cluster', reason: 'checksum-differs' });
  });

  /** Target that drops rows on the floor (write succeeded, storage didn't). */
  class DroppingTarget extends InMemoryImportTarget {
    importFeedbackAsIs(_row: RawRow): void {
      /* swallowed */
    }
  }

  it('flags a target that drops rows (missing-in-target)', () => {
    const result = runImport({ clusters: [cluster(1)], feedback: [feedback(1, 'c1')] }, new DroppingTarget());
    expect(result.passed).toBe(false);
    expect(result.report?.checksumMismatches).toContainEqual(
      expect.objectContaining({ id: 'f1', kind: 'feedback', reason: 'missing-in-target' }),
    );
  });

  /** Target that invents rows (e.g. a seeded/dirty store the import landed on). */
  class InventingTarget extends InMemoryImportTarget {
    readBackClusters(): RawRow[] {
      return [...super.readBackClusters(), cluster(99, { fingerprint: 'fp-99' })];
    }
  }

  it('flags a target holding rows the source never sent (extra-in-target)', () => {
    const result = runImport({ clusters: [cluster(1)], feedback: [] }, new InventingTarget());
    expect(result.passed).toBe(false);
    expect(result.report?.checksumMismatches).toContainEqual(
      expect.objectContaining({ id: 'c99', kind: 'cluster', reason: 'extra-in-target' }),
    );
  });
});

describe('runImport — referential integrity and schema equivalence', () => {
  it('flags a feedback row whose clusterId resolves to no imported cluster', () => {
    const result = runImport(
      { clusters: [cluster(1)], feedback: [feedback(1, 'c-nonexistent')] },
      new InMemoryImportTarget(),
    );
    expect(result.passed).toBe(false);
    expect(result.report?.danglingRefs).toEqual([{ feedbackId: 'f1', clusterId: 'c-nonexistent' }]);
  });

  it('flags a source status literal the canonical contract does not accept', () => {
    const result = runImport(
      { clusters: [cluster(1, { status: 'some_portal_invention' })], feedback: [] },
      new InMemoryImportTarget(),
    );
    expect(result.passed).toBe(false);
    expect(result.report?.schemaDivergences).toContainEqual(
      expect.objectContaining({ field: 'status', kind: 'unknown-status-value' }),
    );
  });

  it('accepts the full legacy v1 vocabulary AS-IS (the processor normalizes at read)', () => {
    const source = {
      clusters: [
        cluster(1, { status: 'open' }),
        cluster(2, { status: 'fixed' }),
        cluster(3, { status: 'resolved' }),
        cluster(4, { status: 'legacy_closed' }),
      ],
      feedback: [],
    };
    const result = runImport(source, new InMemoryImportTarget());
    expect(result.report?.schemaDivergences).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('uses the adapter-supplied schema descriptor when the target has a real one', () => {
    class StrictSchemaTarget extends InMemoryImportTarget {
      schemaDescriptor() {
        // A target whose real enum REJECTS 'investigating' — must surface as divergence.
        return { statusValues: ['new', 'closed'], fieldTypes: { status: 'string' } };
      }
    }
    const result = runImport({ clusters: [cluster(1)], feedback: [] }, new StrictSchemaTarget());
    expect(result.passed).toBe(false);
    expect(result.report?.schemaDivergences).toContainEqual(
      expect.objectContaining({ field: 'status', kind: 'unknown-status-value', detail: expect.stringContaining('investigating') }),
    );
  });
});

describe('runImport — numeric PK sequence planning', () => {
  it('plans the sequence reset past the highest numeric cluster id', () => {
    const source = {
      clusters: [cluster(1, { clusterId: '17' }), cluster(2, { clusterId: '5', fingerprint: 'fp-other' })],
      feedback: [],
    };
    const result = runImport(source, new InMemoryImportTarget());
    expect(result.report?.sequenceResetTo).toBe(18);
  });
});

describe('InMemoryImportTarget — PK + isolation semantics', () => {
  it('refuses a duplicate clusterId the way the real PK constraint would', () => {
    const t = new InMemoryImportTarget();
    t.importClusterAsIs(cluster(1));
    expect(() => t.importClusterAsIs(cluster(1))).toThrow(DuplicateImportIdError);
  });

  it('refuses a duplicate feedbackId', () => {
    const t = new InMemoryImportTarget();
    t.importFeedbackAsIs(feedback(1, 'c1'));
    expect(() => t.importFeedbackAsIs(feedback(1, 'c1'))).toThrow(DuplicateImportIdError);
  });

  it('refuses a row with no resolvable id', () => {
    const t = new InMemoryImportTarget();
    expect(() => t.importClusterAsIs({ title: 'no id' })).toThrow(/no resolvable id/);
  });

  it('deep-copies on write AND readback — callers cannot mutate stored state', () => {
    const t = new InMemoryImportTarget();
    const row = cluster(1, { nested: { a: 1 } });
    t.importClusterAsIs(row);
    (row.nested as Record<string, unknown>).a = 999; // mutate the caller's copy after write
    const back1 = t.readBackClusters()[0];
    expect((back1.nested as Record<string, unknown>).a).toBe(1);
    (back1.nested as Record<string, unknown>).a = 777; // mutate the readback copy
    expect((t.readBackClusters()[0].nested as Record<string, unknown>).a).toBe(1);
  });

  it('accepts snake_case ids (cluster_id / feedback_id)', () => {
    const t = new InMemoryImportTarget();
    t.importClusterAsIs({ cluster_id: 'sc1', title: 't' });
    t.importFeedbackAsIs({ feedback_id: 'sf1', title: 't' });
    expect(t.readBackClusters()).toHaveLength(1);
    expect(t.readBackFeedback()).toHaveLength(1);
  });
});

describe('schema derivation helpers', () => {
  it('canonicalAcceptedStatusValues spans v2, legacy v1, and legacy_closed', () => {
    const values = canonicalAcceptedStatusValues();
    for (const s of ['new', 'investigating', 'fix_applied', 'closed', 'open', 'fixed', 'resolved', 'wontfix', 'duplicate', 'legacy_closed']) {
      expect(values).toContain(s);
    }
  });

  it('deriveSchemaDescriptor observes statuses and field types, flagging mixed types', () => {
    const d = deriveSchemaDescriptor(
      [
        { status: 'new', recurrenceCount: 1, title: 'a' },
        { status: 'closed', recurrenceCount: '2', title: 'b' },
      ],
      ['recurrenceCount', 'title', 'absentField'],
    );
    expect(d.statusValues).toEqual(['closed', 'new']);
    expect(d.fieldTypes.recurrenceCount).toBe('mixed');
    expect(d.fieldTypes.title).toBe('string');
    expect(d.fieldTypes.absentField).toBeUndefined();
  });
});
