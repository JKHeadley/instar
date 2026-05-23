/**
 * Unit tests for PendingConfirmationManager — queue + TTL + dedup + retry.
 *
 * Covers spec acceptance items 4 and 5:
 *   4. 4th queued confirmation is silently dropped; telemetry counter increments
 *   5. Sharpening retry: ambiguous answer triggers up to 2 retries, then abandoned
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicIntentStore,
  buildEvent,
} from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';

let tempDir: string;
let store: TopicIntentStore;
let mgr: PendingConfirmationManager;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-pending-test-'));
  store = new TopicIntentStore(tempDir);
  mgr = new PendingConfirmationManager(store);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-pendingConfirm.test.ts' }); } catch { /* best */ }
});

function seedTentativeRef(topicId: number, refId: string, text: string): void {
  // Seed evidence to put the ref at tentative (~0.40)
  store.appendEvidence(topicId, refId, buildEvent(refId, 'extract-user', `seed-${refId}`), { text, kind: 'decision' });
}

describe('PendingConfirmationManager — outstanding + queue', () => {
  it('first create goes outstanding immediately', () => {
    seedTentativeRef(100, 'ref-A', 'use Path A OAuth');
    const r = mgr.create({
      topicId: 100, arcId: 'arc-1', refId: 'ref-A',
      propositionText: 'use Path A OAuth',
      questionText: 'Just confirming — Path A OAuth, right?',
      currentUserTurn: 5,
    });
    expect(r.status).toBe('outstanding');
    const file = store.load(100);
    expect(file.pending.outstanding?.refId).toBe('ref-A');
    expect(file.pending.outstanding?.status).toBe('pending');
    expect(file.telemetry.pending_confirm_created_total).toBe(1);
  });

  it('second create on different refId goes to queue', () => {
    seedTentativeRef(101, 'ref-A', 'A');
    seedTentativeRef(101, 'ref-B', 'B');
    mgr.create({ topicId: 101, arcId: 'arc-1', refId: 'ref-A', propositionText: 'A', questionText: 'q1', currentUserTurn: 5 });
    const r2 = mgr.create({ topicId: 101, arcId: 'arc-1', refId: 'ref-B', propositionText: 'B', questionText: 'q2', currentUserTurn: 5 });
    expect(r2.status).toBe('queued');
    const file = store.load(101);
    expect(file.pending.queue).toHaveLength(1);
    expect(file.pending.queue[0].refId).toBe('ref-B');
  });

  it('dedup: same refId outstanding → dropped-duplicate', () => {
    seedTentativeRef(102, 'ref-A', 'A');
    mgr.create({ topicId: 102, arcId: 'arc-1', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    const r2 = mgr.create({ topicId: 102, arcId: 'arc-1', refId: 'ref-A', propositionText: 'A', questionText: 'q again', currentUserTurn: 6 });
    expect(r2.status).toBe('dropped-duplicate');
  });

  it('dedup: same refId queued → dropped-duplicate', () => {
    seedTentativeRef(103, 'ref-A', 'A');
    seedTentativeRef(103, 'ref-B', 'B');
    mgr.create({ topicId: 103, arcId: 'arc-1', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    mgr.create({ topicId: 103, arcId: 'arc-1', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5 });
    const r3 = mgr.create({ topicId: 103, arcId: 'arc-1', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 6 });
    expect(r3.status).toBe('dropped-duplicate');
  });

  // ── Acceptance test 4 ──────────────────────────────────────────────────
  it('4th queued is silently dropped; telemetry increments (acceptance test 4)', () => {
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      seedTentativeRef(104, `ref-${id}`, id);
    }
    // 1st → outstanding, 2-4 → queue (depth 3), 5th → dropped
    const r1 = mgr.create({ topicId: 104, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    const r2 = mgr.create({ topicId: 104, arcId: 'arc', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5 });
    const r3 = mgr.create({ topicId: 104, arcId: 'arc', refId: 'ref-C', propositionText: 'C', questionText: 'q', currentUserTurn: 5 });
    const r4 = mgr.create({ topicId: 104, arcId: 'arc', refId: 'ref-D', propositionText: 'D', questionText: 'q', currentUserTurn: 5 });
    const r5 = mgr.create({ topicId: 104, arcId: 'arc', refId: 'ref-E', propositionText: 'E', questionText: 'q', currentUserTurn: 5 });

    expect(r1.status).toBe('outstanding');
    expect(r2.status).toBe('queued');
    expect(r3.status).toBe('queued');
    expect(r4.status).toBe('queued');
    expect(r5.status).toBe('dropped-queue-full');

    const file = store.load(104);
    expect(file.pending.queue).toHaveLength(3);
    expect(file.telemetry.pending_confirm_queue_dropped_total).toBe(1);
  });
});

describe('PendingConfirmationManager — answer interpretation', () => {
  it('positive answer emits pending-confirm-positive evidence and clears outstanding', () => {
    seedTentativeRef(200, 'ref-A', 'A');
    mgr.create({ topicId: 200, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    const out = mgr.interpretAnswer(200, 'positive', 'msg-answer-1');
    expect(out.applied).toBe(true);
    expect(out.outcome).toBe('positive');
    const file = store.load(200);
    expect(file.pending.outstanding).toBeNull();
    // Evidence event was appended
    const ref = file.refs['ref-A'];
    expect(ref.evidence.some(e => e.kind === 'pending-confirm-positive')).toBe(true);
    expect(file.telemetry.pending_confirm_answered_total['positive']).toBe(1);
    // Confidence jumped: 0.40 (extract-user) + 0.50 (pending-confirm-positive) = 0.90
    const proj = store.getProjection(200, 'ref-A');
    expect(proj!.confidence).toBeCloseTo(0.90);
    expect(proj!.tier).toBe('authoritative');
  });

  it('negative answer emits pending-confirm-negative evidence and clears outstanding', () => {
    seedTentativeRef(201, 'ref-A', 'A');
    mgr.create({ topicId: 201, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    const out = mgr.interpretAnswer(201, 'negative', 'msg-answer-2');
    expect(out.outcome).toBe('negative');
    const file = store.load(201);
    expect(file.pending.outstanding).toBeNull();
    const ref = file.refs['ref-A'];
    expect(ref.evidence.some(e => e.kind === 'pending-confirm-negative')).toBe(true);
    // Confidence: 0.40 + (-0.70) = -0.30 → clamped to 0.0
    const proj = store.getProjection(201, 'ref-A');
    expect(proj!.confidence).toBe(0);
  });

  // ── Acceptance test 5 ──────────────────────────────────────────────────
  it('ambiguous answer triggers sharpen-retry up to maxRetries, then abandons (acceptance test 5)', () => {
    seedTentativeRef(202, 'ref-A', 'A');
    mgr.create({ topicId: 202, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });

    // First ambiguous → retry 1
    const r1 = mgr.interpretAnswer(202, 'ambiguous', 'msg-ans-1');
    expect(r1.outcome).toBe('sharpen-retry');
    let file = store.load(202);
    expect(file.pending.outstanding?.retries).toBe(1);
    expect(file.pending.outstanding?.status).toBe('pending');

    // Second ambiguous → retry 2 (still pending)
    const r2 = mgr.interpretAnswer(202, 'ambiguous', 'msg-ans-2');
    expect(r2.outcome).toBe('sharpen-retry');
    file = store.load(202);
    expect(file.pending.outstanding?.retries).toBe(2);

    // Third ambiguous → abandon (retries == maxRetries)
    const r3 = mgr.interpretAnswer(202, 'ambiguous', 'msg-ans-3');
    expect(r3.outcome).toBe('abandoned');
    file = store.load(202);
    expect(file.pending.outstanding).toBeNull();
    expect(file.telemetry.pending_confirm_abandoned_total).toBe(1);
  });

  it('answering an outstanding promotes the next queued item, starting its TTL clock fresh', () => {
    seedTentativeRef(203, 'ref-A', 'A');
    seedTentativeRef(203, 'ref-B', 'B');
    mgr.create({ topicId: 203, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5, now: '2026-01-01T00:00:00.000Z' });
    mgr.create({ topicId: 203, arcId: 'arc', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5, now: '2026-01-01T00:01:00.000Z' });
    mgr.interpretAnswer(203, 'positive', 'msg-ans', '2026-01-01T00:05:00.000Z');
    const file = store.load(203);
    expect(file.pending.outstanding?.refId).toBe('ref-B');
    // TTL clock starts at dequeue time (the moment ref-A was answered)
    expect(file.pending.outstanding?.dequeuedAtTime).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('PendingConfirmationManager — TTL', () => {
  it('sweepTtl expires the outstanding after 5 user turns', () => {
    seedTentativeRef(300, 'ref-A', 'A');
    mgr.create({ topicId: 300, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 10 });
    const swept = mgr.sweepTtl(300, 15); // 5 turns later
    expect(swept).not.toBeNull();
    expect(swept!.status).toBe('expired');
    const file = store.load(300);
    expect(file.pending.outstanding).toBeNull();
    expect(file.telemetry.pending_confirm_expired_total).toBe(1);
  });

  it('sweepTtl expires the outstanding after 24h', () => {
    seedTentativeRef(301, 'ref-A', 'A');
    mgr.create({ topicId: 301, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5, now: '2026-01-01T00:00:00.000Z' });
    const swept = mgr.sweepTtl(301, 5, '2026-01-02T00:01:00.000Z'); // 24h+1m later
    expect(swept).not.toBeNull();
    expect(swept!.status).toBe('expired');
  });

  it('sweepTtl does NOT expire within window', () => {
    seedTentativeRef(302, 'ref-A', 'A');
    mgr.create({ topicId: 302, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 10, now: '2026-01-01T00:00:00.000Z' });
    const swept = mgr.sweepTtl(302, 13, '2026-01-01T12:00:00.000Z'); // 3 turns + 12h
    expect(swept).toBeNull();
  });
});

describe('PendingConfirmationManager — revalidation at dequeue', () => {
  it('drops queued items that became authoritative before dequeue', () => {
    seedTentativeRef(400, 'ref-A', 'A');
    seedTentativeRef(400, 'ref-B', 'B');
    mgr.create({ topicId: 400, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    mgr.create({ topicId: 400, arcId: 'arc', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5 });

    // Make ref-B authoritative by appending user-affirm
    store.appendEvidence(400, 'ref-B', buildEvent('ref-B', 'user-affirm', 'msg-promote-B'));
    const projB = store.getProjection(400, 'ref-B');
    expect(projB!.tier).toBe('authoritative');

    // Now answer the outstanding (ref-A); ref-B should be dequeued but
    // revalidation drops it because it's already authoritative
    mgr.interpretAnswer(400, 'positive', 'msg-ans-A');
    const file = store.load(400);
    expect(file.pending.outstanding).toBeNull();  // dropped, not promoted
    expect(file.pending.queue).toHaveLength(0);
  });
});
