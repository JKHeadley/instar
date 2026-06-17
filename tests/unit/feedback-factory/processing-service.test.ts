// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-1 unit tests — feedback-factory processing wiring (spec §191).
 *
 * Covers, with real dependencies (a real on-disk JsonlFeedbackStore in a tmpdir):
 *   - JsonlFeedbackStore.stats(): byStatus buckets, counts, lastWriteAt high-water
 *     mark, over both an EMPTY store and a POPULATED one.
 *   - FeedbackProcessingService.processNow(): runs one clustering pass over the
 *     canonical store, flips unprocessed→processing, and is idempotent on re-run.
 *   - resolveCanonicalStoreDir(): explicit processing.dataDir > receiverPersistence
 *     dataDir > <stateDir>/state/feedback-factory/store > null.
 *   - resolveDevAgentGate over feedbackFactory.processing.enabled: live-on-dev,
 *     dark-on-fleet, explicit-wins (both sides of the boundary).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlFeedbackStore } from '../../../src/feedback-factory/store/JsonlFeedbackStore.js';
import {
  FeedbackProcessingService,
  resolveCanonicalStoreDir,
} from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { resolveDevAgentGate } from '../../../src/core/devAgentGate.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let storeDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-processing-'));
  storeDir = path.join(tmpDir, 'store');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/feedback-factory/processing-service.test.ts' });
});

const item = (id: string, title: string, description: string, receivedAt: string, status?: string) =>
  ({ feedbackId: id, title, description, type: 'bug', receivedAt, ...(status ? { status } : {}) });

describe('JsonlFeedbackStore.stats()', () => {
  it('reports zeroes + null lastWriteAt on an empty store', () => {
    const store = new JsonlFeedbackStore(storeDir);
    const s = store.stats();
    expect(s).toEqual({ total: 0, byStatus: {}, clusterCount: 0, dispatchCount: 0, lastWriteAt: null });
  });

  it('buckets by status, counts entities, and surfaces the latest content timestamp', () => {
    const store = new JsonlFeedbackStore(storeDir);
    store.addFeedback(item('fb-1', 'alpha bug', 'a description long enough', '2026-05-01T00:00:00Z'));
    store.addFeedback(item('fb-2', 'alpha bug', 'a description long enough', '2026-05-03T00:00:00Z'));
    store.addFeedback(item('fb-3', 'beta bug', 'another description here', '2026-05-02T00:00:00Z'));
    // Mark fb-1 processed (unprocessed→processing) so byStatus has two buckets.
    store.markProcessed('fb-1', 'c-1');

    const s = store.stats();
    expect(s.total).toBe(3);
    // fb-1 → processing; fb-2, fb-3 → unprocessed (status defaulted).
    expect(s.byStatus).toEqual({ processing: 1, unprocessed: 2 });
    // markProcessed created cluster c-1 via... no — markProcessed only flips the item.
    // upsert happens in the processor; here clusterCount stays 0 (no cluster written).
    expect(s.clusterCount).toBe(0);
    expect(s.dispatchCount).toBe(0);
    // High-water mark across receivedAt values.
    expect(s.lastWriteAt).toBe('2026-05-03T00:00:00Z');
  });

  it('counts clusters created by a real processing pass', () => {
    const store = new JsonlFeedbackStore(storeDir);
    store.addFeedback(item('fb-1', 'gitsync pull fails', 'times out under load repeatedly', '2026-05-01T00:00:00Z'));
    // The service reads the same dir from disk; its pass creates the cluster.
    const svc = new FeedbackProcessingService({ dataDir: storeDir });
    const { stats } = svc.processNow('2026-06-01T00:00:00.000Z');
    expect(stats.clusterCount).toBe(1);
    // A fresh reader over the same dir observes the durable cluster row.
    expect(new JsonlFeedbackStore(storeDir).stats().clusterCount).toBe(1);
  });
});

describe('FeedbackProcessingService.processNow()', () => {
  it('clusters unprocessed items and flips them to processing (one pass)', () => {
    const store = new JsonlFeedbackStore(storeDir);
    store.addFeedback(item('fb-1', 'gitsync pull fails', 'times out under load repeatedly', '2026-05-01T00:00:00Z'));
    store.addFeedback(item('fb-2', 'gitsync pull fails', 'times out under load repeatedly', '2026-05-01T01:00:00Z'));
    store.addFeedback(item('fb-3', 'totally unrelated csv export bug', 'drops a row on export', '2026-05-01T02:00:00Z'));

    const svc = new FeedbackProcessingService({ dataDir: storeDir });
    const { result, stats } = svc.processNow('2026-06-01T00:00:00.000Z');

    expect(result.results).toHaveLength(3);
    expect(result.metrics.captured).toBe(3); // all three marked processed
    // After the pass nothing is unprocessed.
    expect(stats.byStatus.unprocessed ?? 0).toBe(0);
    expect(stats.byStatus.processing).toBe(3);
    // Two distinct clusters (the gitsync pair merges; the csv bug is its own).
    expect(stats.clusterCount).toBe(2);
  });

  it('is idempotent + forward-only — a re-run over the same store does no new work', () => {
    const store = new JsonlFeedbackStore(storeDir);
    store.addFeedback(item('fb-1', 'auth token refresh broken', 'returns 401 after expiry', '2026-05-01T00:00:00Z'));
    const svc = new FeedbackProcessingService({ dataDir: storeDir });

    const first = svc.processNow('2026-06-01T00:00:00.000Z');
    expect(first.result.results).toHaveLength(1);

    // Second pass: nothing is unprocessed any more → zero results.
    const second = svc.processNow('2026-06-01T00:05:00.000Z');
    expect(second.result.results).toHaveLength(0);
    expect(second.stats.byStatus.unprocessed ?? 0).toBe(0);
  });

  it('reloads from disk per pass — clusters rows a SEPARATE-process writer appended AFTER boot (regression: the InboxDrainer defect)', () => {
    // PRODUCTION ORDERING the old tests missed: the service is constructed FIRST
    // (mirroring boot, when its JsonlFeedbackStore loads feedback.jsonl once),
    // and THEN a NEW unprocessed row is appended by a SEPARATE store instance
    // pointed at the same dir — exactly what the InboxDrainer (a distinct launchd
    // process holding its own store) does continuously after boot.
    const svc = new FeedbackProcessingService({ dataDir: storeDir });

    // First pass over an empty store: nothing to do.
    const initial = svc.processNow('2026-06-01T00:00:00.000Z');
    expect(initial.result.results).toHaveLength(0);
    expect(svc.stats().total).toBe(0);

    // A SEPARATE store instance (the "drainer process") appends a new report to
    // the SAME on-disk feedback.jsonl AFTER the service was built.
    const drainerStore = new JsonlFeedbackStore(storeDir);
    drainerStore.addFeedback(
      item('fb-late', 'post-boot ingest report', 'arrived after the service booted', '2026-05-10T00:00:00Z'),
    );

    // The next pass MUST see the late row, cluster it, and reflect it in stats —
    // this is what fails without store.reload() (the in-memory Map stays frozen
    // at construction and the pass is a permanent no-op over post-boot ingest).
    const next = svc.processNow('2026-06-01T00:30:00.000Z');
    expect(next.result.results).toHaveLength(1);
    expect(next.stats.total).toBe(1);
    expect(next.stats.clusterCount).toBe(1);
    expect(next.stats.byStatus.processing).toBe(1);
    expect(next.stats.byStatus.unprocessed ?? 0).toBe(0);

    // And stats() (the read surface) independently reflects the post-boot row.
    const s = svc.stats();
    expect(s.total).toBe(1);
    expect(s.clusterCount).toBe(1);
  });

  it('reads the canonical store from disk (a fresh service sees prior on-disk rows)', () => {
    // Seed the feedback row on disk FIRST…
    const seedStore = new JsonlFeedbackStore(storeDir);
    seedStore.addFeedback(item('fb-seed', 'persisted report', 'a long enough description body', '2026-05-01T00:00:00Z'));

    // …then a service constructed AFTER the write loads it and clusters it.
    const svc = new FeedbackProcessingService({ dataDir: storeDir });
    svc.processNow('2026-06-01T00:00:00.000Z');

    // A BRAND NEW service over the same dir must observe the persisted state.
    const fresh = new FeedbackProcessingService({ dataDir: storeDir });
    expect(fresh.stats().total).toBe(1);
    expect(fresh.stats().clusterCount).toBe(1);
  });
});

describe('resolveCanonicalStoreDir()', () => {
  it('prefers an explicit processing.dataDir', () => {
    expect(
      resolveCanonicalStoreDir({ stateDir: '/s', feedbackFactory: { processing: { dataDir: '/explicit' }, receiverPersistence: { dataDir: '/recv' } } }),
    ).toBe('/explicit');
  });
  it('falls back to receiverPersistence.dataDir so the two ends share one store', () => {
    expect(
      resolveCanonicalStoreDir({ stateDir: '/s', feedbackFactory: { receiverPersistence: { dataDir: '/recv' } } }),
    ).toBe('/recv');
  });
  it('falls back to the shipped default under stateDir', () => {
    expect(resolveCanonicalStoreDir({ stateDir: '/s' })).toBe(path.join('/s', 'state', 'feedback-factory', 'store'));
  });
  it('returns null when there is no stateDir and no explicit dir', () => {
    expect(resolveCanonicalStoreDir({})).toBeNull();
  });
});

describe('feedbackFactory.processing dev-gate (resolveDevAgentGate)', () => {
  it('is LIVE on a development agent when enabled is omitted', () => {
    expect(resolveDevAgentGate(undefined, { developmentAgent: true })).toBe(true);
  });
  it('is DARK on the fleet when enabled is omitted', () => {
    expect(resolveDevAgentGate(undefined, { developmentAgent: false })).toBe(false);
    expect(resolveDevAgentGate(undefined, {})).toBe(false);
  });
  it('honors an explicit enabled on BOTH sides (false force-darks a dev agent, true fleet-flips)', () => {
    expect(resolveDevAgentGate(false, { developmentAgent: true })).toBe(false);
    expect(resolveDevAgentGate(true, { developmentAgent: false })).toBe(true);
  });
});
