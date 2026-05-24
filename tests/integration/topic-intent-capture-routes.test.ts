/**
 * Integration tests (Tier 2) for the capture-loop observability surface:
 *   GET  /topic-intent/:id/capture-metrics   — the whole-loop funnel (§10)
 *   GET  /topic-intent/:id/briefing          — increments briefing_served (+counts)
 *   POST /topic-intent/:id/arccheck          — increments arccheck_fired/signalled
 *
 * Full pipeline: HTTP request → Express route → TopicIntentStore (file-backed).
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

function mountApp(s: TopicIntentStore | null, arcCheckClassify?: ArcCheckClassifyFn | null) {
  const app = express();
  app.use(express.json());
  app.use(createTopicIntentRoutes({ topicIntentStore: s, arcCheckClassify }));
  return app;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-cap-routes-'));
  store = new TopicIntentStore(tempDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/integration/topic-intent-capture-routes.test.ts' }); } catch { /* best */ }
});

describe('GET /topic-intent/:id/capture-metrics', () => {
  it('is ALIVE (200, not 503) with a zeroed funnel on a fresh topic', async () => {
    const res = await request(mountApp(store)).get('/topic-intent/5000/capture-metrics');
    expect(res.status).toBe(200);
    expect(res.body.topicId).toBe(5000);
    expect(res.body.funnel).toMatchObject({
      turns_seen: 0,
      prefilter_skipped: 0,
      extractions_attempted: 0,
      refs_created: 0,
      degraded: { no_intelligence: 0, cap_or_error: 0, shed: 0 },
      briefing_served: 0,
      arccheck_fired: 0,
      arccheck_signalled: 0,
      refs_decayed: 0,
      last_capture_at: null,
    });
  });

  it('503 stub when the store is disabled', async () => {
    const res = await request(mountApp(null)).get('/topic-intent/5000/capture-metrics');
    expect(res.status).toBe(503);
  });

  it('reflects a real capture run through the funnel', async () => {
    const TOPIC = 5001;
    const fn: ExtractFn = async () => [{ kind: 'new-ref', refId: null, propositionText: 'use Path B', refKind: 'decision' }];
    const extractor = new TopicIntentExtractor(store, fn);
    // One substantive turn (captures) + one trivial (pre-filter skip).
    await captureTurn({ extractor, store, topicMemory: null }, { messageId: 's1', topicId: TOPIC, text: 'we will use Path B for routing', fromUser: true });
    await captureTurn({ extractor, store, topicMemory: null }, { messageId: 's2', topicId: TOPIC, text: 'ok', fromUser: true });

    const res = await request(mountApp(store)).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(res.status).toBe(200);
    expect(res.body.funnel.turns_seen).toBe(2);
    expect(res.body.funnel.prefilter_skipped).toBe(1);
    expect(res.body.funnel.extractions_attempted).toBe(1);
    expect(res.body.funnel.refs_created).toBe(1);
    expect(res.body.funnel.last_capture_at).toBeTruthy();
    expect(res.body.refsLive).toBe(1);
  });
});

describe('GET /topic-intent/:id/briefing increments briefing_served', () => {
  it('records the fetch + the refs it carried', async () => {
    const TOPIC = 5002;
    // A tentative ref (extract-user → 0.40) so the briefing carries something.
    store.appendEvidence(TOPIC, 'ref-1', buildEvent('ref-1', 'extract-user', 'm1'), { text: 'tentative decision', kind: 'decision' });

    const app = mountApp(store);
    const b1 = await request(app).get(`/topic-intent/${TOPIC}/briefing`);
    expect(b1.status).toBe(200);

    const m = await request(app).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.body.funnel.briefing_served).toBe(1);
    expect(m.body.funnel.briefing_refs.tentative).toBeGreaterThanOrEqual(1);

    // A second fetch increments again (cumulative).
    await request(app).get(`/topic-intent/${TOPIC}/briefing`);
    const m2 = await request(app).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m2.body.funnel.briefing_served).toBe(2);
  });
});

describe('POST /topic-intent/:id/arccheck increments arccheck_fired/signalled', () => {
  it('fired but NOT signalled when the draft engages nothing', async () => {
    const TOPIC = 5003;
    store.appendEvidence(TOPIC, 'ref-1', buildEvent('ref-1', 'extract-user', 'm1'), { text: 'use Path B', kind: 'decision' });
    const classify: ArcCheckClassifyFn = async () => ({ actsOn: [], contradicts: [] });
    const app = mountApp(store, classify);

    const res = await request(app).post(`/topic-intent/${TOPIC}/arccheck`).send({ draftText: 'unrelated draft' });
    expect(res.status).toBe(200);
    expect(res.body.fire).toBe(false);

    const m = await request(app).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.body.funnel.arccheck_fired).toBe(1);
    expect(m.body.funnel.arccheck_signalled).toBe(0);
  });

  it('fired AND signalled when the draft acts on a tentative ref', async () => {
    const TOPIC = 5004;
    store.appendEvidence(TOPIC, 'ref-1', buildEvent('ref-1', 'extract-user', 'm1'), { text: 'use Path B', kind: 'decision' });
    const classify: ArcCheckClassifyFn = async (_draft, refs) => ({ actsOn: refs.map(r => r.refId), contradicts: [] });
    const app = mountApp(store, classify);

    const res = await request(app).post(`/topic-intent/${TOPIC}/arccheck`).send({ draftText: 'going ahead with Path B' });
    expect(res.body.fire).toBe(true);

    const m = await request(app).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.body.funnel.arccheck_fired).toBe(1);
    expect(m.body.funnel.arccheck_signalled).toBe(1);
  });
});
