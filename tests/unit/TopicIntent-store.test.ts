/**
 * Unit tests for TopicIntentStore — file persistence + append-only event log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicIntentStore,
  buildEvent,
  type EvidenceEvent,
} from '../../src/core/TopicIntent.js';

let tempDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-store-test-'));
  store = new TopicIntentStore(tempDir);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-store.test.ts' }); } catch { /* best effort */ }
});

describe('TopicIntentStore — persistence', () => {
  it('loads an empty skeleton for an unknown topicId', () => {
    const file = store.load(99999);
    expect(file.topicId).toBe(99999);
    expect(file.refs).toEqual({});
    expect(file.pending.outstanding).toBeNull();
    expect(file.pending.queue).toEqual([]);
    expect(file.schemaVersion).toBe(1);
    expect(file.telemetry).toBeDefined();
  });

  it('creates the topic-intent directory on construction', () => {
    expect(fs.existsSync(path.join(tempDir, 'topic-intent'))).toBe(true);
  });

  it('appendEvidence creates a new ref and persists', () => {
    const ev = buildEvent('ref-a', 'extract-user', 'msg-1');
    const file = store.appendEvidence(1234, 'ref-a', ev, { text: 'use Path A OAuth', kind: 'decision' });
    expect(file.refs['ref-a']).toBeDefined();
    expect(file.refs['ref-a'].text).toBe('use Path A OAuth');
    expect(file.refs['ref-a'].kind).toBe('decision');
    expect(file.refs['ref-a'].evidence).toHaveLength(1);
    expect(file.refs['ref-a'].confidence).toBeCloseTo(0.40);

    // Verify on-disk
    const reloaded = store.load(1234);
    expect(reloaded.refs['ref-a'].evidence).toHaveLength(1);
    expect(reloaded.refs['ref-a'].confidence).toBeCloseTo(0.40);
  });

  it('appendEvidence is append-only (preserves prior events)', () => {
    store.appendEvidence(2, 'ref-x', buildEvent('ref-x', 'extract-user', 'msg-1'));
    store.appendEvidence(2, 'ref-x', buildEvent('ref-x', 'user-reref', 'msg-2'));
    store.appendEvidence(2, 'ref-x', buildEvent('ref-x', 'user-affirm', 'msg-3'));

    const file = store.load(2);
    expect(file.refs['ref-x'].evidence).toHaveLength(3);
    expect(file.refs['ref-x'].evidence.map(e => e.kind)).toEqual([
      'extract-user', 'user-reref', 'user-affirm'
    ]);
  });

  it('appendEvidence updates lastReinforcedAt only on positive-delta events', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const t1 = '2026-01-02T00:00:00.000Z';
    const t2 = '2026-01-03T00:00:00.000Z';

    store.appendEvidence(3, 'ref-y', buildEvent('ref-y', 'extract-user', 'msg-1', { at: t0 }));
    let file = store.load(3);
    expect(file.refs['ref-y'].lastReinforcedAt).toBe(t0);

    // Negative event (contradiction) should NOT update lastReinforcedAt
    store.appendEvidence(3, 'ref-y', buildEvent('ref-y', 'contradiction', 'msg-2', { at: t1 }));
    file = store.load(3);
    expect(file.refs['ref-y'].lastReinforcedAt).toBe(t0);

    // Positive event SHOULD update it
    store.appendEvidence(3, 'ref-y', buildEvent('ref-y', 'user-affirm', 'msg-3', { at: t2 }));
    file = store.load(3);
    expect(file.refs['ref-y'].lastReinforcedAt).toBe(t2);
  });

  it('telemetry counters increment with each event', () => {
    store.appendEvidence(4, 'ref-z', buildEvent('ref-z', 'extract-user', 'msg-1'));
    store.appendEvidence(4, 'ref-z', buildEvent('ref-z', 'user-affirm', 'msg-2'));
    store.appendEvidence(4, 'ref-z', buildEvent('ref-z', 'agent-reref', 'msg-3'));

    const file = store.load(4);
    expect(file.telemetry.evidence_event_total['extract-user']).toBe(1);
    expect(file.telemetry.evidence_event_total['user-affirm']).toBe(1);
    expect(file.telemetry.evidence_event_total['agent-reref']).toBe(1);
    expect(file.telemetry.extraction_total['extract-user:true']).toBe(1);
    expect(file.telemetry.extraction_total['agent-reref:false']).toBe(1);
  });

  it('survives a corrupt file by returning empty skeleton', () => {
    const fp = path.join(tempDir, 'topic-intent', '5.json');
    fs.writeFileSync(fp, 'NOT_VALID_JSON{{{');
    const file = store.load(5);
    expect(file.topicId).toBe(5);
    expect(file.refs).toEqual({});
  });

  it('getProjection returns null for unknown ref', () => {
    expect(store.getProjection(6, 'no-such-ref')).toBeNull();
  });

  it('getProjection returns live projection for known ref', () => {
    store.appendEvidence(7, 'ref-p', buildEvent('ref-p', 'extract-user', 'msg-1'));
    store.appendEvidence(7, 'ref-p', buildEvent('ref-p', 'user-affirm', 'msg-2'));
    const proj = store.getProjection(7, 'ref-p');
    expect(proj).not.toBeNull();
    expect(proj!.confidence).toBeCloseTo(0.70);
    expect(proj!.tier).toBe('authoritative');
  });

  it('getRefsAtOrAbove filters by tier', () => {
    // Observation
    store.appendEvidence(8, 'ref-obs', buildEvent('ref-obs', 'agent-reref', 'msg-1'));
    // Tentative
    store.appendEvidence(8, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'msg-2'));
    // Authoritative
    store.appendEvidence(8, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'msg-3'));
    store.appendEvidence(8, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'msg-4'));

    const obs = store.getRefsAtOrAbove(8, 'observation');
    const ten = store.getRefsAtOrAbove(8, 'tentative');
    const auth = store.getRefsAtOrAbove(8, 'authoritative');

    expect(obs).toHaveLength(3); // all three
    expect(ten).toHaveLength(2); // ten + auth
    expect(auth).toHaveLength(1); // just auth
    expect(auth[0].refId).toBe('ref-auth');
  });
});
