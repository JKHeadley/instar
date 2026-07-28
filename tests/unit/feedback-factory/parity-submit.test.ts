/**
 * Unit tests (Tier 1) — Phase-3 parity-submit emitter (buildParitySubmitPayload).
 *
 * Covers both sides of every decision boundary:
 *   - action merge / create both map faithfully
 *   - per-item fingerprint is the canonical clusterFingerprint (correct by construction)
 *   - optional clusterTitle/note: included when present, OMITTED when absent
 *   - cluster resolver accepts both a Map and a function form
 *   - integrity: a result referencing an unresolvable clusterId THROWS (never silently dropped)
 *   - batchId is required and passed through
 *
 * Expected fingerprints are computed with the real `clusterFingerprint` so the test
 * stays valid if the fingerprint logic legitimately changes.
 */

import { describe, it, expect } from 'vitest';
import { clusterFingerprint } from '../../../src/feedback-factory/processor/parity.js';
import {
  buildParitySubmitPayload,
  type ClusterIdentity,
} from '../../../src/feedback-factory/processor/paritySubmit.js';
import type { ClusterResult } from '../../../src/feedback-factory/processor/types.js';

const clusters = new Map<string, ClusterIdentity>([
  ['c-merge', { type: 'bug', title: 'telegram relay drops message' }],
  ['c-create', { type: 'feature', title: 'add slack adapter' }],
  ['c-notype', { title: 'cluster with no type' }], // type undefined → defaults to ''
]);

describe('buildParitySubmitPayload', () => {
  it('maps a merge decision to the Dawn-locked item shape with canonical fingerprint', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-1', action: 'merge', clusterId: 'c-merge', similarity: 0.87, clusterTitle: 'telegram relay drops message', note: 'jaccard 0.87' },
    ];
    const out = buildParitySubmitPayload(results, clusters, { batchId: 'batch-1' });
    expect(out.batchId).toBe('batch-1');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({
      feedbackId: 'fb-1',
      action: 'merge',
      clusterId: 'c-merge',
      fingerprint: clusterFingerprint({ type: 'bug', title: 'telegram relay drops message' }),
      similarity: 0.87,
      clusterTitle: 'telegram relay drops message',
      note: 'jaccard 0.87',
    });
  });

  it('maps a create decision and computes the new cluster fingerprint', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-2', action: 'create', clusterId: 'c-create', similarity: 0 },
    ];
    const out = buildParitySubmitPayload(results, clusters, { batchId: 'batch-2' });
    expect(out.items[0].action).toBe('create');
    expect(out.items[0].fingerprint).toBe(clusterFingerprint({ type: 'feature', title: 'add slack adapter' }));
    expect(out.items[0].similarity).toBe(0);
  });

  it('OMITS optional clusterTitle/note when absent (does not emit undefined/null keys)', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-3', action: 'create', clusterId: 'c-create', similarity: 0.0 },
    ];
    const out = buildParitySubmitPayload(results, clusters, { batchId: 'b' });
    expect('clusterTitle' in out.items[0]).toBe(false);
    expect('note' in out.items[0]).toBe(false);
  });

  it('defaults a missing cluster type to empty string for the fingerprint', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-4', action: 'merge', clusterId: 'c-notype', similarity: 0.5 },
    ];
    const out = buildParitySubmitPayload(results, clusters, { batchId: 'b' });
    expect(out.items[0].fingerprint).toBe(clusterFingerprint({ type: '', title: 'cluster with no type' }));
  });

  it('accepts a function resolver as well as a Map', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-5', action: 'merge', clusterId: 'c-merge', similarity: 0.9 },
    ];
    const fnResolver = (id: string): ClusterIdentity | undefined => clusters.get(id);
    const out = buildParitySubmitPayload(results, fnResolver, { batchId: 'b' });
    expect(out.items[0].fingerprint).toBe(clusterFingerprint({ type: 'bug', title: 'telegram relay drops message' }));
  });

  it('preserves order and handles a multi-item batch', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-a', action: 'create', clusterId: 'c-create', similarity: 0 },
      { feedbackId: 'fb-b', action: 'merge', clusterId: 'c-merge', similarity: 0.4 },
    ];
    const out = buildParitySubmitPayload(results, clusters, { batchId: 'b' });
    expect(out.items.map((i) => i.feedbackId)).toEqual(['fb-a', 'fb-b']);
  });

  it('THROWS on an unresolvable clusterId (never silently drops an item)', () => {
    const results: ClusterResult[] = [
      { feedbackId: 'fb-x', action: 'merge', clusterId: 'c-missing', similarity: 0.7 },
    ];
    expect(() => buildParitySubmitPayload(results, clusters, { batchId: 'b' })).toThrow(/no cluster identity for clusterId=c-missing/);
  });

  it('THROWS when batchId is missing or empty', () => {
    expect(() => buildParitySubmitPayload([], clusters, { batchId: '' })).toThrow(/batchId is required/);
    // @ts-expect-error — exercising the runtime guard with a bad opts
    expect(() => buildParitySubmitPayload([], clusters, {})).toThrow(/batchId is required/);
  });

  it('returns an empty items array for an empty batch', () => {
    const out = buildParitySubmitPayload([], clusters, { batchId: 'empty' });
    expect(out).toEqual({ batchId: 'empty', items: [] });
  });
});
