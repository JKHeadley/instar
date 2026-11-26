// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The canonical feedback source is an append-only, last-write-wins log. Processing
 * re-appends a report's full row (same sourceRecordId) when it flips
 * unprocessed->processing; compaction rewrites the latest rows into a new
 * generation. Live 2026-10-01: the drain read its own processing write as a
 * "source record checksum conflict" and failed every run from then on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.js';
import { JsonlFeedbackStore } from '../../src/feedback-factory/store/JsonlFeedbackStore.js';
import { processUnprocessed } from '../../src/feedback-factory/processor/process.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`;

describe('FeedbackDrainStore source projection — versions vs conflicts', () => {
  let dir: string;
  let source: string;
  let store: FeedbackDrainStore;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-source-versions-'));
    source = path.join(dir, 'feedback.jsonl');
    db = new Database(':memory:');
    store = new FeedbackDrainStore({ dbPath: ':memory:', db, tokenHmacKey: 'k'.repeat(32), clock: () => 1_000 });
  });

  afterEach(() => {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-source-versions.test.ts' });
  });

  it('treats a re-appended row of the same report as a version, not a conflict', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'unprocessed', title: 'Crash' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' })).toMatchObject({ projected: 1 });
    fs.appendFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'processing', title: 'Crash', clusterId: 'cluster-crash' }));
    fs.appendFileSync(source, line({ feedbackId: 'f2', sourceRecordId: 's2', status: 'unprocessed', title: 'Other' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' }))
      .toMatchObject({ projected: 1, superseded: 1, quarantined: 0, lagBytes: 0 });
    expect(store.metrics().sourceChecksumConflicts).toBe(0);
    // The projection keeps the first line only; processing sees each report once.
    expect(store.pendingProjectedFeedback().map((row) => row.record.feedbackId)).toEqual(['f1', 'f2']);
    expect(store.reconcileSourceProjection({ filePath: source, generationId: 'g1' })).toMatchObject({ checked: 2, conflicts: 0 });
  });

  it('a later update under its own sourceRecordId is a new source record (spec), not a conflict', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'unprocessed' }) +
      line({ feedbackId: 'f1', sourceRecordId: 's1-update', status: 'processing', clusterId: 'c' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' })).toMatchObject({ projected: 2, superseded: 0, quarantined: 0 });
  });

  it('quarantines a same-id line whose content changed beyond the LWW fields', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'unprocessed', title: 'Crash' }) +
      line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'processing', title: 'Rewritten title' }) +
      line({ feedbackId: 'f2', sourceRecordId: 's2', status: 'unprocessed' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' })).toMatchObject({ projected: 2, quarantined: 1, lagBytes: 0 });
    expect(db.prepare(`SELECT reason FROM source_conflicts WHERE source_record_id='s1'`).get()).toEqual({ reason: 'source-record-content-conflict' });
    expect(store.quarantinedSourceRecords()).toBe(1);
  });

  it('quarantines only the line whose sourceRecordId names a different report, and keeps going', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1' }) +
      line({ feedbackId: 'intruder', sourceRecordId: 's1' }) +
      line({ feedbackId: 'f3', sourceRecordId: 's3' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' }))
      .toMatchObject({ projected: 2, quarantined: 1, lagBytes: 0 });
    expect(store.metrics().sourceChecksumConflicts).toBe(1);
    expect(db.prepare(`SELECT reason FROM source_conflicts WHERE source_record_id='s1'`).get()).toEqual({ reason: 'source-record-identity-conflict' });
    expect(db.prepare(`SELECT value FROM drain_meta WHERE key='source_integrity_hold'`).get()).toEqual({ value: 'source-record-identity-conflict' });
    expect(store.pendingProjectedFeedback().map((row) => row.record.feedbackId)).toEqual(['f1', 'f3']);
  });

  it('self-heals a conflict an earlier build recorded for a version line', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'unprocessed' }));
    store.projectSourceGeneration({ filePath: source, generationId: 'g1' });
    // The state the live store was left in: conflict row + hold, cursor before the version line.
    db.prepare(`INSERT INTO source_conflicts VALUES ('s1','a','b','source-record-checksum-conflict',1)`).run();
    db.prepare(`INSERT INTO drain_meta(key,value) VALUES ('source_integrity_hold','source-record-checksum-conflict')`).run();
    fs.appendFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'processing' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' })).toMatchObject({ superseded: 1, quarantined: 0 });
    expect(store.metrics().sourceChecksumConflicts).toBe(0);
    expect(db.prepare(`SELECT value FROM drain_meta WHERE key='source_integrity_hold'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT reason FROM drain_audit WHERE kind='source-record'`).all()).toEqual([{ reason: 'cleared-misclassified-conflict' }]);
  });

  it('accepts a legacy update that only re-keyed the report id as feedbackId', () => {
    fs.writeFileSync(source, line({ id: 'f1', sourceRecordId: 's1', status: 'unprocessed', title: 'Crash' }) +
      line({ id: 'f1', feedbackId: 'f1', sourceRecordId: 's1', status: 'processing', clusterId: 'c', title: 'Crash' }));
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1' })).toMatchObject({ projected: 1, superseded: 1, quarantined: 0 });
  });

  it('counts an in-place edit found by reconciliation as held (every run degraded until repaired)', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', title: 'aaaa' }));
    store.projectSourceGeneration({ filePath: source, generationId: 'g1' });
    expect(store.quarantinedSourceRecords()).toBe(0);
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', title: 'bbbb' }));
    expect(store.reconcileSourceProjection({ filePath: source, generationId: 'g1' })).toMatchObject({ conflicts: 1 });
    expect(store.quarantinedSourceRecords()).toBe(1);
  });

  it('keeps an unrelated conflict (and the hold) when a version line clears another', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1' }));
    store.projectSourceGeneration({ filePath: source, generationId: 'g1' });
    db.prepare(`INSERT INTO source_conflicts VALUES ('s9','a','b','reconciliation-checksum-conflict',1)`).run();
    db.prepare(`INSERT INTO drain_meta(key,value) VALUES ('source_integrity_hold','reconciliation-checksum-conflict')`).run();
    fs.appendFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'processing' }));
    store.projectSourceGeneration({ filePath: source, generationId: 'g1' });
    expect(store.metrics().sourceChecksumConflicts).toBe(1);
    expect(db.prepare(`SELECT value FROM drain_meta WHERE key='source_integrity_hold'`).get()).toEqual({ value: 'reconciliation-checksum-conflict' });
  });

  it('starts the cursor after the copied prefix of a compacted generation', () => {
    fs.writeFileSync(source, line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'unprocessed' }) +
      line({ feedbackId: 'f1', sourceRecordId: 's1', status: 'processing' }));
    const generations = new FeedbackSourceGenerations(dir);
    expect(store.projectSourceGeneration({ filePath: source, generationId: 'canonical-feedback-v1' })).toMatchObject({ lagBytes: 0 });
    const handoff = generations.compact(5_000)!;
    store.acceptSourceHandoff({ fromGenerationId: handoff.fromGenerationId, finalOffset: handoff.finalOffset, toGenerationId: handoff.toGenerationId, startOffset: handoff.startOffset });
    expect(store.sourceCursor()).toMatchObject({ generationId: handoff.toGenerationId, byteOffset: handoff.startOffset });
    generations.append({ feedbackId: 'f2', sourceRecordId: 's2', status: 'unprocessed' });
    expect(store.projectSourceGeneration({ filePath: generations.current().filePath, generationId: handoff.toGenerationId }))
      .toMatchObject({ projected: 1, replayed: 0, superseded: 0, lagBytes: 0 });
    expect(() => store.acceptSourceHandoff({ fromGenerationId: 'x', finalOffset: 0, toGenerationId: 'y', startOffset: -1 })).toThrow(/start offset/);
  });
});

describe('FeedbackSourceGenerations.compact — no byte-identical generations', () => {
  it('skips a compacted generation with nothing superseded, but still moves the legacy file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-compact-idempotent-'));
    try {
      fs.writeFileSync(path.join(dir, 'feedback.jsonl'), line({ feedbackId: 'f1', status: 'unprocessed' }));
      const generations = new FeedbackSourceGenerations(dir);
      expect(generations.compact(1)).not.toBeNull();
      expect(generations.compact(2)).toBeNull();
      generations.append({ feedbackId: 'f1', status: 'processing' });
      expect(generations.compact(3)).not.toBeNull();
      expect(fs.readdirSync(path.join(dir, 'feedback-generations'))).toHaveLength(2);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-source-versions.test.ts' }); }
  });
});

describe('JsonlFeedbackStore projected scope — replay after a crash mid-pass', () => {
  it('does not cluster (or count) a projected report the store already processed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-projected-replay-'));
    try {
      const row = { feedbackId: 'f1', status: 'unprocessed', title: 'Scheduler crash on boot', description: 'x', type: 'bug' };
      fs.writeFileSync(path.join(dir, 'feedback.jsonl'), line(row));
      const jsonl = new JsonlFeedbackStore(dir);
      const first = jsonl.withProjectedFeedbackScope([row], () => processUnprocessed(jsonl, '2026-10-01T00:00:00.000Z'));
      expect(first.results).toHaveLength(1);
      const replay = jsonl.withProjectedFeedbackScope([row], () => processUnprocessed(jsonl, '2026-10-01T00:00:00.000Z'));
      expect(replay.results).toHaveLength(0);
      expect(jsonl.getActiveClusters().map((cluster) => cluster.reportCount)).toEqual([1]);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-source-versions.test.ts' }); }
  });

  it('writes a processing update as a new source record (fresh sourceRecordId)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-processing-update-'));
    try {
      const row = { feedbackId: 'f1', sourceRecordId: 'feedback-source:original', status: 'unprocessed', title: 'Scheduler crash on boot', description: 'x', type: 'bug' };
      fs.writeFileSync(path.join(dir, 'feedback.jsonl'), line(row));
      const jsonl = new JsonlFeedbackStore(dir);
      jsonl.withProjectedFeedbackScope([row], () => processUnprocessed(jsonl, '2026-10-01T00:00:00.000Z'));
      const rows = fs.readFileSync(path.join(dir, 'feedback.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ feedbackId: 'f1', status: 'processing' });
      expect(rows[1].sourceRecordId).toMatch(/^feedback-source:/);
      expect(rows[1].sourceRecordId).not.toBe('feedback-source:original');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-source-versions.test.ts' }); }
  });
});
