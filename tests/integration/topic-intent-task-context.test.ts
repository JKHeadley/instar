/**
 * Integration tests (Tier 2) for rung-1 task-context capture.
 *
 * Full pipeline: captureTurn → store → HTTP routes.
 *   - A frame-stating turn creates a `method` ref; capture-metrics breaks it out
 *     by refkind.
 *   - The briefing endpoint renders the "ACTIVE TASK FRAME" block.
 *   - ArcCheck fires (signal) when a draft contradicts an authoritative frame —
 *     proving task-frame flows through the existing (kind-agnostic) ArcCheck path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import request from 'supertest';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, type ExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { captureTurn } from '../../src/core/TopicIntentCapture.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import type { ArcCheckClassifyFn } from '../../src/core/TopicIntentArcCheck.js';

let tempDir: string;
let store: TopicIntentStore;

function mountApp(s: TopicIntentStore, classify?: ArcCheckClassifyFn) {
  const app = express();
  app.use(express.json());
  app.use(createTopicIntentRoutes({ topicIntentStore: s, arcCheckClassify: classify }));
  return app;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-taskctx-int-'));
  store = new TopicIntentStore(tempDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/integration/topic-intent-task-context.test.ts' }); } catch { /* best */ }
});

describe('frame capture → metrics breakout', () => {
  it('a frame-stating turn creates a method ref and capture-metrics breaks it out by refkind', async () => {
    const TOPIC = 7001;
    const fn: ExtractFn = async () => [{ kind: 'new-ref', refId: null, propositionText: 'testing over Telegram', refKind: 'method' }];
    const extractor = new TopicIntentExtractor(store, fn);
    await captureTurn({ extractor, store, topicMemory: null }, { messageId: 's1', topicId: TOPIC, text: 'we are testing this over Telegram', fromUser: true });

    const m = await request(mountApp(store)).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.status).toBe(200);
    expect(m.body.funnel.refs_created).toBe(1);
    expect(m.body.funnel.refkind_created.method).toBe(1);
  });
});

describe('briefing renders the frame block over HTTP', () => {
  it('GET briefing shows the ACTIVE TASK FRAME block', async () => {
    const TOPIC = 7002;
    store.appendEvidence(TOPIC, 'r-m', buildEvent('r-m', 'extract-user', 'a1'), { text: 'testing over Telegram', kind: 'method' });
    store.appendEvidence(TOPIC, 'r-m', buildEvent('r-m', 'user-affirm', 'a2'));
    const res = await request(mountApp(store)).get(`/topic-intent/${TOPIC}/briefing`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('ACTIVE TASK FRAME');
    expect(res.text).toContain('[method] testing over Telegram');
  });
});

describe('ArcCheck fires on a frame contradiction (signal)', () => {
  it('a draft contradicting an authoritative method frame makes ArcCheck fire', async () => {
    const TOPIC = 7003;
    // Drive a method ref to authoritative with user evidence.
    store.appendEvidence(TOPIC, 'r-m', buildEvent('r-m', 'extract-user', 'a1'), { text: 'testing over Telegram', kind: 'method' });
    store.appendEvidence(TOPIC, 'r-m', buildEvent('r-m', 'user-affirm', 'a2'));
    store.appendEvidence(TOPIC, 'r-m', buildEvent('r-m', 'user-reref', 'a3'));

    // Classifier says the draft contradicts the method frame.
    const classify: ArcCheckClassifyFn = async (_draft, refs) => ({ actsOn: [], contradicts: refs.map(r => r.refId) });
    const res = await request(mountApp(store, classify))
      .post(`/topic-intent/${TOPIC}/arccheck`)
      .send({ draftText: 'let me just verify this by reading the code instead' });

    expect(res.status).toBe(200);
    expect(res.body.fire).toBe(true);
    expect(res.body.kind).toBe('contradicts-frame');
    expect(res.body.refText).toContain('testing over Telegram');

    // And the fire is metered.
    const m = await request(mountApp(store, classify)).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.body.funnel.arccheck_fired).toBeGreaterThanOrEqual(1);
  });
});
