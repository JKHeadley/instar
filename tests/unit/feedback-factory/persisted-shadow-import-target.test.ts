/**
 * Unit tests (Tier 1) — PersistedShadowImportTarget (the durable pre-click shadow).
 *
 * Both-sides-of-boundary: AS-IS rows persist + read back verbatim; a duplicate PK
 * throws (mirrors the @id constraint); the durability survives a fresh instance over
 * the same dir (the property that distinguishes it from the ephemeral in-memory
 * dry-run target); dispose() removes the shadow; schemaDescriptor() is null (the
 * runner derives the dry-run schema, like InMemoryImportTarget).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistedShadowImportTarget } from '../../../src/feedback-factory/migration/PersistedShadowImportTarget.js';
import { DuplicateImportIdError, type RawRow } from '../../../src/feedback-factory/migration/importRunner.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const CL: RawRow = { clusterId: 'c1', title: 'x', status: 'investigating', fingerprint: 'fp1' };
const CL2: RawRow = { clusterId: 'c2', title: 'y', status: 'fixed', fingerprint: 'fp2' };
const FB: RawRow = { feedbackId: 'f1', title: 'x', type: 'bug', clusterId: 'c1' };

describe('PersistedShadowImportTarget (durable pre-click shadow)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feedback-factory/persisted-shadow-import-target.test.ts' }));

  it('persists clusters + feedback AS-IS and reads them back verbatim', () => {
    const t = new PersistedShadowImportTarget(path.join(dir, 's'));
    t.importClusterAsIs(CL);
    t.importClusterAsIs(CL2);
    t.importFeedbackAsIs(FB);
    expect(t.readBackClusters()).toEqual([CL, CL2]);
    expect(t.readBackFeedback()).toEqual([FB]);
    expect(t.schemaDescriptor()).toBeNull();
  });

  it('refuses a duplicate cluster PK and a duplicate feedback PK (the @id constraint)', () => {
    const t = new PersistedShadowImportTarget(path.join(dir, 's'));
    t.importClusterAsIs(CL);
    expect(() => t.importClusterAsIs({ ...CL, title: 'changed' })).toThrow(DuplicateImportIdError);
    t.importFeedbackAsIs(FB);
    expect(() => t.importFeedbackAsIs({ ...FB, title: 'changed' })).toThrow(DuplicateImportIdError);
  });

  it('is DURABLE — a fresh instance over the same dir reads prior rows and still refuses dups', () => {
    const shadow = path.join(dir, 's');
    const t1 = new PersistedShadowImportTarget(shadow);
    t1.importClusterAsIs(CL);
    t1.importFeedbackAsIs(FB);
    // New process/instance, same dir: rows are on disk, PK sets rebuilt from them.
    const t2 = new PersistedShadowImportTarget(shadow);
    expect(t2.readBackClusters()).toEqual([CL]);
    expect(t2.readBackFeedback()).toEqual([FB]);
    expect(() => t2.importClusterAsIs(CL)).toThrow(DuplicateImportIdError);
  });

  it('throws on a row with no resolvable id', () => {
    const t = new PersistedShadowImportTarget(path.join(dir, 's'));
    expect(() => t.importClusterAsIs({ title: 'no id' })).toThrow(/no resolvable id/);
    expect(() => t.importFeedbackAsIs({ title: 'no id' })).toThrow(/no resolvable id/);
  });

  it('dispose() removes the shadow dir', () => {
    const shadow = path.join(dir, 's');
    const t = new PersistedShadowImportTarget(shadow);
    t.importClusterAsIs(CL);
    expect(fs.existsSync(shadow)).toBe(true);
    t.dispose();
    expect(fs.existsSync(shadow)).toBe(false);
  });
});
