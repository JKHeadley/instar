/**
 * Integration tests for topic-intent HTTP routes — Tier 2.
 *
 * Verifies the full pipeline:
 *   HTTP request → Express route → TopicIntentStore → response
 *
 * Covers:
 *   - Diagnostics endpoint returns 200 with projection + recent evidence + tier counts
 *   - Diagnostics endpoint does NOT leak raw message content (PII boundary)
 *   - 400 for invalid topicId
 *   - 503 stub when the store is disabled
 *   - /refs filtering by tier
 *   - /pending returns outstanding + queue
 *   - /telemetry returns counters
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import request from 'supertest';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';

let tempDir: string;
let store: TopicIntentStore;

function mountApp(s: TopicIntentStore | null) {
  const app = express();
  app.use(express.json());
  app.use(createTopicIntentRoutes({ topicIntentStore: s }));
  return app;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-routes-test-'));
  store = new TopicIntentStore(tempDir);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/integration/topic-intent-routes.test.ts' }); } catch { /* best */ }
});

describe('topic-intent routes — diagnostics', () => {
  it('returns 200 with projection + tier distribution + telemetry', async () => {
    // Seed three refs at different tiers
    store.appendEvidence(1000, 'ref-obs', buildEvent('ref-obs', 'agent-reref', 'msg-a'), { text: 'observation item', kind: 'fact' });
    store.appendEvidence(1000, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'msg-b'), { text: 'tentative item', kind: 'decision' });
    store.appendEvidence(1000, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'msg-c'), { text: 'authoritative item', kind: 'decision' });
    store.appendEvidence(1000, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'msg-d'));

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/1000/diagnostics');

    expect(res.status).toBe(200);
    expect(res.body.topicId).toBe(1000);
    expect(res.body.refs).toHaveLength(3);
    expect(res.body.tierDistribution).toEqual({
      observation: 1,
      tentative: 1,
      authoritative: 1,
    });
    expect(res.body.telemetry).toBeDefined();
    expect(res.body.telemetry.evidence_event_total['extract-user']).toBe(2);
    expect(res.body.pending.outstanding).toBeNull();
    expect(res.body.pending.queueDepth).toBe(0);
    expect(res.body.schemaVersion).toBe(1);
  });

  it('returns 400 for invalid topicId', async () => {
    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/not-a-number/diagnostics');
    expect(res.status).toBe(400);
  });

  it('returns 200 with empty projection for unknown topicId (no refs yet)', async () => {
    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/99999/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.refs).toEqual([]);
    expect(res.body.tierDistribution).toEqual({ observation: 0, tentative: 0, authoritative: 0 });
  });

  it('does NOT leak raw evidence event meta fields (PII boundary)', async () => {
    // Seed an event with an arbitrary meta field that should NOT appear
    const ev = buildEvent('ref-pii', 'sharpen-retry-issued', 'msg-x', {
      meta: {
        retry: 1,
        secret_user_message_content: 'PII LEAK CANDIDATE',
        api_key: 'sk-xxx',
      },
    });
    store.appendEvidence(2000, 'ref-pii', ev, { text: 'safe proposition', kind: 'fact' });

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/2000/diagnostics');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('PII LEAK CANDIDATE');
    expect(body).not.toContain('api_key');
    expect(body).not.toContain('sk-xxx');
    // Allowlist field IS present
    expect(res.body.refs[0].recentEvidence[0].meta).toEqual({ retry: 1 });
  });

  it('returns 503 stub when the store is disabled', async () => {
    const app = mountApp(null);
    const res = await request(app).get('/topic-intent/1/diagnostics');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disabled/);
  });
});

describe('topic-intent routes — /refs filter', () => {
  it('?tier=tentative returns tentative + authoritative', async () => {
    store.appendEvidence(3000, 'ref-obs', buildEvent('ref-obs', 'agent-reref', 'msg-a'));
    store.appendEvidence(3000, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'msg-b'), { text: 'T', kind: 'fact' });
    store.appendEvidence(3000, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'msg-c'), { text: 'A', kind: 'fact' });
    store.appendEvidence(3000, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'msg-d'));

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/3000/refs?tier=tentative');
    expect(res.status).toBe(200);
    expect(res.body.refs).toHaveLength(2);
  });

  it('?tier=authoritative returns only authoritative', async () => {
    store.appendEvidence(3001, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'msg-b'), { text: 'T', kind: 'fact' });
    store.appendEvidence(3001, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'msg-c'), { text: 'A', kind: 'fact' });
    store.appendEvidence(3001, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'msg-d'));

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/3001/refs?tier=authoritative');
    expect(res.status).toBe(200);
    expect(res.body.refs).toHaveLength(1);
    expect(res.body.refs[0].refId).toBe('ref-auth');
  });

  it('?tier=invalid returns 400', async () => {
    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/3002/refs?tier=bogus');
    expect(res.status).toBe(400);
  });
});

describe('topic-intent routes — /pending', () => {
  it('returns outstanding + queue', async () => {
    store.appendEvidence(4000, 'ref-A', buildEvent('ref-A', 'extract-user', 'msg-a'), { text: 'A', kind: 'decision' });
    store.appendEvidence(4000, 'ref-B', buildEvent('ref-B', 'extract-user', 'msg-b'), { text: 'B', kind: 'decision' });
    const mgr = new PendingConfirmationManager(store);
    mgr.create({ topicId: 4000, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    mgr.create({ topicId: 4000, arcId: 'arc', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5 });

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/4000/pending');
    expect(res.status).toBe(200);
    expect(res.body.outstanding?.refId).toBe('ref-A');
    expect(res.body.queue).toHaveLength(1);
    expect(res.body.queue[0].refId).toBe('ref-B');
  });
});

describe('topic-intent routes — /briefing (Layer 2)', () => {
  it('returns the rendered briefing as text/plain', async () => {
    store.appendEvidence(4500, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'm1'), { text: 'use Path A OAuth', kind: 'decision' });
    store.appendEvidence(4500, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'm2'));

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/4500/briefing');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('SETTLED');
    expect(res.text).toContain('use Path A OAuth');
  });

  it('returns 200 with empty body when nothing tracked yet (bootstrap hooks can skip cleanly)', async () => {
    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/4501/briefing');
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('returns 400 with empty body for invalid topicId', async () => {
    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/not-a-number/briefing');
    expect(res.status).toBe(400);
    expect(res.text).toBe('');
  });
});

describe('topic-intent routes — /telemetry', () => {
  it('returns counters', async () => {
    store.appendEvidence(5000, 'ref-A', buildEvent('ref-A', 'extract-user', 'msg-a'));
    store.appendEvidence(5000, 'ref-A', buildEvent('ref-A', 'user-affirm', 'msg-b'));

    const app = mountApp(store);
    const res = await request(app).get('/topic-intent/5000/telemetry');
    expect(res.status).toBe(200);
    expect(res.body.telemetry.evidence_event_total['extract-user']).toBe(1);
    expect(res.body.telemetry.evidence_event_total['user-affirm']).toBe(1);
  });
});
