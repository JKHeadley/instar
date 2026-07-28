/**
 * Unit tests for the concurrency-safety + arc/turn additions to TopicIntentStore:
 * atomic save, lock-guarded appendEvidence (no lost events), eventId idempotency,
 * and the bumpTurn counter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';

let tmpDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-store-conc-'));
  store = new TopicIntentStore(tmpDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-store-concurrency.test.ts' }); } catch { /* best */ }
});

describe('TopicIntentStore concurrency safety', () => {
  it('preserves every event across many rapid appends (no lost updates)', () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      const ev = buildEvent(`ref-${i}`, 'extract-user', `msg-${i}`, { at: new Date().toISOString() });
      store.appendEvidence(101, `ref-${i}`, ev, { text: `fact ${i}`, kind: 'fact', arcId: store.arcIdFor(101) });
    }
    const file = store.read(101);
    expect(Object.keys(file.refs)).toHaveLength(N);
    // file is valid JSON on disk (atomic save never left a torn file)
    const raw = fs.readFileSync(path.join(tmpDir, 'topic-intent', '101.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('appends multiple events to the SAME ref without loss', () => {
    const at = '2026-01-01T00:00:00.000Z';
    store.appendEvidence(102, 'ref-A', buildEvent('ref-A', 'extract-user', 'm1', { at }), { text: 'X', kind: 'fact', arcId: 'arc-102' });
    store.appendEvidence(102, 'ref-A', buildEvent('ref-A', 'user-reref', 'm2', { at }), {});
    store.appendEvidence(102, 'ref-A', buildEvent('ref-A', 'user-affirm', 'm3', { at }), {});
    const file = store.read(102);
    expect(file.refs['ref-A'].evidence).toHaveLength(3);
  });

  it('is idempotent — the same eventId is never appended twice', () => {
    const ev = buildEvent('ref-B', 'extract-user', 'm1', { at: '2026-01-01T00:00:00.000Z' });
    store.appendEvidence(103, 'ref-B', ev, { text: 'Y', kind: 'fact', arcId: 'arc-103' });
    store.appendEvidence(103, 'ref-B', ev, {}); // replay the SAME event object (same eventId)
    const file = store.read(103);
    expect(file.refs['ref-B'].evidence).toHaveLength(1);
  });
});

describe('arc/turn model', () => {
  it('bumpTurn increments and persists monotonically', () => {
    expect(store.bumpTurn(200)).toBe(1);
    expect(store.bumpTurn(200)).toBe(2);
    expect(store.bumpTurn(200)).toBe(3);
    expect(store.read(200).turn).toBe(3);
  });

  it('arcIdFor is the single per-topic arc', () => {
    expect(store.arcIdFor(7)).toBe('arc-7');
  });

  it('defaults turn to 0 on a fresh/legacy file', () => {
    expect(store.load(999).turn).toBe(0);
  });
});
