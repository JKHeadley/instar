// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests (Tier 1) — JsonlFeedbackStore: the durable canonical FeedbackStore
 * for the operated instance (Option-B receiving end).
 *
 * Pins the durability contract: every mutation survives a reload (a fresh store
 * over the same dir sees it), last-write-wins folding, import-artifact adoption
 * (a PersistedShadowImportTarget-shaped file IS a valid store), torn-line
 * tolerance, and boot-time compaction with an atomic rewrite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlFeedbackStore, __clearFeedbackLoadCacheForTests } from '../../../src/feedback-factory/store/JsonlFeedbackStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-store-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feedback-factory/jsonl-feedback-store.test.ts' });
});

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  feedbackId: id, title: `title ${id}`, description: `description for ${id}`, type: 'bug',
  receivedAt: `2026-06-11T00:00:0${id.slice(-1)}Z`, ...extra,
});

describe('JsonlFeedbackStore — durability', () => {
  it('addFeedback survives a reload (fresh store over the same dir)', () => {
    const a = new JsonlFeedbackStore(dir);
    a.addFeedback(item('fb-1'));
    expect(a.hasFeedback('fb-1')).toBe(true);

    const b = new JsonlFeedbackStore(dir);
    expect(b.hasFeedback('fb-1')).toBe(true);
    expect(b.getUnprocessedFeedback()[0]).toMatchObject({ feedbackId: 'fb-1', status: 'unprocessed' });
  });

  it('markProcessed persists across reload (last-write-wins on the appended row)', () => {
    const a = new JsonlFeedbackStore(dir);
    a.addFeedback(item('fb-1'));
    a.upsertClusterFromItem('cl-1', item('fb-1'));
    a.markProcessed('fb-1', 'cl-1');
    expect(a.getUnprocessedFeedback()).toHaveLength(0);

    const b = new JsonlFeedbackStore(dir);
    expect(b.getUnprocessedFeedback()).toHaveLength(0);
    expect(b.hasFeedback('fb-1')).toBe(true);
    expect(b.getCluster('cl-1')).toMatchObject({ clusterId: 'cl-1', reportCount: 1 });
  });

  it('cluster mutations (merge, reopen) persist across reload', () => {
    const a = new JsonlFeedbackStore(dir);
    a.upsertClusterFromItem('cl-1', item('fb-1'));
    a.mergeIntoCluster('cl-1', item('fb-2'));
    a.applyReopen('cl-1', { newStatus: 'reopened', bumpRecurrence: true, annotateField: 'researchNotes', note: 'regressed in v2' } as never);

    const b = new JsonlFeedbackStore(dir);
    const c = b.getCluster('cl-1')!;
    expect(c.reportCount).toBe(2);
    expect(c.status).toBe('reopened');
    expect(c.recurrenceCount).toBe(1);
    expect(String(c.researchNotes)).toContain('regressed in v2');
  });

  it('dispatch create/list persists across reload', () => {
    const a = new JsonlFeedbackStore(dir);
    a.createDispatch({ dispatchId: 'd-1', title: 'guidance', type: 'advisory', createdAt: '2026-06-11T00:00:00Z' } as never);
    const b = new JsonlFeedbackStore(dir);
    expect(b.listDispatches()).toHaveLength(1);
    expect(b.findDispatchByTitle('guidance')?.dispatchId).toBe('d-1');
  });
});

describe('JsonlFeedbackStore — import-artifact adoption (the cutover seam)', () => {
  it('adopts a PersistedShadowImportTarget-shaped file as-is (one full row per line)', () => {
    // Exactly what the AS-IS import writes: one JSON row per entity, alias ids.
    fs.writeFileSync(path.join(dir, 'clusters.jsonl'),
      JSON.stringify({ clusterId: 'cl-imported', title: 't', description: 'd', type: 'bug', status: 'fixed', fingerprint: 'abc', reportCount: 7, recurrenceCount: 2 }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'feedback.jsonl'),
      JSON.stringify({ feedback_id: 'fb-imported', title: 't', description: 'd', type: 'bug', status: 'processing' }) + '\n', 'utf8');

    const store = new JsonlFeedbackStore(dir);
    expect(store.getCluster('cl-imported')).toMatchObject({ fingerprint: 'abc', reportCount: 7 });
    // Curated lifecycle preserved AS-IS (never re-derived).
    expect(store.getCluster('cl-imported')!.status).toBe('fixed');
    // Alias id (feedback_id) resolves — mirrors importRunner's pickId.
    expect(store.hasFeedback('fb-imported')).toBe(true);
    expect(store.getUnprocessedFeedback()).toHaveLength(0); // status 'processing' ≠ unprocessed
  });

  it('skips a torn/corrupt line without losing the complete rows around it', () => {
    fs.writeFileSync(path.join(dir, 'feedback.jsonl'), [
      JSON.stringify(item('fb-1')),
      '{"feedbackId":"fb-torn","titl', // crash mid-append
      JSON.stringify(item('fb-2')),
    ].join('\n') + '\n', 'utf8');

    const store = new JsonlFeedbackStore(dir);
    expect(store.hasFeedback('fb-1')).toBe(true);
    expect(store.hasFeedback('fb-2')).toBe(true);
    expect(store.hasFeedback('fb-torn')).toBe(false);
  });
});

describe('JsonlFeedbackStore — compaction', () => {
  it('compacts at load when most lines are superseded, preserving latest state', () => {
    // 600 entities × 2 rows each = 1200 lines, 50%+ superseded → compaction fires.
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(JSON.stringify({ feedbackId: `fb-${i}`, title: 't', description: 'd', type: 'bug', status: 'unprocessed' }));
      lines.push(JSON.stringify({ feedbackId: `fb-${i}`, title: 't', description: 'd', type: 'bug', status: 'processing', clusterId: 'cl-x' }));
    }
    const p = path.join(dir, 'feedback.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');

    const store = new JsonlFeedbackStore(dir);
    expect(store.getUnprocessedFeedback()).toHaveLength(0); // latest rows won
    const after = fs.readFileSync(p, 'utf8').trim().split('\n');
    expect(after).toHaveLength(600); // one row per entity post-compaction
    // And the compacted file still loads identically.
    const reread = new JsonlFeedbackStore(dir);
    expect(reread.hasFeedback('fb-599')).toBe(true);
  });

  it('does NOT compact a small file (below the line threshold)', () => {
    const p = path.join(dir, 'feedback.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify(item('fb-1')),
      JSON.stringify({ ...item('fb-1'), status: 'processing' }),
    ].join('\n') + '\n', 'utf8');
    new JsonlFeedbackStore(dir);
    expect(fs.readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(2); // untouched
  });
});

// ── Event-loop blocker regression (2026-06-22 batch) ────────────────────
// reload() re-reads the multi-MB feedback.jsonl on every processing pass. A
// (size, mtime) cache skips the synchronous read+parse when the file is
// byte-identical to the last fold — but a genuine append MUST still be seen.
describe('JsonlFeedbackStore — (size,mtime) load cache', () => {
  beforeEach(() => __clearFeedbackLoadCacheForTests());

  it('serves an unchanged file from cache WITHOUT re-reading it', () => {
    const p = path.join(dir, 'feedback.jsonl');
    const a = new JsonlFeedbackStore(dir); // first load populates the cache
    a.addFeedback(item('fb-1'));           // append changes the file → cache invalidates

    // A fresh store over the SAME unchanged dir loads the cached fold; a second
    // fresh store must NOT call readFileSync on feedback.jsonl (served from cache).
    new JsonlFeedbackStore(dir); // primes the cache against the current bytes
    const realReadFileSync = fs.readFileSync.bind(fs);
    let readTheFeedbackFile = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((fp: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof fp === 'string' && fp === p) readTheFeedbackFile = true;
      // @ts-expect-error pass-through
      return realReadFileSync(fp, ...rest);
    }) as typeof fs.readFileSync);

    const c = new JsonlFeedbackStore(dir);
    expect(c.hasFeedback('fb-1')).toBe(true); // correct data
    expect(readTheFeedbackFile).toBe(false);  // but served from the (size,mtime) cache
    spy.mockRestore();
  });

  it('re-reads (cache invalidates) when the file genuinely grows', () => {
    const p = path.join(dir, 'feedback.jsonl');
    new JsonlFeedbackStore(dir); // populate cache (empty/absent file)
    // Simulate ANOTHER process (the InboxDrainer) appending a new row.
    fs.appendFileSync(p, JSON.stringify(item('fb-new')) + '\n');
    // A fresh store must observe the appended row — cache keyed on (size,mtime)
    // detects the change and re-folds from disk.
    const after = new JsonlFeedbackStore(dir);
    expect(after.hasFeedback('fb-new')).toBe(true);
  });

  it('two stores over the same unchanged file get independent row Maps (clone per serve)', () => {
    const p = path.join(dir, 'feedback.jsonl');
    fs.writeFileSync(p, JSON.stringify(item('fb-1')) + '\n', 'utf8');
    const a = new JsonlFeedbackStore(dir); // first load → cache
    const b = new JsonlFeedbackStore(dir); // served from the (size,mtime) cache
    // Each store got `new Map(cached.rows)`, so a's later append never bleeds
    // into b's Map identity (the cache hands out a fresh Map per serve).
    a.addFeedback(item('fb-2'));
    expect(a.hasFeedback('fb-2')).toBe(true);
    expect(b.hasFeedback('fb-2')).toBe(false);
  });
});
